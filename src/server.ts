#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { introspectTool } from "./core/introspect.js";
import { adoptBackgroundRun, defaultWaitTimeoutMs, waitForBackgroundRun, withLongRunningDefault } from "./core/backgroundRuns.js";
import { RunExecutableInput, RunExecutableResult, startExecutableRun } from "./core/runner.js";
import { ExecutionQueue } from "./core/executionQueue.js";
import { toolTextResult } from "./mcp/format.js";
import { createNativeSearchClient } from "./core/search/searchClient.js";
import { buildNativeSearchInvocationPerfAttributes, normalizeSearchResult } from "./core/search/normalize.js";
import { readTextFileSlice } from "./core/readFile.js";
import type { SearchClientLike } from "./core/search/types.js";

const defaultBackgroundHandoffAfterMs = 45_000;
const defaultSearchTimeoutMs = 59_000;

const globalWithPatch = globalThis as typeof globalThis & { __atriumPatchedJsonParse?: boolean };
if (!globalWithPatch.__atriumPatchedJsonParse) {
  const originalJsonParse = JSON.parse;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    const parsed = originalJsonParse(text, reviver as Parameters<typeof originalJsonParse>[1]);
    if (typeof parsed === "object" && parsed !== null && "perf" in parsed) {
      const perfValue = (parsed as Record<string, unknown>).perf;
      delete (parsed as Record<string, unknown>).perf;
      Object.defineProperty(parsed, "perf", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: perfValue,
      });
    }
    return parsed;
  }) as typeof JSON.parse;
  globalWithPatch.__atriumPatchedJsonParse = true;
}

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

interface SearchVerbSpec {
  command: "search" | "files";
  all: boolean;
  kind: "content" | "files";
  title: string;
  description: string;
}

const contentVerbs: Record<"grep" | "grep-code", SearchVerbSpec> = {
  "grep": {
    command: "search", all: true, kind: "content",
    title: "Grep files",
    description: "Unrestricted content search across the filesystem, including hidden, gitignored, and vendor files. Pass a single literal query, or a queries array of one or more patterns. Set regex true to treat patterns as regular expressions. For ignore-aware code search prefer grep-code.",
  },
  "grep-code": {
    command: "search", all: false, kind: "content",
    title: "Grep code",
    description: "Ignore-aware content search that skips hidden, gitignored, and vendor files. Pass a single literal query, or a queries array of one or more patterns. Set regex true to treat patterns as regular expressions. Prefer this first for symbols, APIs, tests, command handlers, error strings, and docs related to code.",
  },
};

const findFilesVerb: SearchVerbSpec = {
  command: "files", all: true, kind: "files",
  title: "Find files",
  description: "List file paths under a root, filtered by glob and exclude. Path discovery only; it never reads file contents. Includes hidden, gitignored, and vendor files. The tool exposes glob but not a type option.",
};

