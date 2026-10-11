import { deserializeMessage, serializeMessage, STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { ErrorCode, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { getManyValues, isMany, none, type Many } from "stream-chain/defs.js";
import { getDefaultHighWaterMark } from "node:stream";
import { jsonParser, type ParserOptions, type Token } from "stream-json/core/parser.js";

// stream-json 3.7 exports this synchronous factory but omits it from its declarations.
declare module "stream-json/core/parser.js" {
  export function jsonParser(options?: ParserOptions): (value: string | typeof none) => Many<Token> | typeof none;
}

export const DEFAULT_FRAME_BYTES = STDIO_DEFAULT_MAX_BUFFER_SIZE;
const JSONRPC_VERSION = "2.0";
const MAX_TRACKED_ROOT_KEY_LENGTH = "jsonrpc".length;

export function frameTooLargeResponse(id: RequestId): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: ErrorCode.InvalidRequest,
      message: "Invalid request",
      data: { code: "FrameTooLarge" },
    },
  };
}

function supportsRecoveryId(id: RequestId): boolean {
  // The correlated rejection must also fit the unmodified SDK client's wire budget.
  return Buffer.byteLength(serializeMessage(frameTooLargeResponse(id))) <= DEFAULT_FRAME_BYTES;
}

type RootField = "jsonrpc" | "method" | "id";
type ParserOutput = Token | Many<Token> | typeof none;
type StreamingParser = (value: string | typeof none) => ParserOutput;

class BoundedStringValue {
  private buffer?: Buffer;
  private usedBytes = 0;
  private overflowed = false;

  constructor(private readonly maxBytes: number) {}

  append(value: string): void {
    if (this.overflowed || value.length === 0) {
      return;
    }
    // JSON ids can contain lone surrogates. Preserve code units across token splits.
    const encoded = Buffer.from(value, "utf16le");
    const required = this.usedBytes + encoded.length;
    if (required > this.maxBytes) {
      this.buffer = undefined;
      this.usedBytes = 0;
      this.overflowed = true;
      return;
    }
    encoded.copy(this.ensureCapacity(required), this.usedBytes);
    this.usedBytes = required;
  }

  get retainedBytes(): number {
    return this.buffer?.length ?? 0;
  }

  get isOverflowed(): boolean {
    return this.overflowed;
  }

  toString(): string {
    return this.buffer?.toString("utf16le", 0, this.usedBytes) ?? "";
  }

  private ensureCapacity(required: number): Buffer {
    const current = this.buffer?.length ?? 0;
    if (required <= current && this.buffer !== undefined) {
      return this.buffer;
    }
    const capacity = current === 0
      ? required
      : Math.min(this.maxBytes, Math.max(required, current * 2));
    const replacement = Buffer.allocUnsafe(capacity);
    this.buffer?.copy(replacement, 0, 0, this.usedBytes);
    this.buffer = replacement;
    return replacement;
  }
}

type CapturedValue =
  | { kind: "string"; bytes: BoundedStringValue }
  | { kind: "number"; bytes: BoundedStringValue }
  | { kind: "boolean" | "null" | "complex" };

interface FrameMetadata {
  jsonrpc?: CapturedValue;
  method?: CapturedValue;
  id?: CapturedValue;
}

interface ActiveScalar {
  field: RootField;
  kind: "string" | "number";
  bytes?: BoundedStringValue;
}

export interface FrameMessage {
  kind: "message";
  message: JSONRPCMessage;
}

export interface FrameFault {
  kind: "malformed" | "oversized";
  code: "MalformedFrame" | "FrameTooLarge";
  diagnostic: string;
  requestId?: RequestId;
}

export type FrameResult = FrameMessage | FrameFault;

export interface FrameEnvelopeStats {
  currentFrameBytes: number;
  currentRetainedBytes: number;
  currentMetadataBytes: number;
  peakRetainedBytes: number;
  peakMetadataBytes: number;
  peakStructuralDepth: number;
}

export interface FrameEnvelopeOptions {
  maxFrameBytes?: number;
  onFrame?: (result: FrameResult) => boolean | void;
}

function rootField(key: string | undefined, tooLong: boolean): RootField | undefined {
  if (tooLong || key === undefined) {
    return undefined;
  }
  return key === "jsonrpc" || key === "method" || key === "id" ? key : undefined;
}

