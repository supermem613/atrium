import { Readable, Writable } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  FrameEnvelope,
  frameTooLargeResponse,
  type FrameFault,
  type FrameResult,
} from "./frameEnvelope.js";

interface WriteAdmission {
  message: JSONRPCMessage;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingWrite {
  resolve: () => void;
  reject: (error: Error) => void;
  writeReturned: boolean;
  callbackDone: boolean;
  drainRequired: boolean;
  drainDone: boolean;
  settled: boolean;
}

interface PendingInput {
  chunk: Uint8Array;
  offset: number;
}

export interface RecoveringStdioTransportOptions {
  maxFrameBytes?: number;
}

const ALREADY_STARTED_MESSAGE =
  "StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.";

export class RecoveringStdioTransport implements Transport {
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly envelope: FrameEnvelope;
  private readonly admissions: WriteAdmission[] = [];
  private readonly pendingWrites = new Set<PendingWrite>();
  private readonly inFlightWrites = new Set<PendingWrite>();
  private pendingInput?: PendingInput;
  private blockedWrite?: PendingWrite;
  private started = false;
  private closing = false;
  private closed = false;
  private outputBlocked = false;
  private outputClosed = false;
  private outputErrorObserved = false;
  private awaitingDeferredOutputError = false;
  private terminalErrorReported = false;
  private closeNotified = false;
  private processingInput = false;
  private inputContinuation?: NodeJS.Immediate;
  private inputEnded = false;
  private outputListenersAttached = false;

  readonly onData = (chunk: Buffer | string): void => {
    if (this.closed || this.closing) {
      return;
    }
    if (this.pendingInput !== undefined) {
      this.handleTerminal(new Error("stdio input delivered data while transport backpressure was active"));
      return;
    }
    this.pendingInput = {
      chunk: typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      offset: 0,
    };
    this.stdin.pause();
    this.processPendingInput();
  };

  readonly onInputError = (error: Error): void => {
    this.handleTerminal(error);
  };

  readonly onInputEnd = (): void => {
    this.inputEnded = true;
    if (this.pendingInput === undefined) {
      this.handleTerminal(undefined, new Error("stdio input ended"));
    }
  };

  readonly onInputClose = (): void => {
    if (!this.inputEnded || this.pendingInput === undefined) {
      this.handleTerminal(undefined, new Error("stdio input closed"));
    }
  };

  readonly onOutputError = (error: Error): void => {
    this.outputErrorObserved = true;
    this.awaitingDeferredOutputError = false;
    this.handleTerminal(error);
    this.cleanupOutputListeners();
  };

  readonly onOutputClose = (): void => {
    this.outputClosed = true;
    this.awaitingDeferredOutputError = false;
    this.handleTerminal(undefined, new Error("stdio output closed"));
    this.cleanupOutputListeners();
  };

  private readonly onDrain = (): void => {
    if (!this.outputBlocked) {
      return;
    }
    this.outputBlocked = false;
    const blocked = this.blockedWrite;
    this.blockedWrite = undefined;
    if (blocked !== undefined) {
      blocked.drainDone = true;
      this.settleWriteIfComplete(blocked);
    }
    if (this.closed || this.closing) {
      return;
    }
    this.pumpAdmissions();
    if (!this.outputBlocked) {
      this.processPendingInput();
      if (!this.outputBlocked && this.pendingInput === undefined) {
        this.stdin.resume();
      }
    }
  };

