import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface McpRunOptions {
  cwd?: string;
  timeoutMs?: string;
  requestTimeoutMs?: string;
  stdin?: string;
  stdinFile?: string;
}

// The debug command polls the instant in-memory operation-status read, so it uses a
// short interval to observe completion quickly rather than the one-minute nextCheck
// cadence meant for remote MCP agents. The loop is bounded by requestTimeoutMs.
const debugPollIntervalMs = 200;

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

export async function mcpSchemaCommand(tool: string): Promise<void> {
  const response = await withAtriumClient((client) => client.callTool({ name: "schema", arguments: { tool } }));
  writeToolResponse(response);
}

export async function mcpRunCommand(tool: string, args: string[] | undefined, options: McpRunOptions): Promise<void> {
  const timeoutMs = parseOptionalNumber(options.timeoutMs, "--timeout-ms");
  const requestTimeoutMs = parseOptionalNumber(options.requestTimeoutMs, "--request-timeout-ms") ?? requestTimeoutForRun(timeoutMs);
  const response = await withAtriumClient(async (client) => {
    const runResponse = await client.callTool({
      name: "run",
      arguments: {
        tool,
        args: args ?? [],
        cwd: options.cwd,
        stdin: options.stdinFile === undefined ? options.stdin : { file: options.stdinFile },
        timeoutMs,
      },
    }, CallToolResultSchema, { timeout: requestTimeoutMs });
    const runPayload = readToolPayload(runResponse);
    if (!isRunningPayload(runPayload)) {
      return runResponse;
    }

    return pollForDebugOperation(client, runPayload.operationId, requestTimeoutMs);
  });
  writeToolResponse(response);
}

export async function mcpOperationStatusCommand(operationId: string): Promise<void> {
  const response = await withAtriumClient((client) => client.callTool({
    name: "operation-status",
    arguments: {
      operationId,
    },
  }));
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

function requestTimeoutForRun(timeoutMs: number | undefined): number {
  return timeoutMs === undefined ? 60_000 : timeoutMs + 1_000;
}

async function pollForDebugOperation(client: Client, operationId: string, requestTimeoutMs: number): ReturnType<Client["callTool"]> {
  const deadline = Date.now() + requestTimeoutMs;
  let response = await callOperationStatus(client, operationId, requestTimeoutMs);

  while (Date.now() < deadline) {
    const payload = readToolPayload(response);
    if (!isRunningPayload(payload)) {
      return response;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(debugPollIntervalMs, remainingMs));
    response = await callOperationStatus(client, operationId, requestTimeoutMs);
  }

  return textToolResponse({
    ok: false,
    status: "failed",
    operationId,
    error: {
      code: "DebugWaitTimeout",
      message: `Local mcp-run debug command stopped polling for operationId=${operationId}. Re-run with --request-timeout-ms if you need a longer debug wait.`,
    },
  });
}

async function callOperationStatus(client: Client, operationId: string, requestTimeoutMs: number): ReturnType<Client["callTool"]> {
  return client.callTool({
    name: "operation-status",
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
