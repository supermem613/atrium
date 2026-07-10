import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBackgroundRunPerfSpans,
  waitForBackgroundRun,
  withLongRunningDefault,
  type BackgroundRunWaitOptions,
} from "../core/backgroundRuns.js";
import { createPerfRecorder, type PerfOperationRecorder, type PerfOperationReport } from "../core/perf.js";
import { buildReadTextFileSlicePerfSpans, readTextFileSlice } from "../core/readFile.js";
import {
  buildRunExecutablePerfSpans,
  runExecutable,
  type RunExecutableInput,
  type RunExecutableResult,
} from "../core/runner.js";
import { createNativeSearchClient } from "../core/search/searchClient.js";
import { buildNativeSearchInvocationPerfAttributes, normalizeSearchResult } from "../core/search/normalize.js";
import type { SearchClientLike } from "../core/search/types.js";

export interface McpDebugOptions {
  perf?: boolean;
}

export interface McpRunOptions extends McpDebugOptions {
  cwd?: string;
  requestTimeoutMs?: string;
  stdin?: string;
  stdinFile?: string;
}

export interface McpReadOptions extends McpDebugOptions {
  startLine?: string;
  endLine?: string;
}

export interface McpFindFilesOptions extends McpDebugOptions {
  exclude?: string;
  glob?: string;
  max?: string;
}

export interface McpGrepOptions extends McpDebugOptions {
  exclude?: string;
  glob?: string;
  query?: string;
  queries?: string[];
  regex?: boolean;
  max?: string;
}

export type McpGrepCodeOptions = McpGrepOptions;

const defaultDebugRequestTimeoutMs = 60_000;
const defaultSearchTimeoutMs = 59_000;

async function withAtriumClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  const client = new Client({ name: "atrium-cli-debug", version: "2.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    stderr: "pipe",
  });

  await client.connect(transport);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

export async function mcpSchemaCommand(tool: string, options: McpDebugOptions = {}): Promise<void> {
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
  const response = await withAtriumClient((client) => client.callTool({ name: "schema", arguments: { tool } }));
  writeToolResponse(response, perfOperation?.finish());
}

export async function mcpRunCommand(
  tool: string,
  args: string[] | undefined,
  options: McpRunOptions,
  execute: (input: RunExecutableInput) => Promise<RunExecutableResult> = runExecutable,
): Promise<void> {
  const requestTimeoutMs = parseOptionalNumber(options.requestTimeoutMs, "--request-timeout-ms") ?? defaultDebugRequestTimeoutMs;
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
  if (options.perf === true) {
    const result = await execute(withLongRunningDefault({
      tool,
      args: args ?? [],
      cwd: options.cwd,
      stdin: options.stdinFile === undefined ? options.stdin : { file: options.stdinFile },
    }));
    for (const span of buildRunExecutablePerfSpans(result)) {
      perfOperation?.addSpan(span.name, span.attributes);
    }
    writePayload({
      ok: result.ok,
      tool: result.tool,
      timingMs: result.timingMs,
      metrics: result.metrics,
      ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
      ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    }, perfOperation?.finish());
    return;
  }

  const response = await withAtriumClient(async (client) => {
    perfOperation?.addSpan("mcp-run:call-tool");
    const runResponse = await client.callTool({
      name: "run",
      arguments: {
        tool,
        args: args ?? [],
        cwd: options.cwd,
        stdin: options.stdinFile === undefined ? options.stdin : { file: options.stdinFile },
      },
    }, CallToolResultSchema, { timeout: requestTimeoutMs });
    const runPayload = readToolPayload(runResponse);
    if (!isRunningPayload(runPayload)) {
      return runResponse;
    }

    return waitForDebugOperation(client, runPayload.operationId, requestTimeoutMs, perfOperation);
  });
  writeToolResponse(response, perfOperation?.finish());
}

export async function mcpOperationWaitCommand(
  operationId: string,
  options: McpDebugOptions = {},
  waitOptions?: BackgroundRunWaitOptions,
): Promise<void> {
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
  if (options.perf === true) {
    const snapshot = await waitForBackgroundRun(operationId, waitOptions);
    for (const span of buildBackgroundRunPerfSpans(snapshot)) {
      perfOperation?.addSpan(span.name, span.attributes);
    }
    writePayload(snapshot, perfOperation?.finish());
    return;
  }

  const response = await withAtriumClient((client) => client.callTool({
    name: "operation-wait",
    arguments: {
      operationId,
    },
  }));
  writeToolResponse(response, perfOperation?.finish());
}