  constructor(
    stdin: Readable = process.stdin,
    stdout: Writable = process.stdout,
    options: RecoveringStdioTransportOptions = {},
  ) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.envelope = new FrameEnvelope({
      maxFrameBytes: options.maxFrameBytes,
      onFrame: (result) => this.handleFrame(result),
    });
  }

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(ALREADY_STARTED_MESSAGE);
    }
    if (this.closed || this.closing) {
      throw new Error("stdio transport is closed");
    }
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onInputError);
    this.stdin.on("end", this.onInputEnd);
    this.stdin.on("close", this.onInputClose);
    this.attachOutputListeners();
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed || this.closing) {
      return Promise.reject(new Error("stdio transport is closed"));
    }
    return new Promise<void>((resolve, reject) => {
      this.admissions.push({ message, resolve, reject });
      this.pumpAdmissions();
    });
  }

  async close(): Promise<void> {
    this.handleTerminal(undefined, new Error("stdio transport closed"));
  }

  get stats() {
    return this.envelope.stats;
  }

  private handleFrame(result: FrameResult): boolean {
    if (result.kind === "message") {
      this.onmessage?.(result.message);
      return !this.closed && !this.closing && !this.outputBlocked;
    }
    this.reportFrameFault(result);
    if (result.kind === "oversized" && result.requestId !== undefined && !this.closed && !this.closing) {
      const response = frameTooLargeResponse(result.requestId);
      void this.send(response).catch((error: unknown) => {
        if (!this.closed && !this.closing) {
          this.handleTerminal(error instanceof Error ? error : new Error("stdio response write failed"));
        }
      });
    }
    return !this.closed && !this.closing && !this.outputBlocked;
  }

  private reportFrameFault(fault: FrameFault): void {
    this.notifyError(new Error(`${fault.code}: ${fault.diagnostic}`));
  }

  private processPendingInput(): void {
    if (
      this.processingInput
      || this.inputContinuation !== undefined
      || this.pendingInput === undefined
      || this.outputBlocked
      || this.closed
      || this.closing
    ) {
      return;
    }
    this.processingInput = true;
    try {
      const pending = this.pendingInput;
      // The stream highWaterMark is Node's existing byte-admission budget.
      const end = Math.min(pending.chunk.length, pending.offset + Math.max(1, this.stdin.readableHighWaterMark));
      pending.offset = this.envelope.push(pending.chunk, pending.offset, end);
      if (pending.offset >= pending.chunk.length) {
        this.pendingInput = undefined;
      }
      if (!this.closed && !this.closing && !this.outputBlocked) {
        if (this.pendingInput !== undefined) {
          this.inputContinuation = setImmediate(() => {
            this.inputContinuation = undefined;
            this.processPendingInput();
          });
        } else if (this.inputEnded) {
          this.handleTerminal(undefined, new Error("stdio input ended"));
        } else {
          this.stdin.resume();
        }
      }
    } catch (error) {
      this.handleTerminal(error instanceof Error ? error : new Error("stdio input processing failed"));
    } finally {
      this.processingInput = false;
    }
  }

  private pumpAdmissions(): void {
    while (
      !this.outputBlocked
      && !this.closed
      && !this.closing
      && this.admissions.length > 0
    ) {
      const admission = this.admissions.shift();
      if (admission === undefined) {
        return;
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(serializeMessage(admission.message), "utf8");
      } catch (error) {
        admission.reject(error instanceof Error ? error : new Error("stdio response serialization failed"));
        continue;
      }

      const write: PendingWrite = {
        resolve: admission.resolve,
        reject: admission.reject,
        writeReturned: false,
        callbackDone: false,
        drainRequired: false,
        drainDone: false,
        settled: false,
      };
      this.pendingWrites.add(write);
      this.inFlightWrites.add(write);
      let accepted: boolean;
      try {
        accepted = this.stdout.write(buffer, (error?: Error | null) => {
          this.completeWriteCallback(write, error ?? undefined);
        });
      } catch (error) {
        write.writeReturned = true;
        this.completeWriteCallback(
          write,
          error instanceof Error ? error : new Error("stdio response write failed"),
        );
        return;
      }
      write.writeReturned = true;
      write.drainRequired = !accepted;
      write.drainDone = accepted;
      if (!accepted && !this.closed && !this.closing) {
        this.outputBlocked = true;
        this.blockedWrite = write;
        this.stdin.pause();
      }
      this.settleWriteIfComplete(write);
    }
  }

  private completeWriteCallback(write: PendingWrite, error?: Error): void {
    if (write.callbackDone) {
      return;
    }
    write.callbackDone = true;
    this.inFlightWrites.delete(write);
    if (error !== undefined) {
      if (!this.outputErrorObserved && this.stdout.errored !== null && !this.stdout.closed) {
        this.awaitingDeferredOutputError = true;
      }
      this.rejectWrite(write, error);
      this.handleTerminal(error);
      this.cleanupOutputListeners();
      return;
    }
    this.settleWriteIfComplete(write);
    this.cleanupOutputListeners();
  }

  private settleWriteIfComplete(write: PendingWrite): void {
    if (
      write.settled
      || !write.writeReturned
      || !write.callbackDone
      || (write.drainRequired && !write.drainDone)
    ) {
      return;
    }
    write.settled = true;
    this.pendingWrites.delete(write);
    write.resolve();
  }

  private rejectWrite(write: PendingWrite, error: Error): void {
    if (write.settled) {
      return;
    }
    write.settled = true;
    this.pendingWrites.delete(write);
    write.reject(error);
  }

  private handleTerminal(error?: Error, settlementError = error ?? new Error("stdio transport closed")): void {
    if (this.closed || this.closing) {
      if (error !== undefined && !this.terminalErrorReported) {
        this.terminalErrorReported = true;
        this.notifyError(error);
      }
      return;
    }
    this.closing = true;
    try {
      if (error !== undefined) {
        this.terminalErrorReported = true;
        this.notifyError(error);
      }
    } finally {
      this.closed = true;
      if (this.inputContinuation !== undefined) {
        clearImmediate(this.inputContinuation);
        this.inputContinuation = undefined;
      }
      this.removeInputListeners();
      this.stdout.removeListener("drain", this.onDrain);
      this.outputBlocked = false;
      this.blockedWrite = undefined;
      try {
        this.envelope.end();
      } finally {
        this.pendingInput = undefined;
        this.settlePendingSends(settlementError);
        try {
          this.notifyClose();
        } finally {
          this.closing = false;
          this.cleanupOutputListeners();
        }
      }
    }
  }

  private settlePendingSends(error: Error): void {
    for (const write of this.pendingWrites) {
      this.rejectWrite(write, error);
    }
    while (this.admissions.length > 0) {
      this.admissions.shift()?.reject(error);
    }
  }

  private removeInputListeners(): void {
    this.stdin.removeListener("data", this.onData);
    this.stdin.removeListener("error", this.onInputError);
    this.stdin.removeListener("end", this.onInputEnd);
    this.stdin.removeListener("close", this.onInputClose);
  }

  private attachOutputListeners(): void {
    if (this.outputListenersAttached) {
      return;
    }
    this.outputListenersAttached = true;
    this.stdout.on("error", this.onOutputError);
    this.stdout.on("close", this.onOutputClose);
    this.stdout.on("drain", this.onDrain);
  }

  private cleanupOutputListeners(): void {
    if (
      !this.outputListenersAttached
      || (!this.outputClosed
        && (!this.closed || this.inFlightWrites.size > 0 || this.awaitingDeferredOutputError))
    ) {
      return;
    }
    this.stdout.removeListener("error", this.onOutputError);
    this.stdout.removeListener("close", this.onOutputClose);
    this.stdout.removeListener("drain", this.onDrain);
    this.outputListenersAttached = false;
  }

  private notifyError(error: Error): void {
    this.onerror?.(error);
  }

  private notifyClose(): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.onclose?.();
  }
}
