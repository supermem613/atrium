import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { setImmediate } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AtriumServerOptions, createAtriumServer } from "../../src/server.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";
import { getBackgroundRun } from "../../src/core/backgroundRuns.js";

describe("MCP run handoff", () => {
  it("hands off a durable operation with a prescriptive nextCheck when the command is still running past the handoff window", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('handoff-ok'), 100)"],
      });

      assert.equal(started.ok, true);
      assert.equal(started.status, "running");
      assertString(started.operationId);
      assertString(started.resultPath);
      assert.equal(started.resultPath.startsWith(atriumTempPath("background-runs")), true);
      assert.deepEqual(started.nextCheck, {
        tool: "atrium.operation-status",
        arguments: { operationId: started.operationId },
        callInMs: 60_000,
      });
      assertString(started.message);

      const completed = await pollOperationStatus(client, started.operationId);
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "handoff-ok");
    }, { backgroundHandoffAfterMs: 5 });
  });

  it("returns the result inline when the command finishes inside the handoff window", async () => {
    await withInMemoryClient(async (client) => {
      const result = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('inline-ok')"],
      });

      assert.equal(result.ok, true);
      assert.equal(result.stdout, "inline-ok");
      assert.equal(result.operationId, undefined);
      assert.equal(result.nextCheck, undefined);
    });
  });

  it("accepts a timeoutMs above the old blocking cap and returns a normal result", async () => {
    await withInMemoryClient(async (client) => {
      const result = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('big-timeout-ok')"],
        timeoutMs: 60_001,
      });

      assert.equal(result.ok, true);
      assert.equal(result.stdout, "big-timeout-ok");
      assert.equal(result.operationId, undefined);
    });
  });

  it("operation-status returns the prescriptive handle while the operation is still running", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('still-running-ok'), 150)"],
      });
      assertString(started.operationId);

      const status = await callJson(client, "operation-status", { operationId: started.operationId });
      assert.equal(status.ok, true);
      assert.equal(status.status, "running");
      assert.equal(status.operationId, started.operationId);
      assert.deepEqual(status.nextCheck, {
        tool: "atrium.operation-status",
        arguments: { operationId: started.operationId },
        callInMs: 60_000,
      });
      assertString(status.message);

      const completed = await pollOperationStatus(client, started.operationId);
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.stdout, "still-running-ok");
    }, { backgroundHandoffAfterMs: 5 });
  });

  it("operation-status recovers a persisted operation snapshot when the run is not in memory", async () => {
    const operationId = "atrium-test-persisted-operation";
    const directory = atriumTempPath("background-runs", operationId);
    const resultPath = join(directory, "result.json");
    await mkdir(directory, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify({
      ok: true,
      status: "completed",
      operationId,
      resultPath,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      result: {
        ok: true,
        tool: "node",
        timingMs: 1,
        metrics: {
          childTool: "node",
          durationMs: 1,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutBytes: 2,
          stderrBytes: 0,
          stdinBytes: 0,
          argCount: 0,
          argHash: "test",
          argShape: [],
        },
        stdout: "ok",
      },
    })}\n`, "utf8");

    const snapshot = await getBackgroundRun(operationId);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.operationId, operationId);
    assertRecord(snapshot.result);
    assert.equal(snapshot.result.stdout, "ok");
  });

  it("operation-status recovers legacy persisted snapshots that only contain runId", async () => {
    const runId = "atrium-test-legacy-run";
    const directory = atriumTempPath("background-runs", runId);
    const resultPath = join(directory, "result.json");
    await mkdir(directory, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify({
      ok: true,
      status: "completed",
      runId,
      resultPath,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    })}\n`, "utf8");

    const snapshot = await getBackgroundRun(runId);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.operationId, runId);
  });

  it("rejects operation ids that are not safe path segments", async () => {
    const snapshot = await getBackgroundRun("..\\outside");
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.status, "failed");
    assertRecord(snapshot.error);
    assert.equal(snapshot.error.code, "UnknownRun");
    assert.equal(snapshot.resultPath, "");
  });
});

async function withInMemoryClient<T>(callback: (client: Client) => Promise<T>, options?: AtriumServerOptions): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-test", version: "0.5.0" });
  const server = createAtriumServer(options);

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

async function pollOperationStatus(client: Client, operationId: unknown): Promise<Record<string, unknown>> {
  assertString(operationId);
  const deadline = Date.now() + 5_000;
  let snapshot = await callJson(client, "operation-status", { operationId });
  while (snapshot.status === "running" && Date.now() < deadline) {
    await setImmediate();
    snapshot = await callJson(client, "operation-status", { operationId });
  }

  assert.notEqual(snapshot.status, "running");
  return snapshot;
}
