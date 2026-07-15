import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { defaultInlineOutputLimitBytes, materializeOutputValue, OutputValue } from "./artifacts.js";
import { sanitizePerfAttributes } from "./perf.js";
import { atriumTempPath } from "./tempPaths.js";

const defaultLineCount = 120;
const maxCacheEntries = 32;
const maxCachedFileSizeBytes = 1024 * 1024;
const readLineSliceCache = new Map<string, CachedLineSliceCacheEntry>();

export interface ReadTextFileSliceInput {
  path: string;
  startLine?: number;
  endLine?: number;
  count?: number;
  startByte?: number;
  countBytes?: number;
  snapshot?: string;
}

export type ReadTextFileSliceResult = ReadTextFileSliceSuccess | ReadTextFileSliceFailure;

export interface ReadTextFileSliceSuccess {
  ok: true;
  path: string;
  range: [number, number];
  timingMs: number;
  meta: {
    totalLines: number;
    bytes: number;
    totalBytes?: number;
    cache: {
      hit: boolean;
      reason: "miss" | "same-file";
    };
  };
  content: OutputValue;
  byteRange?: [number, number];
  snapshot?: string;
  nextRead?: { path: string; startByte: number; countBytes: number; snapshot: string } | null;
  perf?: ReadTextFileSlicePerf;
}

export interface ReadTextFileSlicePerf {
  totalMs: number;
  statMs: number;
  readMs: number;
  sliceMs: number;
  materializeMs: number;
  contentBytes: number;
}

export interface ReadTextFileSliceOptions {
  perf?: boolean;
}

export interface ReadTextFileSliceFailure {
  ok: false;
  status: "not-found" | "unsupported" | "invalid-args" | "mutation_rejected";
  path: string;
  hint: string;
}

interface LineSlice {
  start: number;
  end: number;
}

interface CachedLineSliceCacheEntry {
  text: string;
  lines: LineSlice[];
  bytes: number;
}

