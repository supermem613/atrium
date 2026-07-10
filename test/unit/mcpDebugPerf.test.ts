import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";

interface RunMetrics {
  childTool: string;
  exitCode: number;
  signal: null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdinBytes: number;
  argCount: number;
  argShape: string[];
  semantic: {
    kind: string;
    commandLength: number;
  };
}

interface PerfReport {
  operationId: string;
}

interface RunPayload {
  ok: boolean;
  tool: string;
  stdout: string;
  timingMs: number;
  metrics: RunMetrics;
  perf?: PerfReport;
}

describe("mcp debug perf contract", () => {
  it("keeps the current CLI mcp-run output shape unchanged without --perf", () => {
    const cliPath = join(process.cwd(), "dist", "cli.js");
    const result = spawnSync(process.execPath, [
      cliPath,
      "mcp-run",
      process.execPath,
      "--",
      "-e",
      "process.stdout.write('hello')",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = parseJsonPayload(result.stdout);

    assert.equal(payload.ok, true);
    assert.equal(typeof payload.tool, "string");
    assert.ok(payload.tool.length > 0);
    assert.equal(payload.stdout, "hello");
    assert.equal(typeof payload.timingMs, "number");
    assert.equal(typeof payload.metrics.childTool, "string");
    assert.ok(payload.metrics.childTool.length > 0);
    assert.equal(payload.metrics.exitCode, 0);
    assert.equal(payload.metrics.signal, null);
    assert.equal(payload.metrics.timedOut, false);
    assert.equal(payload.metrics.stdoutBytes, 5);
    assert.equal(payload.metrics.stderrBytes, 0);
    assert.equal(payload.metrics.stdinBytes, 0);
    assert.equal(payload.metrics.argCount, 2);
    assert.deepEqual(payload.metrics.argShape, ["flag", "flag-value"]);
    assert.equal(payload.metrics.semantic.kind, "generic.command");
    assert.equal(payload.metrics.semantic.commandLength, 2);
    assert.equal(payload.perf, undefined);
  });

  it("emits a per-operation perf object when CLI mcp-run is invoked with --perf", () => {
    const cliPath = join(process.cwd(), "dist", "cli.js");
    const result = spawnSync(process.execPath, [
      cliPath,
      "mcp-run",
      "--perf",
      process.execPath,
      "--",
      "-e",
      "process.stdout.write('hello')",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = parseJsonPayload(result.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.stdout, "hello");
    assert.equal(typeof payload.perf, "object");
    assert.notEqual(payload.perf, null);
    if (payload.perf === undefined || payload.perf === null) {
      throw new Error("expected perf report");
    }
    assert.equal(typeof payload.perf.operationId, "string");
  });

  it("returns the stable high-level run response shape for normal MCP client calls", async () => {
    await withInMemoryClient(async (client) => {
      const response = await client.callTool({
        name: "run",
        arguments: {
          tool: process.execPath,
          args: ["-e", "process.stdout.write('hello')"],
        },
      });
      const payload = readToolPayload(response);

      assert.equal(payload.ok, true);
      assert.equal(typeof payload.tool, "string");
      assert.ok(payload.tool.length > 0);
      assert.equal(payload.stdout, "hello");
      assert.equal(typeof payload.timingMs, "number");
      assert.equal(typeof payload.metrics.childTool, "string");
      assert.ok(payload.metrics.childTool.length > 0);
      assert.equal(payload.metrics.exitCode, 0);
      assert.equal(payload.metrics.signal, null);
      assert.equal(payload.metrics.timedOut, false);
      assert.equal(payload.metrics.stdoutBytes, 5);
      assert.equal(payload.metrics.stderrBytes, 0);
      assert.equal(payload.metrics.stdinBytes, 0);
      assert.equal(payload.metrics.argCount, 2);
      assert.deepEqual(payload.metrics.argShape, ["flag", "flag-value"]);
      assert.equal(payload.metrics.semantic.kind, "generic.command");
      assert.equal(payload.metrics.semantic.commandLength, 2);
    });
  });
});

function parseJsonPayload(stdout: string): RunPayload {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, "", "expected CLI output");
  return JSON.parse(trimmed) as RunPayload;
}

function readToolPayload(response: Awaited<ReturnType<Client["callTool"]>>): RunPayload {
  if (!("content" in response) || !Array.isArray(response.content)) {
    throw new Error("Expected MCP tool text content");
  }

  const firstContent = response.content[0];
  assert.equal(firstContent.type, "text");
  assert.equal(typeof firstContent.text, "string");
  return JSON.parse(firstContent.text) as RunPayload;
}

async function withInMemoryClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-test", version: "0.5.0" });
  const server = createAtriumServer();

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}