class FrameScanner {
  private parser?: StreamingParser;
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private readonly metadata: FrameMetadata = {};
  private activeScalar?: ActiveScalar;
  private rootKey = "";
  private rootKeyTooLong = false;
  private pendingRootField?: RootField;
  private depth = 0;
  private rootIsObject = false;
  private readingRootKey = false;
  private invalid = false;
  private diagnostic = "malformed JSON-RPC frame";
  private currentMetadataBytes = 0;
  private peakMetadataBytes = 0;
  private peakStructuralDepth = 0;

  constructor(private readonly maxFrameBytes: number) {
    this.parser = jsonParser({
      packStrings: false,
      packKeys: false,
      packNumbers: false,
      streamStrings: true,
      streamKeys: true,
      streamNumbers: true,
      jsonStreaming: false,
    });
  }

  feed(bytes: Uint8Array): void {
    if (this.invalid || bytes.length === 0) {
      return;
    }
    // Bound each tokenizer result batch by Node's existing byte-stream admission size.
    const batchBytes = Math.min(this.maxFrameBytes, getDefaultHighWaterMark(false));
    for (let offset = 0; offset < bytes.length && !this.invalid; offset += batchBytes) {
      this.feedText(this.decoder.decode(bytes.subarray(offset, offset + batchBytes), { stream: true }));
    }
  }