export async function mcpReadCommand(path: string, options: McpReadOptions = {}): Promise<void> {
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
  if (options.perf === true) {
    const input: { path: string; startLine?: number; endLine?: number } = { path };
    const startLine = parseOptionalInteger(options.startLine, "--start-line");
    const endLine = parseOptionalInteger(options.endLine, "--end-line");
    if (startLine !== undefined) {
      input.startLine = startLine;
    }
    if (endLine !== undefined) {
      input.endLine = endLine;
    }
    const result = await readTextFileSlice(input);
    if (result.ok) {
      for (const span of buildReadTextFileSlicePerfSpans(result)) {
        perfOperation?.addSpan(span.name, span.attributes);
      }
    }
    writePayload(readPayload(result), perfOperation?.finish());
    return;
  }

  const response = await withAtriumClient((client) => client.callTool({
    name: "read",
    arguments: buildReadArguments(path, options),
  }));
  writeToolResponse(response, perfOperation?.finish());
}

export async function mcpFindFilesCommand(root: string, options: McpFindFilesOptions = {}, searchClient?: SearchClientLike): Promise<void> {
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
  if (options.perf === true) {
    const client = searchClient ?? createNativeSearchClient();
    const searchSpan = perfOperation?.startSpan("search");
    const envelope = await client.run({
      command: "files",
      root,
      all: true,
      ...(options.glob !== undefined ? { glob: options.glob } : {}),
      ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
      ...(parseOptionalInteger(options.max, "--max") !== undefined ? { max: parseOptionalInteger(options.max, "--max") } : {}),
      timeoutMs: defaultSearchTimeoutMs,
      perf: true,
    });
    searchSpan?.finish(buildNativeSearchEnvelopePerfAttributes(envelope));
    const normalizeSpan = perfOperation?.startSpan("normalize");
    const normalized = normalizeSearchResult(envelope, "files", buildNativeSearchInvocationPerfAttributes({
      command: "files",
      root,
      ...(options.glob !== undefined ? { glob: options.glob } : {}),
      ...(parseOptionalInteger(options.max, "--max") !== undefined ? { max: parseOptionalInteger(options.max, "--max") } : {}),
    }));
    normalizeSpan?.finish(buildNativeSearchPerfAttributes(normalized));
    writePayload({ kind: normalized.kind, matches: normalized.matches, warnings: normalized.warnings }, perfOperation?.finish());
    return;
  }

  const response = await withAtriumClient((client) => client.callTool({
    name: "find-files",
    arguments: buildFindFilesArguments(root, options),
  }));
  writeToolResponse(response, perfOperation?.finish());
}

export async function mcpGrepCommand(root: string, options: McpGrepOptions = {}, searchClient?: SearchClientLike): Promise<void> {
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
  if (options.perf === true) {
    const search = resolveCliSearchQuery(options);
    const client = searchClient ?? createNativeSearchClient();
    const searchSpan = perfOperation?.startSpan("search");
    const envelope = await client.run({
      command: "search",
      root,
      query: search.query,
      ...(search.regex ? { regex: true } : {}),
      all: true,
      ...(options.glob !== undefined ? { glob: options.glob } : {}),
      ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
      ...(parseOptionalInteger(options.max, "--max") !== undefined ? { max: parseOptionalInteger(options.max, "--max") } : {}),
      timeoutMs: defaultSearchTimeoutMs,
      perf: true,
    });
    searchSpan?.finish(buildNativeSearchEnvelopePerfAttributes(envelope));
    const normalizeSpan = perfOperation?.startSpan("normalize");
    const normalized = normalizeSearchResult(envelope, "content", buildNativeSearchInvocationPerfAttributes({
      command: "search",
      root,
      query: search.query,
      ...(search.regex ? { regex: true } : {}),
      ...(options.glob !== undefined ? { glob: options.glob } : {}),
      ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
      ...(parseOptionalInteger(options.max, "--max") !== undefined ? { max: parseOptionalInteger(options.max, "--max") } : {}),
    }));
    normalizeSpan?.finish(buildNativeSearchPerfAttributes(normalized));
    writePayload({ kind: normalized.kind, matches: normalized.matches, warnings: normalized.warnings }, perfOperation?.finish());
    return;
  }

  const response = await withAtriumClient((client) => client.callTool({
    name: "grep",
    arguments: buildGrepArguments(root, options),
  }));
  writeToolResponse(response, perfOperation?.finish());
}

