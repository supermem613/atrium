import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { defaultInlineOutputLimitBytes, materializeOutputValue, OutputValue } from "./artifacts.js";
import { atriumTempPath } from "./tempPaths.js";

const defaultLineCount = 120;

export interface ReadTextFileSliceInput {
  path: string;
  startLine?: number;
  endLine?: number;
  count?: number;
}

export type ReadTextFileSliceResult = ReadTextFileSliceSuccess | ReadTextFileSliceFailure;

export interface ReadTextFileSliceSuccess {
  ok: true;
  path: string;
  range: [number, number];
  meta: {
    totalLines: number;
    bytes: number;
    timing: {
      totalMs: number;
      statMs: number;
      readMs: number;
      sliceMs: number;
      materializeMs: number;
      contentBytes: number;
    };
  };
  content: OutputValue;
}

export interface ReadTextFileSliceFailure {
  ok: false;
  status: "not-found" | "unsupported" | "invalid-args";
  path: string;
  hint: string;
}

interface LineSlice {
  start: number;
  end: number;
}

export async function readTextFileSlice(input: ReadTextFileSliceInput): Promise<ReadTextFileSliceResult> {
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

  let readMs = 0;
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

  let sliceMs = 0;
  const sliceStart = performance.now();
  const text = buffer.toString("utf8");
  const lines = lineSlices(text);
  const totalLines = lines.length;
  const requestedCount = input.count ?? (input.endLine === undefined ? defaultLineCount : input.endLine - startLine + 1);
  const [servedStart, servedEnd] = clampRange(startLine, requestedCount, totalLines);
  const contentBuffer = Buffer.from(sliceLines(text, lines, servedStart, servedEnd), "utf8");
  sliceMs = roundTimingValue(performance.now() - sliceStart);

  let materializeMs = 0;
  const materializeStart = performance.now();
  const content = await materializeOutputValue(contentBuffer, defaultInlineOutputLimitBytes, atriumTempPath("reads", randomUUID()), "content.txt");
  materializeMs = roundTimingValue(performance.now() - materializeStart);

  return {
    ok: true,
    path: input.path,
    range: [servedStart, servedEnd],
    meta: {
      totalLines,
      bytes: buffer.byteLength,
      timing: {
        totalMs: roundTimingValue(performance.now() - totalStart),
        statMs,
        readMs,
        sliceMs,
        materializeMs,
        contentBytes: contentBuffer.byteLength,
      },
    },
    content,
  };
}

function invalidArgs(path: string, hint: string): ReadTextFileSliceFailure {
  return {
    ok: false,
    status: "invalid-args",
    path,
    hint,
  };
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
