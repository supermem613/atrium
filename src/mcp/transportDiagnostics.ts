import { writeSync } from "node:fs";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type DiagnosticSink = (line: string) => void;
export type TransportDiagnosticsTransport = Pick<Transport, "onclose" | "onerror">;

export interface ProcessCrashHandlers {
  sink: DiagnosticSink;
  exit: (code: number) => void;
  fallbackSink?: DiagnosticSink;
}

let activeCrashHandlers: ProcessCrashHandlers | undefined;
let crashHandlersRegistered = false;

const MAX_DIAGNOSTIC_DETAIL_LENGTH = 500;

function describeError(reason: unknown): string {
  let raw: string;
  try {
    raw = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  } catch {
    // A crash handler must never throw. A reason with a throwing toString or message getter would otherwise escape and, on the unhandledRejection path, escalate into a fatal uncaughtException.
    raw = "[unprintable reason]";
  }
  // Diagnostics are single-line stderr evidence, so collapse every control character to a space and bound the length to keep one crash from flooding the operator log.
  const collapsed = raw.replace(/\p{Cc}+/gu, " ");
  return collapsed.length > MAX_DIAGNOSTIC_DETAIL_LENGTH ? `${collapsed.slice(0, MAX_DIAGNOSTIC_DETAIL_LENGTH)}...` : collapsed;
}

function createDiagnosticLine(code: string, detail: string): string {
  return `${new Date().toISOString()} ${code} ${detail}`;
}

function emitDiagnosticWithFallback(sink: DiagnosticSink, fallbackSink: DiagnosticSink, line: string): void {
  try {
    sink(line);
  } catch {
    fallbackSink(line);
  }
}

export function registerTransportDiagnostics(
  transport: TransportDiagnosticsTransport,
  sink: DiagnosticSink,
  fallbackSink: DiagnosticSink = defaultStderrSink,
): void {
  const previousOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      emitDiagnosticWithFallback(sink, fallbackSink, createDiagnosticLine("ATRIUM_TRANSPORT_CLOSE", "transport closed"));
    } finally {
      previousOnClose?.();
    }
  };

  const previousOnError = transport.onerror;
  transport.onerror = (error: Error) => {
    try {
      emitDiagnosticWithFallback(sink, fallbackSink, createDiagnosticLine("ATRIUM_TRANSPORT_ERROR", describeError(error)));
    } finally {
      previousOnError?.(error);
    }
  };
}

export function registerProcessCrashHandlers({ sink, exit, fallbackSink }: ProcessCrashHandlers): void {
  activeCrashHandlers = { sink, exit, fallbackSink };

  if (crashHandlersRegistered) {
    return;
  }

  const handleCrash = (reason: unknown, origin: string) => {
    const currentHandlers = activeCrashHandlers;
    if (currentHandlers === undefined) {
      return;
    }

    const currentFallbackSink = currentHandlers.fallbackSink ?? defaultStderrSink;

    try {
      // Keep crash evidence off stdout because stdout is reserved for MCP JSON-RPC. A fatal uncaughtException exits right after this, so the host must receive the line first. A recoverable unhandledRejection is logged here without exiting.
      emitDiagnosticWithFallback(currentHandlers.sink, currentFallbackSink, createDiagnosticLine("ATRIUM_SERVER_CRASH", `${origin} ${describeError(reason)}`));
    } finally {
      if (origin === "uncaughtException") {
        currentHandlers.exit(1);
      }
    }
  };

  process.on("uncaughtException", (err) => handleCrash(err, "uncaughtException"));
  process.on("unhandledRejection", (reason) => handleCrash(reason, "unhandledRejection"));
  crashHandlersRegistered = true;
}

export function defaultStderrSink(line: string): void {
  writeSync(2, `${line}\n`);
}