export async function mcpGrepCodeCommand(root: string, options: McpGrepCodeOptions = {}, searchClient?: SearchClientLike): Promise<void> {
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
  if (options.perf === true) {
    const search = resolveCliSearchQuery(options);
    const client = searchClient ?? createNativeSearchClient();
    const searchSpan = perfOperation?.startSpan("search");
    const envelope = await client.run({
      command: "search",
      root,
      query: search.query,
      ...(search.regex ? { regex: true } : {}),
      ...(options.glob !== undefined ? { glob: options.glob } : {}),
      ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
      ...(parseOptionalInteger(options.max, "--max") !== undefined ? { max: parseOptionalInteger(options.max, "--max") } : {}),
      timeoutMs: defaultSearchTimeoutMs,
      perf: true,
    });
    searchSpan?.finish(buildNativeSearchEnvelopePerfAttributes(envelope));
    const normalizeSpan = perfOperation?.startSpan("normalize");
    const normalized = normalizeSearchResult(envelope, "content", buildNativeSearchInvocationPerfAttributes({
      command: "search",
      root,
      query: search.query,
      ...(search.regex ? { regex: true } : {}),
      ...(options.glob !== undefined ? { glob: options.glob } : {}),
      ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
      ...(parseOptionalInteger(options.max, "--max") !== undefined ? { max: parseOptionalInteger(options.max, "--max") } : {}),
    }));
    normalizeSpan?.finish(buildNativeSearchPerfAttributes(normalized));
    writePayload({ kind: normalized.kind, matches: normalized.matches, warnings: normalized.warnings }, perfOperation?.finish());
    return;
  }

  const response = await withAtriumClient((client) => client.callTool({
    name: "grep-code",
    arguments: buildGrepCodeArguments(root, options),
  }));
  writeToolResponse(response, perfOperation?.finish());
}

function buildNativeSearchPerfAttributes(normalized: ReturnType<typeof normalizeSearchResult>): Record<string, unknown> {
  return {
    searchInvocation: normalized.perf?.searchInvocation,
    normalization: normalized.perf?.normalization,
    nativeSearch: normalized.perf?.searchInvocation,
    bundledRipgrep: normalized.perf?.ripgrepMetrics,
    ripgrepMetrics: normalized.perf?.ripgrepMetrics,
  };
}

function buildNativeSearchEnvelopePerfAttributes(envelope: Awaited<ReturnType<SearchClientLike["run"]>>): Record<string, unknown> {
  const metrics = typeof envelope.metrics === "object" && envelope.metrics !== null
    ? envelope.metrics as Record<string, unknown>
    : {};
  return {
    nativeSearch: { command: envelope.command },
    bundledRipgrep: metrics.ripgrepMetrics,
    ripgrepMetrics: metrics.ripgrepMetrics,
  };
}