// Escapes regex metacharacters so a literal pattern matches itself when several
// literal patterns are combined into one native-search alternation.
function escapeRegExp(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolves query/queries/regex into one native-search query plus whether native
// search runs in regex mode. A lone literal query stays a plain literal search so
// grep and grep-code keep their prior single-pattern behavior. Multiple literal
// patterns are escaped and joined into an alternation. When regex is set,
// patterns are joined verbatim. Exactly one of query or queries must be present.
function resolveSearchQuery(
  toolName: string,
  query: string | undefined,
  queries: string[] | undefined,
  regex: boolean,
): { query: string; regex: boolean } {
  if ((query === undefined) === (queries === undefined)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for tool ${toolName}: provide exactly one of query or queries.`,
    );
  }
  const patterns = query !== undefined ? [query] : queries as string[];
  if (regex) {
    return { query: patterns.join("|"), regex: true };
  }
  if (patterns.length === 1) {
    return { query: patterns[0], regex: false };
  }
  return { query: patterns.map(escapeRegExp).join("|"), regex: true };
}

// Advertised to the client at the MCP initialize handshake so the model learns the
// hard constraints up front instead of discovering them through denied tool calls.
const atriumInstructions = [
  "Atrium runs named CLIs and executables with structured JSON results. It is not a shell.",
  "",
  "Hard rules, enforced by the server:",
  "1. Shells are denied. Do not pass pwsh, powershell, bash, cmd, sh, or zsh as tool. Call the target binary directly with an args vector. Never pass a single shell command string.",
  "2. There is one execution behavior. Every run and search starts, waits briefly, then returns the result if it finished, otherwise returns a durable operationId. A handoff is not an error.",
  "",
  "Handoff contract:",
  "- When a tool returns status running with an operationId, it also returns a nextCheck object naming exactly what to call next: the operation-wait tool with that operationId.",
  "- Repeat operation-wait while it returns status continue. Never report success from a still-running handle.",
  "",
  "Value contract:",
  "- A plain string argument or stdin is used literally.",
  "- An object {file: path} is replaced with the UTF-8 contents of that file.",
  "- Use the schema tool to discover a CLI invocation shape instead of scraping help through a shell.",
  "",
  "Search primitives:",
  "- Content search verbs grep and grep-code use Atrium's native search implementation backed by bundled-ripgrep. find-files lists paths with Atrium's native file engine and never reads contents.",
  "- grep and grep-code take a single literal query or a queries array of one or more patterns to match any of several patterns. Set regex true to treat patterns as regular expressions. grep and find-files are unrestricted and include hidden, gitignored, and vendor files. grep-code is ignore-aware and skips hidden, gitignored, and vendor files.",
  "- These are first-class Atrium MCP tools. Use them for search instead of shelling out.",
].join("\n");

export interface AtriumServerOptions {
  backgroundHandoffAfterMs?: number;
  waitTimeoutMs?: number;
  executionQueue?: ExecutionQueue | false;
  searchClient?: SearchClientLike;
}

export function createAtriumServer(options: AtriumServerOptions = {}): McpServer {
  const backgroundHandoffAfterMs = options.backgroundHandoffAfterMs ?? defaultBackgroundHandoffAfterMs;
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  const executionOptions = {
    executionQueue: options.executionQueue,
  };
  const searchClient = options.searchClient ?? createNativeSearchClient();
  const server = new McpServer(
    {
      name: "atrium",
      version: packageVersion,
    },
    {
      instructions: atriumInstructions,
    },
  );

  server.registerTool(
    "schema",
    {
      title: "Describe a CLI invocation shape",
      description: "Discover a CLI invocation shape by running `<tool> schema` and parsing JSON. Falls back to `<tool> --help`. Prefer this over scraping help through powershell.",
      inputSchema: {
        tool: z.string().min(1).describe("Binary name or executable path to describe."),
      },
    },
    async ({ tool }) => {
      return toolTextResult(await introspectTool(tool, executionOptions));
    },
  );

  server.registerTool(
    "run",
    {
      title: "Run a CLI or executable",
      description: "Execute named CLIs with structured args and structured JSON returns. Returns the normal result when the command finishes inside the handoff window, otherwise returns a durable operationId and a prescriptive nextCheck instruction telling you to call operation-wait. The child process uses Atrium's fixed server-side execution deadline; callers cannot tune it.",
      inputSchema: {
        tool: z.string().min(1).describe("Binary name on PATH or executable path. Shells such as pwsh, powershell, bash, cmd, sh, and zsh are denied."),
        args: z.array(z.union([z.string(), z.object({ file: z.string().min(1) })])).optional().describe("Argument vector. Use {file} to replace that argument with UTF-8 file contents. Do not pass a shell command string."),
        cwd: z.string().optional().describe("Working directory for the process."),
        stdin: z.union([z.string(), z.object({ file: z.string().min(1) })]).optional().describe("Optional stdin content. Use {file} to read UTF-8 stdin content from a file."),
      },
    },
    async (input) => toolTextResult(await runWithHandoff(input, backgroundHandoffAfterMs, executionOptions)),
  );

  server.registerTool(
    "operation-wait",
    {
      title: "Wait for a durable operation",
      description: "Wait briefly for a durable operation handed off by any Atrium tool. Returns the terminal result when complete. If still running after Atrium's fixed request-safe wait window, returns status continue with the same operationId and a nextCheck instruction to call operation-wait again. This does not cancel, shorten, or tune the underlying operation.",
      inputSchema: {
        operationId: z.string().min(1).describe("Durable operationId returned by an Atrium tool handoff."),
      },
    },
    async ({ operationId }) => toolTextResult(await waitForBackgroundRun(operationId, { requestSafeWaitMs: waitTimeoutMs })),
  );

  server.registerTool(
    "read",
    {
      title: "Read text file range",
      description: "Read a UTF-8 text file with deterministic line-range clamping. Successful reads return ok, path, range, meta, and content. Large content uses Atrium's {file, bytes} value contract.",
      inputSchema: {
        path: z.string().min(1).describe("File path to read."),
        startLine: z.number().int().positive().optional().describe("First 1-based line to read. Defaults to 1."),
        endLine: z.number().int().positive().optional().describe("Last 1-based line to read. Mutually exclusive with count."),
        count: z.number().int().positive().optional().describe("Maximum number of lines to read. Mutually exclusive with endLine."),
      },
    },
    async (input) => toolTextResult(await readTextFileSlice(input)),
  );

  const runContentSearch = async (spec: SearchVerbSpec, query: string, regex: boolean, root: string, glob?: string, exclude?: string, max?: number) =>
    toolTextResult(await runSearchWithHandoff(
      () => searchClient.run({
        command: spec.command,
        root,
        query,
        ...(regex ? { regex: true } : {}),
        ...(spec.all ? { all: true } : {}),
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
        timeoutMs: defaultSearchTimeoutMs,
      }).then((envelope) => normalizeSearchResult(envelope, spec.kind, buildNativeSearchInvocationPerfAttributes({
        command: spec.command,
        root,
        query,
        ...(regex ? { regex: true } : {}),
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
      }))),
      backgroundHandoffAfterMs,
    ));

  for (const [toolName, spec] of Object.entries(contentVerbs)) {
    server.registerTool(
      toolName,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: {
          root: z.string().min(1).describe("Root path to search from."),
          query: z.string().min(1).optional().describe("A single search pattern. Provide either query or queries, not both."),
          queries: z.array(z.string().min(1)).min(1).optional().describe("One or more patterns to match any of. Atrium combines them into one alternation. Provide either query or queries, not both."),
          regex: z.boolean().optional().describe("Treat the patterns as regular expressions. Defaults to false, which matches patterns literally."),
          glob: z.string().min(1).optional().describe("Optional glob to constrain the search by path or name."),
          exclude: z.string().min(1).optional().describe("Optional exclude pattern applied as a negated glob."),
          max: z.number().int().positive().optional().describe("Optional maximum number of results to return."),
        },
      },
      async ({ root, query, queries, regex, glob, exclude, max }) => {
        const resolved = resolveSearchQuery(toolName, query, queries, regex ?? false);
        return runContentSearch(spec, resolved.query, resolved.regex, root, glob, exclude, max);
      },
    );
  }

  server.registerTool(
    "find-files",
    {
      title: findFilesVerb.title,
      description: findFilesVerb.description,
      inputSchema: {
        root: z.string().min(1).describe("Root path to list files from."),
        glob: z.string().min(1).optional().describe("Optional glob to constrain the listing by path or name."),
        exclude: z.string().min(1).optional().describe("Optional exclude pattern applied as a negated glob."),
        max: z.number().int().positive().optional().describe("Optional maximum number of files to return."),
      },
    },
    async ({ root, glob, exclude, max }) => toolTextResult(await runSearchWithHandoff(
      () => searchClient.run({
        command: "files",
        root,
        all: true,
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
        timeoutMs: defaultSearchTimeoutMs,
      }).then((envelope) => normalizeSearchResult(envelope, "files", buildNativeSearchInvocationPerfAttributes({
        command: "files",
        root,
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
      }))),
      backgroundHandoffAfterMs,
    )),
  );

  return server;
}

async function runWithHandoff(
  input: RunExecutableInput,
  backgroundHandoffAfterMs: number,
  executionOptions: { executionQueue?: ExecutionQueue | false } = {},
): Promise<RunExecutableResult | Awaited<ReturnType<typeof adoptBackgroundRun>>> {
  const running = await startExecutableRun(withLongRunningDefault(input), executionOptions);
  const result = await waitForResultOrTimeout(running.result, backgroundHandoffAfterMs);
  if (result !== undefined) {
    return result;
  }

  return adoptBackgroundRun(running);
}

async function runSearchWithHandoff(
  search: () => Promise<unknown>,
  backgroundHandoffAfterMs: number,
): Promise<unknown> {
  const startedAt = new Date().toISOString();
  const result = search();
  const completed = await waitForResultOrTimeout(result, backgroundHandoffAfterMs);
  if (completed !== undefined) {
    return completed;
  }

  return adoptBackgroundRun({ startedAt, result: result.then((value) => stripPerfMetadata(value)) });
}

async function waitForResultOrTimeout<T>(result: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("timed-out");
  const winner = await Promise.race([
    result,
    new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }

  return winner === timedOut ? undefined : winner;
}

function stripPerfMetadata<T>(value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "perf")) {
    return value;
  }

  const { perf, ...rest } = record;
  void perf;
  return rest as T;
}

export async function startAtriumServer(): Promise<void> {
  await createAtriumServer().connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startAtriumServer();
}
