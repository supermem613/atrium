import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { setImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";

describe("MCP run background mode", () => {
  it("returns a background handle when explicitly requested", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('async-ok')"],
        executionMode: "background",
      });

      assert.equal(started.ok, true);
      assert.equal(started.status, "running");
      assert.equal(typeof started.runId, "string");
      assert.equal(typeof started.resultPath, "string");
      assertString(started.resultPath);
      assert.equal(started.resultPath.startsWith(atriumTempPath("background-runs")), true);

      const runId = started.runId;
      assertString(runId);
      const completed = await waitForCompletion(client, runId);
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "async-ok");
    });
  });

  it("blocks by default", async () => {
    await withInMemoryClient(async (client) => {
      const result = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('blocking-ok')"],
      });

      assert.equal(result.ok, true);
      assert.equal(result.stdout, "blocking-ok");
      assert.equal(result.runId, undefined);
    });
  });

  it("keeps an explicit blocking mode for callers that set it", async () => {
    await withInMemoryClient(async (client) => {
      const result = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('explicit-blocking-ok')"],
        executionMode: "blocking",
      });

      assert.equal(result.ok, true);
      assert.equal(result.stdout, "explicit-blocking-ok");
      assert.equal(result.runId, undefined);
    });
  });

  it("fails fast for blocking timeouts that exceed the default MCP request deadline", async () => {
    await withInMemoryClient(async (client) => {
      const result = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('late'), 10)"],
        timeoutMs: 60_001,
      });

      assert.equal(result.ok, false);
      assert.equal(result.runId, undefined);
      assertRecord(result.error);
      assert.equal(result.error.code, "BlockingTimeoutTooLarge");
    });
  });

  it("allows long timeouts when callers explicitly use background mode", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('long-background-ok')"],
        timeoutMs: 60_001,
        executionMode: "background",
      });

      assert.equal(started.ok, true);
      assert.equal(started.status, "running");
      assertString(started.runId);
      const completed = await waitForCompletion(client, started.runId);
      const result = completed.result;
      assertRecord(result);
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "long-background-ok");
    });
  });
});

async function withInMemoryClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-test", version: "0.3.0" });
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

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  if (!("content" in response) || !Array.isArray(response.content)) {
    throw new Error("Expected MCP tool text content.");
  }

  const firstContent = response.content[0];
  assertRecord(firstContent);
  assert.equal(firstContent.type, "text");
  assertString(firstContent.text);
  return JSON.parse(firstContent.text) as Record<string, unknown>;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

function assertString(value: unknown): asserts value is string {
  assert.equal(typeof value, "string");
}

async function waitForCompletion(client: Client, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  let snapshot = await callJson(client, "run-status", { runId });
  while (snapshot.status === "running" && Date.now() < deadline) {
    await setImmediate();
    snapshot = await callJson(client, "run-status", { runId });
  }

  assert.notEqual(snapshot.status, "running");
  return snapshot;
}
