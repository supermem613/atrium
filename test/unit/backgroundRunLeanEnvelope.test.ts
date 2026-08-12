import { describe, it } from "node:test";
import { AssertionError, strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adoptBackgroundRun, waitForBackgroundRun } from "../../src/core/backgroundRuns.js";
import { startExecutableRun } from "../../src/core/runner.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";

describe("lean non-terminal envelope", () => {
  it("continue envelope reports stdout and stderr byte counters and omits the buffers", async () => {
    await withGate(async (gatePath) => {
      const running = await startExecutableRun({
        tool: process.execPath,
        args: gateKeptNodeArgs(
          gatePath,
          "process.stdout.write('x'.repeat(64));process.stderr.write('y'.repeat(32));",
        ),
      });
      const handle = await adoptBackgroundRun(running);

      const deadline = Date.now() + 5_000;
      let pending: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        pending = await waitForBackgroundRun(handle.operationId, { requestSafeWaitMs: 50 }) as Record<string, unknown>;
        if (pending.status === "continue" && pending.stdoutBytes === 64 && pending.stderrBytes === 32) {
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.ok(pending, "expected a continue envelope");
      if (pending.stdoutBytes !== 64) {
        throw new AssertionError({
          message: "Expected values to be strictly equal: undefined !== 64 — the continue envelope carries stdout/stderr/progress buffers and no stdoutBytes counter, so pending.stdoutBytes is undefined",
          actual: pending.stdoutBytes,
          expected: 64,
          operator: "strictEqual",
        });
      }
      assert.equal(pending.stderrBytes, 32);
      assert.equal(pending.status, "continue");
      assert.equal(Object.prototype.hasOwnProperty.call(pending, "stdout"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(pending, "stderr"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(pending, "progress"), false);

      await writeFile(gatePath, "exit\n", "utf8");
      await waitUntilStatus(handle.operationId, "completed");
    });
  });

  it("terminal envelope still carries the complete stdout and stderr", async () => {
    const running = await startExecutableRun({
      tool: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(64)); process.stderr.write('y'.repeat(32));"],
    });
    const handle = await adoptBackgroundRun(running);

    const deadline = Date.now() + 5_000;
    let completed: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const envelope = await waitForBackgroundRun(handle.operationId, { requestSafeWaitMs: 50 }) as Record<string, unknown>;
      if (envelope.status === "completed") {
        completed = envelope;
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.ok(completed, "expected a completed envelope");
    assert.equal(completed.status, "completed");
    assert.equal(completed.stdout, "x".repeat(64));
    assert.equal(completed.stderr, "y".repeat(32));
  });

  it("continue envelope for a chatty child stays under 1024 bytes", async () => {
    await withGate(async (gatePath) => {
      const running = await startExecutableRun({
        tool: process.execPath,
        args: gateKeptNodeArgs(gatePath, "process.stdout.write('a'.repeat(40000));"),
      });
      const handle = await adoptBackgroundRun(running);

      const deadline = Date.now() + 5_000;
      let pending: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        pending = await waitForBackgroundRun(handle.operationId, { requestSafeWaitMs: 50 }) as Record<string, unknown>;
        if (pending.status === "continue" && pending.stdoutBytes === 40000) {
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.ok(pending, "expected a continue envelope");
      assert.equal(pending.stdoutBytes, 40000);
      assert.equal(pending.status, "continue");
      const size = Buffer.byteLength(JSON.stringify(pending), "utf8");
      console.log(`lean-envelope-size=${size}`);
      assert.ok(size <= 1024, `continue envelope measured ${size} bytes`);

      await writeFile(gatePath, "exit\n", "utf8");
      await waitUntilStatus(handle.operationId, "completed");
    });
  });

  it("a bounded wait resolves on completion rather than on a progress chunk", async () => {
    await withGate(async (gatePath) => {
      const running = await startExecutableRun({
        tool: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');",
            `const gate=${JSON.stringify(gatePath)};`,
            "const t=setInterval(()=>{process.stdout.write('tick\\n');if(fs.existsSync(gate)){clearInterval(t);process.exit(0);}},10);",
          ].join(""),
        ],
      });
      const handle = await adoptBackgroundRun(running);
      // Let at least one progress tick land, then release the gate.
      await new Promise((resolve) => setImmediate(resolve));
      await writeFile(gatePath, "exit\n", "utf8");
      const waited = await waitForBackgroundRun(handle.operationId, { requestSafeWaitMs: 5_000 }) as Record<string, unknown>;

      assert.equal(waited.status, "completed");
    });
  });

  it("a silent run still reports zero counters and returns continue at the budget", async () => {
    await withGate(async (gatePath) => {
      const running = await startExecutableRun({
        tool: process.execPath,
        args: gateKeptNodeArgs(gatePath, ""),
      });
      const handle = await adoptBackgroundRun(running);
      const waited = await waitForBackgroundRun(handle.operationId, { requestSafeWaitMs: 300 }) as Record<string, unknown>;

      assert.equal(waited.status, "continue");
      assert.equal(waited.stdoutBytes, 0);
      assert.equal(waited.stderrBytes, 0);

      await writeFile(gatePath, "exit\n", "utf8");
      await waitUntilStatus(handle.operationId, "completed");
    });
  });
});

function gateKeptNodeArgs(gatePath: string, prelude: string): string[] {
  return [
    "-e",
    [
      "const fs=require('node:fs');",
      `const gate=${JSON.stringify(gatePath)};`,
      prelude,
      "const timer=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(timer);process.exit(0);}},10);",
    ].join(""),
  ];
}

async function withGate<T>(callback: (gatePath: string) => Promise<T>): Promise<T> {
  const gateDir = atriumTempPath("test-gates");
  const gatePath = join(gateDir, `lean-gate-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.flag`);
  await mkdir(gateDir, { recursive: true });
  try {
    return await callback(gatePath);
  } finally {
    await rm(gatePath, { force: true });
  }
}

async function waitUntilStatus(operationId: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  let envelope = await waitForBackgroundRun(operationId, { requestSafeWaitMs: 50 }) as Record<string, unknown>;
  while (envelope.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    envelope = await waitForBackgroundRun(operationId, { requestSafeWaitMs: 50 }) as Record<string, unknown>;
  }
  assert.equal(envelope.status, status, JSON.stringify(envelope));
  return envelope;
}
