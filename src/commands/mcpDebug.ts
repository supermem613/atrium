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

async function withAtriumClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  const client = new Client({ name: "atrium-cli-debug", version: "0.3.0" });
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
  const response = await withAtriumClient((client) => client.callTool({
    name: "run",
    arguments: {
      tool,
      args: args ?? [],
      cwd: options.cwd,
      stdin: options.stdinFile === undefined ? options.stdin : { file: options.stdinFile },
      timeoutMs,
      executionMode,
    },
  }, CallToolResultSchema, { timeout: requestTimeoutMs }));
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

function writeToolResponse(response: Awaited<ReturnType<Client["callTool"]>>): void {
  if (!("content" in response) || !Array.isArray(response.content)) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }

  const firstContent = response.content[0];
  if (!isTextContent(firstContent)) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }

  process.stdout.write(`${firstContent.text}\n`);
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

function parseExecutionMode(value: string | undefined): "blocking" | "background" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "blocking" || value === "background") {
    return value;
  }

  throw new Error("--execution-mode must be blocking or background");
}

function requestTimeoutForRun(timeoutMs: number | undefined): number {
  return timeoutMs === undefined ? 60_000 : timeoutMs + 1_000;
}