function writeToolResponse(response: Awaited<ReturnType<Client["callTool"]>>, perfReport?: PerfOperationReport): void {
  const payload = readToolPayload(response);
  const emittedPayload = attachPerf(payload, perfReport);
  if (emittedPayload !== undefined) {
    process.stdout.write(`${JSON.stringify(emittedPayload)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function writePayload(payload: unknown, perfReport?: PerfOperationReport): void {
  const emittedPayload = attachPerf(payload, perfReport);
  process.stdout.write(`${JSON.stringify(emittedPayload)}\n`);
}

function attachPerf(payload: unknown, perfReport: PerfOperationReport | undefined): unknown {
  if (perfReport === undefined) {
    return payload;
  }

  if (payload === undefined) {
    return { perf: perfReport };
  }

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return { ...payload, perf: perfReport };
  }

  return { value: payload, perf: perfReport };
}

function buildReadArguments(path: string, options: McpReadOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { path };
  const startLine = parseOptionalInteger(options.startLine, "--start-line");
  if (startLine !== undefined) {
    args.startLine = startLine;
  }
  const endLine = parseOptionalInteger(options.endLine, "--end-line");
  if (endLine !== undefined) {
    args.endLine = endLine;
  }
  return args;
}

function readPayload(result: Awaited<ReturnType<typeof readTextFileSlice>>): unknown {
  if (result.ok) {
    return { ok: true, path: result.path, range: result.range, meta: result.meta, content: result.content };
  }

  return { ok: false, status: result.status, path: result.path, hint: result.hint };
}

function buildFindFilesArguments(root: string, options: McpFindFilesOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { root };
  if (options.exclude !== undefined) {
    args.exclude = options.exclude;
  }
  if (options.glob !== undefined) {
    args.glob = options.glob;
  }
  const max = parseOptionalInteger(options.max, "--max");
  if (max !== undefined) {
    args.max = max;
  }
  return args;
}

function buildGrepArguments(root: string, options: McpGrepOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { root };
  if (options.exclude !== undefined) {
    args.exclude = options.exclude;
  }
  if (options.glob !== undefined) {
    args.glob = options.glob;
  }
  if (options.query !== undefined) {
    args.query = options.query;
  }
  if (options.queries !== undefined) {
    args.queries = options.queries;
  }
  if (options.regex === true) {
    args.regex = true;
  }
  const max = parseOptionalInteger(options.max, "--max");
  if (max !== undefined) {
    args.max = max;
  }
  return args;
}

function buildGrepCodeArguments(root: string, options: McpGrepCodeOptions): Record<string, unknown> {
  return buildGrepArguments(root, options);
}

function resolveCliSearchQuery(options: McpGrepOptions): { query: string; regex: boolean } {
  if ((options.query === undefined) === (options.queries === undefined)) {
    throw new Error("Provide exactly one of --query or --queries");
  }
  if (options.query !== undefined) {
    return { query: options.query, regex: options.regex === true };
  }
  const queries = options.queries ?? [];
  if (queries.length === 0) {
    throw new Error("--queries requires at least one pattern");
  }
  if (options.regex !== true && queries.length === 1) {
    return { query: queries[0], regex: false };
  }
  return {
    query: options.regex === true
      ? queries.join("|")
      : queries.map((query) => query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    regex: true,
  };
}

function readToolPayload(response: Awaited<ReturnType<Client["callTool"]>>): unknown {
  if (!("content" in response) || !Array.isArray(response.content)) {
    return undefined;
  }

  const firstContent = response.content[0];
  if (!isTextContent(firstContent)) {
    return undefined;
  }

  try {
    return JSON.parse(firstContent.text) as unknown;
  } catch {
    return firstContent.text;
  }
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && value.type === "text"
    && "text" in value
    && typeof value.text === "string";
}

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a number`);
  }

  return parsed;
}

function parseOptionalInteger(value: string | undefined, flag: string): number | undefined {
  return parseOptionalNumber(value, flag);
}

async function waitForDebugOperation(client: Client, operationId: string, requestTimeoutMs: number, perfOperation?: PerfOperationRecorder): ReturnType<Client["callTool"]> {
  const deadline = Date.now() + requestTimeoutMs;
  let response = await callOperationWait(client, operationId, defaultDebugRequestTimeoutMs);

  while (Date.now() < deadline) {
    perfOperation?.addSpan("mcp-run:operation-wait");
    const payload = readToolPayload(response);
    if (!isContinuePayload(payload)) {
      return response;
    }

    response = await callOperationWait(client, operationId, defaultDebugRequestTimeoutMs);
  }

  return textToolResponse({
    ok: false,
    status: "failed",
    operationId,
    error: {
      code: "DebugWaitTimeout",
      message: `Local mcp-run debug command stopped waiting for operationId=${operationId}. Re-run with --request-timeout-ms if you need a longer debug wait.`,
    },
  });
}

async function callOperationWait(client: Client, operationId: string, requestTimeoutMs: number): ReturnType<Client["callTool"]> {
  return client.callTool({
    name: "operation-wait",
    arguments: {
      operationId,
    },
  }, CallToolResultSchema, { timeout: requestTimeoutMs });
}

function isRunningPayload(value: unknown): value is { status: "running"; operationId: string } {
  return typeof value === "object"
    && value !== null
    && "status" in value
    && value.status === "running"
    && "operationId" in value
    && typeof value.operationId === "string";
}

function isContinuePayload(value: unknown): value is { status: "continue"; operationId: string } {
  return typeof value === "object"
    && value !== null
    && "status" in value
    && value.status === "continue"
    && "operationId" in value
    && typeof value.operationId === "string";
}

function textToolResponse(value: unknown): Awaited<ReturnType<Client["callTool"]>> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
  };
}