export async function readTextFileSlice(input: ReadTextFileSliceInput, options: ReadTextFileSliceOptions = {}): Promise<ReadTextFileSliceResult> {
  const useByteMode = input.startByte !== undefined || input.countBytes !== undefined;
  if (useByteMode) {
    if (input.startLine !== undefined || input.endLine !== undefined || input.count !== undefined) {
      return invalidArgs(input.path, "provide either line input or byte input, not both");
    }
    if (input.startByte !== undefined && input.startByte < 0) {
      return invalidArgs(input.path, "startByte must be at least 0");
    }
    if (input.countBytes !== undefined && input.countBytes < 1) {
      return invalidArgs(input.path, "countBytes must be at least 1");
    }
  }

  const startLine = input.startLine ?? 1;
  if (startLine < 1) {
    return invalidArgs(input.path, "startLine must be at least 1");
  }
  if (input.count !== undefined && input.count < 1) {
    return invalidArgs(input.path, "count must be at least 1");
  }
  if (input.endLine !== undefined && input.endLine < startLine) {
    return invalidArgs(input.path, "endLine must be greater than or equal to startLine");
  }
  if (input.endLine !== undefined && input.count !== undefined) {
    return invalidArgs(input.path, "provide endLine or count, not both");
  }

  const totalStart = performance.now();
  let statMs = 0;
  const statStart = performance.now();
  const fileStat = await stat(input.path).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  statMs = roundTimingValue(performance.now() - statStart);
  if (fileStat === null) {
    return {
      ok: false,
      status: "not-found",
      path: input.path,
      hint: `nearest existing ancestor: ${await nearestExistingAncestor(input.path)}`,
    };
  }
  if (fileStat.isDirectory()) {
    return {
      ok: false,
      status: "unsupported",
      path: input.path,
      hint: "path is a directory",
    };
  }

  const snapshot = createCacheKey(input.path, fileStat);
  const cacheKey = snapshot;
  const cachedEntry = fileStat.size <= maxCachedFileSizeBytes ? getCachedLineSliceEntry(cacheKey) : undefined;

  let readMs = 0;
  let text = "";
  let lines: LineSlice[] = [];
  let bytes = 0;
  let totalLines = 0;
  let cacheMeta: ReadTextFileSliceSuccess["meta"]["cache"] = { hit: false, reason: "miss" };

  if (useByteMode) {
    if (input.snapshot !== undefined && input.snapshot !== snapshot) {
      return {
        ok: false,
        status: "mutation_rejected",
        path: input.path,
        hint: "snapshot token does not match current file state",
      };
    }

    const readStart = performance.now();
    const buffer = await readFile(input.path);
    readMs = roundTimingValue(performance.now() - readStart);
    if (buffer.includes(0)) {
      return {
        ok: false,
        status: "unsupported",
        path: input.path,
        hint: "binary content is not supported",
      };
    }

    const totalBytes = buffer.byteLength;
    const startByte = input.startByte ?? 0;
    const safeStartByte = Math.min(startByte, totalBytes);
    const requestedCountBytes = Math.min(input.countBytes ?? defaultInlineOutputLimitBytes, defaultInlineOutputLimitBytes);
    const remainingBytes = Math.max(0, totalBytes - safeStartByte);
    const initialServedEnd = Math.min(safeStartByte + requestedCountBytes, safeStartByte + remainingBytes);
    let servedEnd = initialServedEnd;

    if (safeStartByte < totalBytes && isContinuationByte(buffer[safeStartByte])) {
      return invalidArgs(input.path, "startByte points into the middle of a UTF-8 codepoint");
    }

    if (servedEnd > safeStartByte && !isValidUtf8Window(buffer, safeStartByte, servedEnd)) {
      let shrinkEnd = servedEnd;
      while (shrinkEnd > safeStartByte + 1 && !isValidUtf8Window(buffer, safeStartByte, shrinkEnd)) {
        shrinkEnd -= 1;
      }
      if (isValidUtf8Window(buffer, safeStartByte, shrinkEnd)) {
        servedEnd = shrinkEnd;
      } else {
        const codePointLength = measureUtf8CodePointLength(buffer, safeStartByte);
        if (codePointLength > 0 && safeStartByte + codePointLength <= totalBytes) {
          servedEnd = safeStartByte + codePointLength;
        } else {
          servedEnd = totalBytes;
        }
      }
    }

    if (safeStartByte < totalBytes && servedEnd <= safeStartByte) {
      const codePointLength = measureUtf8CodePointLength(buffer, safeStartByte);
      if (codePointLength > 0 && safeStartByte + codePointLength <= totalBytes) {
        servedEnd = safeStartByte + codePointLength;
      } else {
        servedEnd = totalBytes;
      }
    }

    const contentBuffer = buffer.subarray(safeStartByte, servedEnd);
    const totalMs = roundTimingValue(performance.now() - totalStart);
    return {
      ok: true,
      path: input.path,
      timingMs: totalMs,
      range: [safeStartByte, servedEnd],
      meta: {
        totalLines: 0,
        bytes: totalBytes,
        totalBytes,
        cache: { hit: false, reason: "miss" },
      },
      content: contentBuffer.toString("utf8"),
      byteRange: [safeStartByte, servedEnd],
      snapshot,
      nextRead: servedEnd < totalBytes ? { path: input.path, startByte: servedEnd, countBytes: requestedCountBytes, snapshot } : null,
    };
  }

  if (cachedEntry !== undefined) {
    text = cachedEntry.text;
    lines = cachedEntry.lines;
    bytes = cachedEntry.bytes;
    totalLines = lines.length;
    cacheMeta = { hit: true, reason: "same-file" };
  } else {
    const readStart = performance.now();
    const buffer = await readFile(input.path);
    readMs = roundTimingValue(performance.now() - readStart);
    if (buffer.includes(0)) {
      return {
        ok: false,
        status: "unsupported",
        path: input.path,
        hint: "binary content is not supported",
      };
    }

    text = buffer.toString("utf8");
    lines = lineSlices(text);
    totalLines = lines.length;
    bytes = buffer.byteLength;

    if (fileStat.size <= maxCachedFileSizeBytes) {
      setCachedLineSliceEntry(cacheKey, { text, lines, bytes });
    }
  }

  let sliceMs = 0;
  const sliceStart = performance.now();
  const requestedCount = input.count ?? (input.endLine === undefined ? defaultLineCount : input.endLine - startLine + 1);
  const [servedStart, servedEnd] = clampRange(startLine, requestedCount, totalLines);
  const contentBuffer = Buffer.from(sliceLines(text, lines, servedStart, servedEnd), "utf8");
  sliceMs = roundTimingValue(performance.now() - sliceStart);

  let materializeMs = 0;
  const materializeStart = performance.now();
  const content = await materializeOutputValue(contentBuffer, defaultInlineOutputLimitBytes, atriumTempPath("reads", randomUUID()), "content.txt");
  materializeMs = roundTimingValue(performance.now() - materializeStart);

  const totalMs = roundTimingValue(performance.now() - totalStart);
  return {
    ok: true,
    path: input.path,
    timingMs: totalMs,
    range: [servedStart, servedEnd],
    meta: {
      totalLines,
      bytes,
      cache: cacheMeta,
    },
    content,
    ...(options.perf === true
      ? {
        perf: {
          totalMs,
          statMs,
          readMs,
          sliceMs,
          materializeMs,
          contentBytes: contentBuffer.byteLength,
        },
      }
      : {}),
  };
}

