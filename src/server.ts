#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { introspectTool } from "./core/introspect.js";
import { adoptBackgroundRun, getBackgroundRun, withLongRunningDefault } from "./core/backgroundRuns.js";
import { RunExecutableInput, RunExecutableResult, startExecutableRun } from "./core/runner.js";
import { ExecutionQueue } from "./core/executionQueue.js";
import { toolTextResult } from "./mcp/format.js";
import { createXrayClient } from "./core/search/xrayClient.js";
import { normalizeXrayResult } from "./core/search/normalize.js";
import type { XraySearchClientLike } from "./core/search/types.js";

const defaultBackgroundHandoffAfterMs = 45_000;

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

interface SearchVerbSpec {
  command: "search" | "files";
  all: boolean;
  regex: boolean;
  kind: "content" | "files";
  title: string;
  description: string;
}

const contentVerbs: Record<"grep" | "grep-code" | "multi-grep" | "multi-grep-code", SearchVerbSpec> = {
  "grep": {
    command: "search", all: true, regex: false, kind: "content",
    title: "Grep files",
    description: "Unrestricted content search across the filesystem, including hidden, gitignored, and vendor files. Use for broad filesystem or generated and dependency content. For code-aware search prefer grep-code.",
  },
  "grep-code": {
    command: "search", all: false, regex: false, kind: "content",
    title: "Grep code",
    description: "Git-aware content search over code that skips hidden, gitignored, and vendor files. Prefer this first for symbols, APIs, tests, command handlers, error strings, and docs related to code.",
  },
  "multi-grep": {
    command: "search", all: true, regex: true, kind: "content",
    title: "Multi-grep files",
    description: "Unrestricted multi-pattern content search. Provide a regex alternation such as foo|bar|baz. Includes hidden, gitignored, and vendor files.",
  },
  "multi-grep-code": {
    command: "search", all: false, regex: true, kind: "content",
    title: "Multi-grep code",
    description: "Git-aware multi-pattern content search over code. Provide a regex alternation such as foo|bar|baz. Prefer this first for code-oriented investigation.",
  },
};

const findFilesVerb: SearchVerbSpec = {
  command: "files", all: true, regex: false, kind: "files",
  title: "Find files",
  description: "List file paths under a root, filtered by glob or type. Path discovery only; it never reads file contents. Includes hidden, gitignored, and vendor files.",
};

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
  "- When a tool returns status running with an operationId, it also returns a nextCheck object naming exactly what to call next: the operation-status tool, with that operationId, after callInMs milliseconds.",
  "- Wait callInMs, then call operation-status with the operationId. Repeat until status is completed or failed. Never report success from a still-running handle.",
  "",
  "Value contract:",
  "- A plain string argument or stdin is used literally.",
  "- An object {file: path} is replaced with the UTF-8 contents of that file.",
  "- Use the schema tool to discover a CLI invocation shape instead of scraping help through a shell.",
  "",
  "Search primitives:",
  "- Content search verbs grep, grep-code, multi-grep, and multi-grep-code run xray search. find-files lists paths with xray files and never reads contents.",
  "- grep, multi-grep, and find-files are unrestricted and include hidden, gitignored, and vendor files. grep-code and multi-grep-code are git-aware and scoped to code.",
  "- These are first-class Atrium MCP tools backed by xray. Do not call xray directly for search.",
].join("\n");

export interface AtriumServerOptions {
  backgroundHandoffAfterMs?: number;
  executionQueue?: ExecutionQueue | false;
  searchClient?: XraySearchClientLike;
}

export function createAtriumServer(options: AtriumServerOptions = {}): McpServer {
  const backgroundHandoffAfterMs = options.backgroundHandoffAfterMs ?? defaultBackgroundHandoffAfterMs;
  const executionOptions = {
    executionQueue: options.executionQueue,
  };
  const searchClient = options.searchClient ?? createXrayClient();
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
      description: "Execute named CLIs with structured args and structured JSON returns. Returns the normal result when the command finishes inside the handoff window, otherwise returns a durable operationId and a prescriptive nextCheck instruction telling you to poll operation-status.",
      inputSchema: {
        tool: z.string().min(1).describe("Binary name on PATH or executable path. Shells such as pwsh, powershell, bash, cmd, sh, and zsh are denied."),
        args: z.array(z.union([z.string(), z.object({ file: z.string().min(1) })])).optional().describe("Argument vector. Use {file} to replace that argument with UTF-8 file contents. Do not pass a shell command string."),
        cwd: z.string().optional().describe("Working directory for the process."),
        stdin: z.union([z.string(), z.object({ file: z.string().min(1) })]).optional().describe("Optional stdin content. Use {file} to read UTF-8 stdin content from a file."),
        timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Execution timeout in milliseconds that bounds the child process. Defaults to 3600000 when omitted."),
      },
    },
    async (input) => toolTextResult(await runWithHandoff(input, backgroundHandoffAfterMs, executionOptions)),
  );

  server.registerTool(
    "operation-status",
    {
      title: "Check a durable operation",
      description: "Return the current state and final result path for a durable operation handed off by any Atrium tool. While the operation is running it returns the same prescriptive nextCheck instruction. Recovers from the persisted operation snapshot when server memory no longer has the handle.",
      inputSchema: {
        operationId: z.string().min(1).describe("Durable operationId returned by an Atrium tool handoff."),
      },
    },
    async ({ operationId }) => toolTextResult(await getBackgroundRun(operationId)),
  );

  for (const [toolName, spec] of Object.entries(contentVerbs)) {
    server.registerTool(
      toolName,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: {
          root: z.string().min(1).describe("Root path to search from."),
          query: z.string().min(1).describe("Search query passed to xray."),
          glob: z.string().min(1).optional().describe("Optional glob to constrain the search."),
          exclude: z.string().min(1).optional().describe("Optional exclude pattern applied as a negated glob."),
          max: z.number().int().positive().optional().describe("Optional maximum number of results to return."),
          timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Optional timeout in milliseconds for the request."),
        },
      },
      async ({ root, query, glob, exclude, max, timeoutMs }) => toolTextResult(await runSearchWithHandoff(
        () => searchClient.run({
          command: spec.command,
          root,
          query,
          ...(spec.regex ? { regex: true } : {}),
          ...(spec.all ? { all: true } : {}),
          ...(glob !== undefined ? { glob } : {}),
          ...(exclude !== undefined ? { exclude } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }).then((envelope) => normalizeXrayResult(envelope, spec.kind)),
        backgroundHandoffAfterMs,
      )),
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
        timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Optional timeout in milliseconds for the request."),
      },
    },
    async ({ root, glob, exclude, max, timeoutMs }) => toolTextResult(await runSearchWithHandoff(
      () => searchClient.run({
        command: "files",
        root,
        all: true,
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }).then((envelope) => normalizeXrayResult(envelope, "files")),
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

  return adoptBackgroundRun({ startedAt, result });
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

export async function startAtriumServer(): Promise<void> {
  await createAtriumServer().connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startAtriumServer();
}
