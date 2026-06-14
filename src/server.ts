#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { introspectTool } from "./core/introspect.js";
import { adoptBackgroundRun, defaultWaitTimeoutMs, getBackgroundRun, startBackgroundRun, waitForBackgroundRun, withLongRunningDefault } from "./core/backgroundRuns.js";
import { runExecutable, RunExecutableInput, RunExecutableResult, startExecutableRun } from "./core/runner.js";
import { toolTextResult } from "./mcp/format.js";

const defaultMcpRequestTimeoutMs = 60_000;
const defaultAutoBackgroundAfterMs = 45_000;

export interface AtriumServerOptions {
  autoBackgroundAfterMs?: number;
  waitTimeoutMs?: number;
}

export function createAtriumServer(options: AtriumServerOptions = {}): McpServer {
  const autoBackgroundAfterMs = options.autoBackgroundAfterMs ?? defaultAutoBackgroundAfterMs;
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  const server = new McpServer({
    name: "atrium",
    version: "0.5.0",
  });

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
      return toolTextResult(await introspectTool(tool));
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
        return toolTextResult(await startBackgroundRun(runInput));
      }

      if (shouldRunAuto(executionMode)) {
        return toolTextResult(await runAuto(runInput, autoBackgroundAfterMs));
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

      return toolTextResult(await runExecutable(runInput));
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
      description: "Wait for a durable operationId to reach a terminal state. By default this is a bounded wait capped at 45000 ms and returns status=\"continue\" with mustReissueWait=true when the operation is still running. Set follow=true to keep re-waiting inside one MCP tool call until the operation finishes or maxTotalWaitMs is reached.",
      inputSchema: {
        operationId: z.string().min(1).describe("Durable operation id returned by atrium.run in auto or background mode."),
        maxWaitMs: z.number().int().positive().max(defaultWaitTimeoutMs).optional().describe("Maximum wait in milliseconds. Defaults to 45000 and is capped at 45000."),
        follow: z.boolean().optional().describe("When true, keep re-waiting until the operation reaches completed or failed, or until maxTotalWaitMs is reached."),
        maxTotalWaitMs: z.number().int().positive().max(3_600_000).optional().describe("Total follow budget in milliseconds. Defaults to maxWaitMs when follow is false, and is capped at 3600000."),
      },
    },
    async ({ operationId, maxWaitMs, follow, maxTotalWaitMs }) => toolTextResult(await waitForBackgroundRun(operationId, {
      maxWaitMs: maxWaitMs ?? waitTimeoutMs,
      follow,
      maxTotalWaitMs,
    })),
  );

  return server;
}

async function runAuto(
  input: RunExecutableInput,
  autoBackgroundAfterMs: number,
): Promise<RunExecutableResult | Awaited<ReturnType<typeof adoptBackgroundRun>>> {
  const running = await startExecutableRun(withLongRunningDefault(input));
  const result = await waitForResultOrTimeout(running.result, autoBackgroundAfterMs);
  if (result !== undefined) {
    return result;
  }

  return adoptBackgroundRun(running);
}

async function waitForResultOrTimeout(result: Promise<RunExecutableResult>, timeoutMs: number): Promise<RunExecutableResult | undefined> {
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