export function buildReadTextFileSlicePerfSpans(result: ReadTextFileSliceSuccess): Array<{ name: string; attributes: Record<string, unknown> }> {
  const timing = result.perf;
  if (timing === undefined) {
    return [];
  }
  return [
    { name: "stat", attributes: sanitizePerfAttributes({ stat: { durationMs: timing.statMs, totalMs: timing.totalMs } }) },
    { name: "read", attributes: sanitizePerfAttributes({ read: { durationMs: timing.readMs, bytes: result.meta.bytes } }) },
    { name: "slice", attributes: sanitizePerfAttributes({ slice: { durationMs: timing.sliceMs, contentBytes: timing.contentBytes } }) },
    { name: "materialize", attributes: sanitizePerfAttributes({ materialize: { durationMs: timing.materializeMs, contentBytes: timing.contentBytes } }) },
  ];
}

function invalidArgs(path: string, hint: string): ReadTextFileSliceFailure {
  return {
    ok: false,
    status: "invalid-args",
    path,
    hint,
  };
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xC0) === 0x80;
}

function isValidUtf8Window(buffer: Buffer, startByte: number, endByte: number): boolean {
  if (endByte <= startByte) {
    return false;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(buffer.subarray(startByte, endByte));
    return true;
  } catch {
    return false;
  }
}

function measureUtf8CodePointLength(buffer: Buffer, startByte: number): number {
  const firstByte = buffer[startByte];
  if (firstByte === undefined) {
    return 0;
  }
  if (firstByte <= 0x7F) {
    return 1;
  }
  if ((firstByte & 0xE0) === 0xC0) {
    return 2;
  }
  if ((firstByte & 0xF0) === 0xE0) {
    return 3;
  }
  if ((firstByte & 0xF8) === 0xF0) {
    return 4;
  }
  return 0;
}

function lineSlices(text: string): LineSlice[] {
  const lines: LineSlice[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lines.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < text.length) {
    lines.push({ start, end: text.length });
  }
  return lines;
}

function clampRange(startLine: number, count: number, totalLines: number): [number, number] {
  if (totalLines === 0) {
    return [0, 0];
  }
  if (startLine > totalLines) {
    return [Math.max(1, totalLines - count + 1), totalLines];
  }
  return [startLine, Math.min(totalLines, startLine + count - 1)];
}

function sliceLines(text: string, lines: LineSlice[], startLine: number, endLine: number): string {
  if (lines.length === 0 || startLine === 0 || endLine === 0) {
    return "";
  }
  const first = lines[startLine - 1];
  const last = lines[endLine - 1];
  if (first === undefined || last === undefined) {
    return "";
  }
  return text.slice(first.start, last.end);
}

function createCacheKey(path: string, fileStat: { size: number; mtimeMs: number }): string {
  return `${resolve(path)}:${fileStat.size}:${fileStat.mtimeMs}`;
}

function getCachedLineSliceEntry(cacheKey: string): CachedLineSliceCacheEntry | undefined {
  return readLineSliceCache.get(cacheKey);
}

function setCachedLineSliceEntry(cacheKey: string, entry: CachedLineSliceCacheEntry): void {
  readLineSliceCache.set(cacheKey, entry);
  if (readLineSliceCache.size > maxCacheEntries) {
    const oldestKey = readLineSliceCache.keys().next().value;
    if (oldestKey !== undefined) {
      readLineSliceCache.delete(oldestKey);
    }
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = dirname(path);
  while (candidate !== dirname(candidate)) {
    if (await canAccess(candidate)) {
      return candidate;
    }
    candidate = dirname(candidate);
  }
  return candidate;
}

async function canAccess(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function roundTimingValue(value: number): number {
  return Number(value.toFixed(3));
}
