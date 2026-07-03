#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { introspectTool } from "./core/introspect.js";
import { adoptBackgroundRun, defaultWaitTimeoutMs, getBackgroundRun, startBackgroundRun, waitForBackgroundRun, withLongRunningDefault } from "./core/backgroundRuns.js";
import { runExecutable, RunExecutableInput, RunExecutableResult, startExecutableRun } from "./core/runner.js";
import { ExecutionQueue } from "./core/executionQueue.js";
import { toolTextResult } from "./mcp/format.js";
import { createXrayClient } from "./core/search/xrayClient.js";
import { normalizeXrayResult } from "./core/search/normalize.js";
import type { XraySearchClientLike } from "./core/search/types.js";

const defaultMcpRequestTimeoutMs = 60_000;
const defaultAutoBackgroundAfterMs = 45_000;

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
  "2. Blocking mode caps timeoutMs at 60000 and rejects larger values with BlockingTimeoutTooLarge. For longer work use executionMode auto or background.",
  "3. Default executionMode is auto. Auto waits briefly, then returns a durable operationId plus a wait instruction if the command is still running. This is not an error.",
  "",
  "Background and wait contract:",
  "- When run returns status running with an operationId, call the wait tool with that operationId.",
  "- While wait returns status continue with mustReissueWait true, call wait again with the same operationId. follow true re-waits inside one call but a single call never blocks past the 45s request-safe window, so it cannot hit the client deadline.",
  "- Never report success from a still-running handle. Inspect the terminal result first.",
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
  autoBackgroundAfterMs?: number;
  waitTimeoutMs?: number;
  requestSafeWaitMs?: number;
  executionQueue?: ExecutionQueue | false;
  searchClient?: XraySearchClientLike;
}

