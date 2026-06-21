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
      assert.equal(started.operationId, started.runId);
      assert.equal(typeof started.runId, "string");
      assert.equal(typeof started.resultPath, "string");
      assertRecord(started.wait);
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

  it("returns a blocking-compatible result by default when the command finishes inside the auto window", async () => {
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
        executionMode: "blocking",
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

  it("auto mode returns a durable operation handle when the command is still running near the MCP deadline", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('auto-background-ok'), 100)"],
      });

      assert.equal(started.ok, true);
      assert.equal(started.status, "running");
      assert.equal(started.operationId, started.runId);
      assertString(started.operationId);
      assertRecord(started.wait);
      assert.deepEqual(started.wait.arguments, { operationId: started.operationId, follow: false });

      const completed = await callJson(client, "wait", {
        operationId: started.operationId,
        maxWaitMs: 1_000,
      });
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "auto-background-ok");
    }, { autoBackgroundAfterMs: 5, waitTimeoutMs: 1_000 });
  });

  it("wait returns continue when the operation is still running after the bounded wait", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('wait-later-ok'), 150)"],
      });
      assertString(started.operationId);

      const pending = await callJson(client, "wait", {
        operationId: started.operationId,
        maxWaitMs: 1,
      });
      assert.equal(pending.ok, true);
      assert.equal(pending.status, "continue");
      assert.equal(pending.operationId, started.operationId);
      assert.equal(pending.mustReissueWait, true);
      assertString(pending.message);
      assertRecord(pending.wait);
      assert.deepEqual(pending.wait.arguments, { operationId: started.operationId, follow: false });

      const completed = await callJson(client, "wait", {
        operationId: started.operationId,
        maxWaitMs: 1_000,
      });
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.stdout, "wait-later-ok");
    }, { autoBackgroundAfterMs: 5, waitTimeoutMs: 1_000 });
  });

  it("wait follow mode keeps re-waiting until the operation completes", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('follow-ok'), 100)"],
      });
      assertString(started.operationId);

      const completed = await callJson(client, "wait", {
        operationId: started.operationId,
        maxWaitMs: 10,
        maxTotalWaitMs: 1_000,
        follow: true,
      });
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.stdout, "follow-ok");
    }, { autoBackgroundAfterMs: 5, waitTimeoutMs: 10 });
  });

  it("wait stays inside the request-safe window even when follow uses a large maxTotalWaitMs", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('slow-follow-ok'), 1_500)"],
      });
      assertString(started.operationId);

      const startedAt = Date.now();
      const pending = await callJson(client, "wait", {
        operationId: started.operationId,
        maxWaitMs: 60,
        maxTotalWaitMs: 600_000,
        follow: true,
      });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(pending.ok, true);
      assert.equal(pending.status, "continue");
      assert.equal(pending.mustReissueWait, true);
      assert.equal(
        elapsedMs < 1_000,
        true,
        `single MCP wait blocked ${elapsedMs}ms, past the request-safe window`,
      );
    }, { autoBackgroundAfterMs: 5, waitTimeoutMs: 60, requestSafeWaitMs: 60 });
  });

  it("run-status recovers a persisted operation snapshot when the run is not in memory", async () => {
    const operationId = "atrium-test-persisted-operation";
    const directory = atriumTempPath("background-runs", operationId);
    const resultPath = join(directory, "result.json");
    await mkdir(directory, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify({
      ok: true,
      status: "completed",
      operationId,
      runId: operationId,
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

  it("run-status recovers legacy persisted snapshots that only contain runId", async () => {
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
    assert.equal(snapshot.operationId, runId);
    assert.equal(snapshot.runId, runId);
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