  finish(): void {
    if (this.invalid) {
      return;
    }
    this.feedText(this.decoder.decode());
    if (this.invalid) {
      return;
    }
    try {
      if (this.parser !== undefined) {
        this.consumeOutput(this.parser(none));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  get isValid(): boolean {
    return !this.invalid;
  }

  get recoveryId(): RequestId | undefined {
    if (!this.isValid || !this.isRequestEnvelope()) {
      return undefined;
    }
    const id = this.metadata.id;
    if (id?.kind === "string" && !id.bytes.isOverflowed) {
      const value = id.bytes.toString();
      return supportsRecoveryId(value) ? value : undefined;
    }
    if (id?.kind === "number" && !id.bytes.isOverflowed) {
      const value = Number(id.bytes.toString());
      return Number.isSafeInteger(value) && supportsRecoveryId(value) ? value : undefined;
    }
    return undefined;
  }

  get stats(): Pick<FrameEnvelopeStats, "currentMetadataBytes" | "peakMetadataBytes" | "peakStructuralDepth"> {
    return {
      currentMetadataBytes: this.currentMetadataBytes,
      peakMetadataBytes: this.peakMetadataBytes,
      peakStructuralDepth: this.peakStructuralDepth,
    };
  }

  get error(): string {
    return this.diagnostic;
  }

  private feedText(text: string): void {
    if (this.invalid || text.length === 0) {
      return;
    }
    try {
      if (this.parser !== undefined) {
        this.consumeOutput(this.parser(text));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private consumeOutput(output: ParserOutput): void {
    if (output === none) {
      return;
    }
    const tokens = isMany(output) ? getManyValues(output) : [output];
    for (const token of tokens) {
      if (this.invalid) {
        break;
      }
      this.consumeToken(token);
    }
  }

  private consumeToken(token: Token): void {
    switch (token.name) {
      case "startObject":
        if (!this.admitContainer()) {
          return;
        }
        if (this.depth === 0) {
          this.rootIsObject = true;
        } else if (this.depth === 1 && this.rootIsObject) {
          this.recordComplexValue();
        }
        this.depth += 1;
        this.peakStructuralDepth = Math.max(this.peakStructuralDepth, this.depth);
        return;
      case "endObject":
        this.depth -= 1;
        return;
      case "startArray":
        if (!this.admitContainer()) {
          return;
        }
        if (this.depth === 1 && this.rootIsObject) {
          this.recordComplexValue();
        }
        this.depth += 1;
        this.peakStructuralDepth = Math.max(this.peakStructuralDepth, this.depth);
        return;
      case "endArray":
        this.depth -= 1;
        return;
      case "startKey":
        if (this.rootIsObject && this.depth === 1) {
          this.readingRootKey = true;
          this.rootKey = "";
          this.rootKeyTooLong = false;
        }
        return;
      case "endKey":
        if (this.readingRootKey) {
          this.readingRootKey = false;
          this.pendingRootField = rootField(this.rootKey, this.rootKeyTooLong);
        }
        return;
      case "startString":
        this.beginScalar("string");
        return;
      case "endString":
        this.finishScalar("string");
        return;
      case "startNumber":
        this.beginScalar("number");
        return;
      case "endNumber":
        this.finishScalar("number");
        return;
      case "stringChunk":
        if (this.readingRootKey) {
          this.appendRootKey(token.value);
        } else {
          this.appendScalar(token.value);
        }
        return;
      case "numberChunk":
        this.appendScalar(token.value);
        return;
      case "nullValue":
        this.recordPrimitiveValue({ kind: "null" });
        return;
      case "trueValue":
      case "falseValue":
        this.recordPrimitiveValue({ kind: "boolean" });
        return;
      case "keyValue":
      case "stringValue":
      case "numberValue":
      case "whitespace":
        return;
    }
  }

  private appendRootKey(value: string): void {
    if (this.rootKeyTooLong) {
      return;
    }

    if (this.rootKey.length + value.length > MAX_TRACKED_ROOT_KEY_LENGTH) {
      this.rootKeyTooLong = true;
      this.rootKey = "";
      return;
    }
    this.rootKey += value;
  }

  private admitContainer(): boolean {
    // Every admitted JSON container needs both an opening and closing byte.
    if (this.depth >= Math.floor(this.maxFrameBytes / 2)) {
      this.fail(new Error("JSON nesting exceeds the admitted frame's structural budget"));
      return false;
    }
    return true;
  }

  private beginScalar(kind: ActiveScalar["kind"]): void {
    if (!this.rootIsObject || this.depth !== 1 || this.pendingRootField === undefined) {
      return;
    }
    const field = this.pendingRootField;
    this.pendingRootField = undefined;
    this.releaseField(field);
    const retainValue = field !== "method";
    this.activeScalar = {
      field,
      kind,
      ...(retainValue
        // A decoded UTF-16 code unit needs at most twice its encoded JSON byte budget.
        ? { bytes: new BoundedStringValue(2 * (field === "jsonrpc" ? JSONRPC_VERSION.length : this.maxFrameBytes)) }
        : {}),
    };
    this.updateMetadataBytes();
  }

  private appendScalar(value: string): void {
    this.activeScalar?.bytes?.append(value);
    this.updateMetadataBytes();
  }

  private finishScalar(kind: ActiveScalar["kind"]): void {
    const active = this.activeScalar;
    if (active === undefined || active.kind !== kind) {
      return;
    }
    this.activeScalar = undefined;
    this.metadata[active.field] = {
      kind,
      bytes: active.bytes ?? new BoundedStringValue(0),
    };
    this.updateMetadataBytes();
  }

  private recordPrimitiveValue(value: CapturedValue): void {
    if (!this.rootIsObject || this.depth !== 1 || this.pendingRootField === undefined) {
      return;
    }
    const field = this.pendingRootField;
    this.pendingRootField = undefined;
    this.releaseField(field);
    this.metadata[field] = value;
    this.updateMetadataBytes();
  }

  private recordComplexValue(): void {
    if (this.pendingRootField === undefined) {
      return;
    }
    const field = this.pendingRootField;
    this.pendingRootField = undefined;
    this.releaseField(field);
    this.metadata[field] = { kind: "complex" };
    this.updateMetadataBytes();
  }

  private releaseField(field: RootField): void {
    delete this.metadata[field];
    this.updateMetadataBytes();
  }

  private updateMetadataBytes(): void {
    const fieldBytes = (value: CapturedValue | undefined): number =>
      value?.kind === "string" || value?.kind === "number" ? value.bytes.retainedBytes : 0;
    this.currentMetadataBytes =
      fieldBytes(this.metadata.jsonrpc)
      + fieldBytes(this.metadata.id)
      + (this.activeScalar?.bytes?.retainedBytes ?? 0);
    this.peakMetadataBytes = Math.max(this.peakMetadataBytes, this.currentMetadataBytes);
  }

  private isRequestEnvelope(): boolean {
    const version = this.metadata.jsonrpc;
    return version?.kind === "string"
      && !version.bytes.isOverflowed
      && version.bytes.toString() === JSONRPC_VERSION
      && this.metadata.method?.kind === "string";
  }

  private fail(error: unknown): void {
    this.invalid = true;
    this.parser = undefined;
    this.diagnostic = error instanceof Error ? error.message : "invalid JSON";
  }
}

export class FrameEnvelope {
  private readonly maxFrameBytes: number;
  private readonly onFrame?: (result: FrameResult) => boolean | void;
  private frameBytes = 0;
  private retainedLength = 0;
  private retained?: Buffer;
  private scanner: FrameScanner;
  private ended = false;
  private peakRetainedBytes = 0;
  private peakMetadataBytes = 0;
  private peakStructuralDepth = 0;

  constructor(options: FrameEnvelopeOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new Error("maxFrameBytes must be a positive safe integer");
    }
    this.onFrame = options.onFrame;
    this.scanner = new FrameScanner(this.maxFrameBytes);
  }

  push(chunk: Uint8Array, start = 0, end = chunk.length): number {
    if (this.ended) {
      throw new Error("Frame envelope is ended");
    }
    let segmentStart = start;
    for (let index = start; index < end; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }
      this.pushSegment(chunk.subarray(segmentStart, index));
      const shouldContinue = this.finishFrame();
      segmentStart = index + 1;
      if (!shouldContinue) {
        return segmentStart;
      }
    }
    this.pushSegment(chunk.subarray(segmentStart, end));
    return end;
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.frameBytes !== 0) {
      this.emit({
        kind: "malformed",
        code: "MalformedFrame",
        diagnostic: "stdin ended before the JSON-RPC frame delimiter",
      });
      this.resetFrame();
    }
  }

  get stats(): FrameEnvelopeStats {
    const scannerStats = this.scanner.stats;
    return {
      currentFrameBytes: this.frameBytes,
      currentRetainedBytes: this.retained?.length ?? 0,
      currentMetadataBytes: scannerStats.currentMetadataBytes,
      peakRetainedBytes: this.peakRetainedBytes,
      peakMetadataBytes: Math.max(this.peakMetadataBytes, scannerStats.peakMetadataBytes),
      peakStructuralDepth: Math.max(this.peakStructuralDepth, scannerStats.peakStructuralDepth),
    };
  }

  private pushSegment(segment: Uint8Array): void {
    if (segment.length === 0) {
      return;
    }
    this.frameBytes += segment.length;
    const retainedBytes = Math.min(segment.length, this.maxFrameBytes - this.retainedLength);
    if (retainedBytes > 0) {
      this.ensureRetainedCapacity(this.retainedLength + retainedBytes);
      this.retained?.set(segment.subarray(0, retainedBytes), this.retainedLength);
      this.retainedLength += retainedBytes;
    }
    if (this.frameBytes > this.maxFrameBytes) {
      this.retained = undefined;
      this.retainedLength = this.maxFrameBytes;
    }
    this.scanner.feed(segment);
  }

  private ensureRetainedCapacity(required: number): void {
    const current = this.retained?.length ?? 0;
    if (required <= current) {
      return;
    }
    const capacity = current === 0
      ? required
      : Math.min(this.maxFrameBytes, Math.max(required, current * 2));
    const replacement = Buffer.allocUnsafe(capacity);
    this.retained?.copy(replacement, 0, 0, this.retainedLength);
    this.retained = replacement;
    this.peakRetainedBytes = Math.max(this.peakRetainedBytes, capacity);
  }

  private finishFrame(): boolean {
    this.scanner.finish();
    const scannerStats = this.scanner.stats;
    this.peakMetadataBytes = Math.max(this.peakMetadataBytes, scannerStats.peakMetadataBytes);
    this.peakStructuralDepth = Math.max(this.peakStructuralDepth, scannerStats.peakStructuralDepth);

    let result: FrameResult;
    if (this.frameBytes > this.maxFrameBytes) {
      const requestId = this.scanner.recoveryId;
      result = requestId === undefined
        ? {
          kind: "oversized",
          code: "FrameTooLarge",
          diagnostic: this.scanner.isValid
            ? `JSON-RPC frame exceeded the ${this.maxFrameBytes}-byte stdio frame budget without a supported request id`
            : `${this.scanner.error}; JSON-RPC frame exceeded the ${this.maxFrameBytes}-byte stdio frame budget`,
        }
        : {
          kind: "oversized",
          code: "FrameTooLarge",
          diagnostic: `JSON-RPC frame exceeded the ${this.maxFrameBytes}-byte stdio frame budget`,
          requestId,
        };
    } else if (!this.scanner.isValid) {
      result = {
        kind: "malformed",
        code: "MalformedFrame",
        diagnostic: this.scanner.error,
      };
    } else {
      const line = this.retained?.toString("utf8", 0, this.retainedLength).replace(/\r$/, "") ?? "";
      try {
        result = { kind: "message", message: deserializeMessage(line) };
      } catch (error) {
        result = {
          kind: "malformed",
          code: "MalformedFrame",
          diagnostic: error instanceof Error ? error.message : "invalid JSON-RPC message",
        };
      }
    }

    this.resetFrame();
    return this.emit(result);
  }

  private emit(result: FrameResult): boolean {
    return this.onFrame?.(result) !== false;
  }

  private resetFrame(): void {
    this.frameBytes = 0;
    this.retainedLength = 0;
    this.retained = undefined;
    this.scanner = new FrameScanner(this.maxFrameBytes);
  }
}
