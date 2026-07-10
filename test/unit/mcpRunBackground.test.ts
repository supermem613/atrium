import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { setImmediate } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AtriumServerOptions, createAtriumServer } from "../../src/server.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";
import { adoptBackgroundRun, getBackgroundRun, waitForBackgroundRun } from "../../src/core/backgroundRuns.js";
import { startExecutableRun } from "../../src/core/runner.js";

describe("MCP run handoff", () => {
  it("hands off a durable operation with a prescriptive operation-wait nextCheck when the command is still running past the handoff window", async () => {
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
        tool: "atrium.operation-wait",
        arguments: { operationId: started.operationId },
        callInMs: 0,
      });
      assertString(started.message);

      const completed = await waitForOperation(client, started.operationId);
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

  it("does not expose timeoutMs in the agent-facing run schema", async () => {
    await withInMemoryClient(async (client) => {
      const listedTools = await client.listTools();
      const runTool = listedTools.tools.find((tool) => tool.name === "run");
      assert.ok(runTool, "expected run tool to be listed");

      const inputSchema = runTool.inputSchema as Record<string, unknown>;
      const properties = inputSchema.properties as Record<string, unknown> | undefined;
      assert.ok(properties, "run should expose properties");
      assert.equal(properties.timeoutMs, undefined);
    });
  });

  it("operation-wait returns continue when the operation is still running after the bounded wait", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('still-running-ok'), 150)"],
      });
      assertString(started.operationId);

      const pending = await callJson(client, "operation-wait", { operationId: started.operationId });
      assert.equal(pending.ok, true);
      assert.equal(pending.status, "continue");
      assert.equal(pending.operationId, started.operationId);
      assert.equal(pending.mustReissueWait, true);
      assert.deepEqual(pending.nextCheck, {
        tool: "atrium.operation-wait",
        arguments: { operationId: started.operationId },
        callInMs: 0,
      });
      assertString(pending.message);

      const completed = await waitForOperation(client, started.operationId);
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.stdout, "still-running-ok");
    }, { backgroundHandoffAfterMs: 5, waitTimeoutMs: 1 });
  });

  it("operation-wait returns emitted stdout and stderr progress while the operation is still running", async () => {
    await withInMemoryClient(async (client) => {
      const started = await callJson(client, "run", {
        tool: process.execPath,
        args: [
          "-e",
          "process.stdout.write('progress-stdout'); process.stderr.write('progress-stderr'); setTimeout(() => {}, 500)",
        ],
      });
      assertString(started.operationId);

      const deadline = Date.now() + 5_000;
      let pending: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        pending = await callJson(client, "operation-wait", { operationId: started.operationId });
        if (pending.status === "continue") {
          const stdout = typeof pending.stdout === "string" ? pending.stdout : "";
          const stderr = typeof pending.stderr === "string" ? pending.stderr : "";
          if (stdout.includes("progress-stdout") && stderr.includes("progress-stderr")) {
            break;
          }
        }
        await setImmediate();
      }

      assert.ok(pending, "expected operation-wait to return a snapshot");
      assert.equal(pending.ok, true);
      assert.equal(pending.status, "continue");
      assert.equal(typeof pending.stdout === "string" && pending.stdout.includes("progress-stdout"), true);
      assert.equal(typeof pending.stderr === "string" && pending.stderr.includes("progress-stderr"), true);

      const completed = await waitForOperation(client, started.operationId);
      const result = completed.result;
      assertRecord(result);
      assert.equal(completed.status, "completed");
      assert.equal(result.stdout, "progress-stdout");
      assert.equal(result.stderr, "progress-stderr");
    }, { backgroundHandoffAfterMs: 5, waitTimeoutMs: 1 });
  });

  it("cancels abandoned progress wait registrations when a bounded wait times out", async () => {
    const running = await startExecutableRun({
      tool: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1_000)"],
    });
    const debugHandle = running as unknown as { __debugActiveProgressWaitRegistrationCount: () => number };
    assert.equal(debugHandle.__debugActiveProgressWaitRegistrationCount(), 0);

    const handle = await adoptBackgroundRun(running);
    const waited = await waitForBackgroundRun(handle.operationId, { requestSafeWaitMs: 1 });

    assert.equal(waited.ok, true);
    assert.equal(waited.status, "continue");
    assert.equal(debugHandle.__debugActiveProgressWaitRegistrationCount(), 0);
  });

  it("operation-wait recovers a persisted operation snapshot when the run is not in memory", async () => {
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

  it("internal recovery supports legacy persisted snapshots that only contain runId", async () => {
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

async function waitForOperation(client: Client, operationId: unknown): Promise<Record<string, unknown>> {
  assertString(operationId);
  const deadline = Date.now() + 5_000;
  let snapshot = await callJson(client, "operation-wait", { operationId });
  while (snapshot.status === "continue" && Date.now() < deadline) {
    await setImmediate();
    snapshot = await callJson(client, "operation-wait", { operationId });
  }

  assert.notEqual(snapshot.status, "continue");
  return snapshot;
}
