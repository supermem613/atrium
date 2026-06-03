import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface McpRunOptions {
  cwd?: string;
  timeoutMs?: string;
  requestTimeoutMs?: string;
  executionMode?: string;
  stdin?: string;
  stdinFile?: string;
}

interface McpWaitOptions {
  maxWaitMs?: string;
  requestTimeoutMs?: string;
}

async function withAtriumClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  const client = new Client({ name: "atrium-cli-debug", version: "0.5.0" });
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

export async function mcpSchemaCommand(tool: string): Promise<void> {
  const response = await withAtriumClient((client) => client.callTool({ name: "schema", arguments: { tool } }));
  writeToolResponse(response);
}

export async function mcpRunCommand(tool: string, args: string[] | undefined, options: McpRunOptions): Promise<void> {
  const timeoutMs = parseOptionalNumber(options.timeoutMs, "--timeout-ms");
  const requestTimeoutMs = parseOptionalNumber(options.requestTimeoutMs, "--request-timeout-ms") ?? requestTimeoutForRun(timeoutMs);
  const executionMode = parseExecutionMode(options.executionMode);
  const response = await withAtriumClient(async (client) => {
    const runResponse = await client.callTool({
      name: "run",
      arguments: {
        tool,
        args: args ?? [],
        cwd: options.cwd,
        stdin: options.stdinFile === undefined ? options.stdin : { file: options.stdinFile },
        timeoutMs,
        executionMode,
      },
    }, CallToolResultSchema, { timeout: requestTimeoutMs });
    const runPayload = readToolPayload(runResponse);
    if (!isRunningPayload(runPayload)) {
      return runResponse;
    }

    return waitForDebugRun(client, runPayload.operationId, requestTimeoutMs);
  });
  writeToolResponse(response);
}

export async function mcpRunStatusCommand(runId: string): Promise<void> {
  const response = await withAtriumClient((client) => client.callTool({
    name: "run-status",
    arguments: {
      runId,
    },
  }));
  writeToolResponse(response);
}

export async function mcpWaitCommand(operationId: string, options: McpWaitOptions): Promise<void> {
  const maxWaitMs = parseOptionalNumber(options.maxWaitMs, "--max-wait-ms");
  const requestTimeoutMs = parseOptionalNumber(options.requestTimeoutMs, "--request-timeout-ms") ?? ((maxWaitMs ?? 45_000) + 5_000);
  const response = await withAtriumClient((client) => client.callTool({
    name: "wait",
    arguments: {
      operationId,
      maxWaitMs,
    },
  }, CallToolResultSchema, { timeout: requestTimeoutMs }));
  writeToolResponse(response);
}

function writeToolResponse(response: Awaited<ReturnType<Client["callTool"]>>): void {
  const payload = readToolPayload(response);
  if (payload !== undefined) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(response)}\n`);
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

function parseExecutionMode(value: string | undefined): "auto" | "blocking" | "background" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "auto" || value === "blocking" || value === "background") {
    return value;
  }

  throw new Error("--execution-mode must be auto, blocking, or background");
}

function requestTimeoutForRun(timeoutMs: number | undefined): number {
  return timeoutMs === undefined ? 60_000 : timeoutMs + 1_000;
}

async function waitForDebugRun(client: Client, operationId: string, requestTimeoutMs: number): ReturnType<Client["callTool"]> {
  const deadline = Date.now() + requestTimeoutMs;
  let waitMs = nextDebugWaitMs(deadline);
  let response = await client.callTool({
    name: "wait",
    arguments: {
      operationId,
      maxWaitMs: waitMs,
    },
  }, CallToolResultSchema, { timeout: waitMs + 1_000 });

  while (Date.now() < deadline) {
    const payload = readToolPayload(response);
    if (!isContinuePayload(payload)) {
      return response;
    }

    waitMs = nextDebugWaitMs(deadline);
    response = await client.callTool({
      name: "wait",
      arguments: {
        operationId,
        maxWaitMs: waitMs,
      },
    }, CallToolResultSchema, { timeout: waitMs + 1_000 });
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

function nextDebugWaitMs(deadline: number): number {
  return Math.max(1, Math.min(45_000, deadline - Date.now() - 1_000));
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