export function createAtriumServer(options: AtriumServerOptions = {}): McpServer {
  const autoBackgroundAfterMs = options.autoBackgroundAfterMs ?? defaultAutoBackgroundAfterMs;
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  const requestSafeWaitMs = options.requestSafeWaitMs ?? defaultWaitTimeoutMs;
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
      description: "Execute named CLIs with structured args and structured JSON returns. Defaults to auto mode: return the normal result if the command finishes quickly, otherwise return a durable operationId and a wait instruction before the MCP request deadline. Explicit blocking mode is capped at timeoutMs <= 60000 because MCP clients usually enforce a 60s request deadline.",
      inputSchema: {
        tool: z.string().min(1).describe("Binary name on PATH or executable path. Shells such as pwsh, powershell, bash, cmd, sh, and zsh are denied."),
        args: z.array(z.union([z.string(), z.object({ file: z.string().min(1) })])).optional().describe("Argument vector. Use {file} to replace that argument with UTF-8 file contents. Do not pass a shell command string."),
        cwd: z.string().optional().describe("Working directory for the process."),
        stdin: z.union([z.string(), z.object({ file: z.string().min(1) })]).optional().describe("Optional stdin content. Use {file} to read UTF-8 stdin content from a file."),
        timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Execution timeout in milliseconds. Auto/background default to 3600000 when omitted. Explicit blocking defaults to 60000 and rejects values above 60000 with BlockingTimeoutTooLarge because MCP clients usually time out first."),
        executionMode: z.enum(["auto", "blocking", "background"]).optional().describe("Execution mode. Defaults to auto. Auto waits briefly, then returns a durable operationId and wait instruction if the command is still running."),
      },
    },
    async (input) => {
      const { executionMode, ...runInput } = input;
      if (shouldStartBackgroundRun(executionMode)) {
        return toolTextResult(await startBackgroundRun(runInput, executionOptions));
      }

      if (shouldRunAuto(executionMode)) {
        return toolTextResult(await runAuto(runInput, autoBackgroundAfterMs, executionOptions));
      }

      if (wouldExceedDefaultMcpRequestTimeout(runInput.timeoutMs)) {
        return toolTextResult({
          ok: false,
          tool: runInput.tool,
          timingMs: 0,
          error: {
            code: "BlockingTimeoutTooLarge",
            message: `Blocking atrium.run timeoutMs must be <= ${defaultMcpRequestTimeoutMs}. Use executionMode="auto" or "background" for longer commands.`,
          },
        });
      }

      return toolTextResult(await runExecutable(runInput, executionOptions));
    },
  );

  server.registerTool(
    "run-status",
    {
      title: "Inspect a background run",
      description: "Return the current state and final result path for a background run created by the run tool. Recovers from the persisted operation snapshot when server memory no longer has the handle.",
      inputSchema: {
        runId: z.string().min(1).describe("Background run id or operationId returned by atrium.run."),
      },
    },
    async ({ runId }) => toolTextResult(await getBackgroundRun(runId)),
  );

  server.registerTool(
    "wait",
    {
      title: "Wait briefly for a background run",
      description: "Wait for a durable operationId to reach a terminal state. By default this is a bounded wait capped at 45000 ms and returns status=\"continue\" with mustReissueWait=true when the operation is still running. follow=true re-waits inside one call, but a single wait call never blocks past the 45000 ms request-safe window even with a large maxTotalWaitMs, so it cannot outlive the MCP client request deadline. Reissue wait with the same operationId until status is completed or failed.",
      inputSchema: {
        operationId: z.string().min(1).describe("Durable operation id returned by atrium.run in auto or background mode."),
        maxWaitMs: z.number().int().positive().max(defaultWaitTimeoutMs).optional().describe("Maximum wait in milliseconds. Defaults to 45000 and is capped at 45000."),
        follow: z.boolean().optional().describe("When true, keep re-waiting until the operation reaches completed or failed, bounded by the request-safe window so one call cannot hit the client deadline."),
        maxTotalWaitMs: z.number().int().positive().max(3_600_000).optional().describe("Requested follow budget in milliseconds. A single wait call is always clamped to the 45000 ms request-safe window regardless of this value; reissue wait to continue past it."),
      },
    },
    async ({ operationId, maxWaitMs, follow, maxTotalWaitMs }) => toolTextResult(await waitForBackgroundRun(operationId, {
      maxWaitMs: maxWaitMs ?? waitTimeoutMs,
      follow,
      maxTotalWaitMs,
      requestSafeWaitMs,
    })),
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
      async ({ root, query, glob, exclude, max, timeoutMs }) => toolTextResult(await runSearchAuto(
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
        autoBackgroundAfterMs,
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
    async ({ root, glob, exclude, max, timeoutMs }) => toolTextResult(await runSearchAuto(
      () => searchClient.run({
        command: "files",
        root,
        all: true,
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }).then((envelope) => normalizeXrayResult(envelope, "files")),
      autoBackgroundAfterMs,
    )),
  );

  return server;
}

async function runAuto(
  input: RunExecutableInput,
  autoBackgroundAfterMs: number,
  executionOptions: { executionQueue?: ExecutionQueue | false } = {},
): Promise<RunExecutableResult | Awaited<ReturnType<typeof adoptBackgroundRun>>> {
  const running = await startExecutableRun(withLongRunningDefault(input), executionOptions);
  const result = await waitForResultOrTimeout(running.result, autoBackgroundAfterMs);
  if (result !== undefined) {
    return result;
  }

  return adoptBackgroundRun(running);
}

async function runSearchAuto(
  search: () => Promise<unknown>,
  autoBackgroundAfterMs: number,
): Promise<unknown> {
  const startedAt = new Date().toISOString();
  const result = search();
  const completed = await waitForResultOrTimeout(result, autoBackgroundAfterMs);
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

function shouldStartBackgroundRun(executionMode: "auto" | "blocking" | "background" | undefined): boolean {
  return executionMode === "background";
}

function shouldRunAuto(executionMode: "auto" | "blocking" | "background" | undefined): boolean {
  return executionMode === undefined || executionMode === "auto";
}

function wouldExceedDefaultMcpRequestTimeout(timeoutMs: number | undefined): boolean {
  return timeoutMs !== undefined && timeoutMs > defaultMcpRequestTimeoutMs;
}

export async function startAtriumServer(): Promise<void> {
  await createAtriumServer().connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startAtriumServer();
}
