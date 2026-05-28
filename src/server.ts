#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { introspectTool } from "./core/introspect.js";
import { getBackgroundRun, startBackgroundRun } from "./core/backgroundRuns.js";
import { runExecutable } from "./core/runner.js";
import { toolTextResult } from "./mcp/format.js";

const mcpDefaultRequestTimeoutMs = 60_000;
const backgroundAutoBufferMs = 5_000;

export function createAtriumServer(): McpServer {
  const server = new McpServer({
    name: "atrium",
    version: "0.3.0",
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
      description: "Execute named CLIs with structured args and structured JSON returns. Output is materialized to disk and returned as paths plus byte counts. Prefer this over powershell when invoking CLIs or executables.",
      inputSchema: {
        tool: z.string().min(1).describe("Binary name on PATH or executable path. Shells such as pwsh, powershell, bash, cmd, sh, and zsh are denied."),
        args: z.array(z.union([z.string(), z.object({ file: z.string().min(1) })])).optional().describe("Argument vector. Use {file} to replace that argument with UTF-8 file contents. Do not pass a shell command string."),
        cwd: z.string().optional().describe("Working directory for the process."),
        stdin: z.union([z.string(), z.object({ file: z.string().min(1) })]).optional().describe("Optional stdin content. Use {file} to read UTF-8 stdin content from a file."),
        timeoutMs: z.number().int().positive().max(3_600_000).optional().describe("Execution timeout in milliseconds. Defaults to 120000."),
        executionMode: z.enum(["auto", "blocking", "background"]).optional().describe("Execution mode. Defaults to auto, which returns a background run handle when timeoutMs may exceed the default MCP request deadline. Use blocking to wait for the final run envelope."),
      },
    },
    async (input) => {
      const { executionMode, ...runInput } = input;
      if (shouldStartBackgroundRun(executionMode, runInput.timeoutMs)) {
        return toolTextResult(await startBackgroundRun(runInput));
      }

      return toolTextResult(await runExecutable(runInput));
    },
  );

  server.registerTool(
    "run-status",
    {
      title: "Inspect a background run",
      description: "Return the current state and final result path for a background run created by the run tool.",
      inputSchema: {
        runId: z.string().min(1).describe("Background run id returned by atrium.run."),
      },
    },
    async ({ runId }) => toolTextResult(getBackgroundRun(runId)),
  );

  return server;
}

function shouldStartBackgroundRun(executionMode: "auto" | "blocking" | "background" | undefined, timeoutMs: number | undefined): boolean {
  if (executionMode === "background") {
    return true;
  }

  if (executionMode === "blocking") {
    return false;
  }

  return (timeoutMs ?? 120_000) > mcpDefaultRequestTimeoutMs - backgroundAutoBufferMs;
}

export async function startAtriumServer(): Promise<void> {
  await createAtriumServer().connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startAtriumServer();
}
