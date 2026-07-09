import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPerfRecorder, type PerfOperationRecorder, type PerfOperationReport } from "../core/perf.js";

export interface McpRunOptions {
  cwd?: string;
  requestTimeoutMs?: string;
  stdin?: string;
  stdinFile?: string;
  perf?: boolean;
}

const defaultDebugRequestTimeoutMs = 60_000;

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
  const requestTimeoutMs = parseOptionalNumber(options.requestTimeoutMs, "--request-timeout-ms") ?? defaultDebugRequestTimeoutMs;
  const perfRecorder = createPerfRecorder(options.perf === true);
  const perfOperation = perfRecorder?.startOperation(randomUUID());
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

export async function mcpOperationWaitCommand(operationId: string): Promise<void> {
  const response = await withAtriumClient((client) => client.callTool({
    name: "operation-wait",
    arguments: {
      operationId,
    },
  }));
  writeToolResponse(response);
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
