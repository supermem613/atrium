import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  mcpFindFilesCommand,
  mcpGrepCodeCommand,
  mcpGrepCommand,
  mcpOperationWaitCommand,
  mcpRunCommand,
} from "../../src/commands/mcpDebug.js";
import { defaultLongRunningTimeoutMs } from "../../src/core/backgroundRuns.js";
import type { RunExecutableInput, RunExecutableResult } from "../../src/core/runner.js";
import type { XraySearchClientLike } from "../../src/core/search/types.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";

describe("CLI perf spans and search metrics", { concurrency: false }, () => {
  it("mcp-read --perf reports stat, read, slice, and materialize spans", async () => {
    const fixture = await withTempFile("alpha\nbeta\ngamma\n");
    const payload = runCliJson([
      "mcp-read",
      "--perf",
      fixture.filePath,
      "--start-line",
      "2",
      "--end-line",
      "3",
    ]);

    assert.equal(payload.ok, true);
    const perf = readPerfReport(payload);
    assertPerfReport(perf, ["stat", "read", "slice", "materialize"]);
  });

  it("mcp-run --perf reports queue, spawn, materialize, and semantic metric attributes", () => {
    const payload = runCliJson([
      "mcp-run",
      "--perf",
      process.execPath,
      "--",
      "-e",
      "process.stdout.write('hello')",
    ]);

    assert.equal(payload.ok, true);
    const perf = readPerfReport(payload);
    assertPerfReport(perf, ["queue", "spawn", "materialize"]);
    const attributes = collectPerfAttributes(perf);
    assert.ok("queue" in attributes, "expected queue metrics attribute");
    assert.ok("spawn" in attributes, "expected spawn metrics attribute");
    assert.ok("materialize" in attributes, "expected materialize metrics attribute");
    assert.ok("semantic" in attributes, "expected semantic metrics attribute");
  });

  it("mcp-run --perf preserves the MCP long-running execution timeout", async () => {
    let capturedInput: RunExecutableInput | undefined;
    const execute = async (input: RunExecutableInput): Promise<RunExecutableResult> => {
      capturedInput = input;
      return {
        ok: true,
        tool: input.tool,
        timingMs: 1,
        metrics: {
          childTool: input.tool,
          durationMs: 1,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdinBytes: 0,
          argCount: input.args?.length ?? 0,
          argHash: "test",
          argShape: [],
        },
      };
    };

    await captureJsonOutput(() => mcpRunCommand("node", [], { perf: true, requestTimeoutMs: "1" }, execute));
    assert.equal(capturedInput?.timeoutMs, defaultLongRunningTimeoutMs);
  });

  it("mcp-grep --perf preserves native search invocation, normalization, and bundled-ripgrep perf metadata", async () => {
    const fixture = await withTempFixture();
    const fakeSearchClient: XraySearchClientLike = {
      async run() {
        return {
          ok: true,
          command: "search",
          data: {
            matches: [{ path: join(fixture.root, "sample.txt"), line: 1, text: "alpha" }],
            summary: { matchCount: 1 },
          },
          metrics: {
            elapsedMs: 7,
            filesScanned: 1,
            matchesReturned: 1,
            ripgrepMetrics: { elapsedMs: 7, filesScanned: 1, matchesReturned: 1, binary: "bundled-ripgrep" },
          },
        };
      },
    };

    const payload = await captureJsonOutput(() => mcpGrepCommand(
      fixture.root,
      { perf: true, query: "alpha", max: "5" },
      fakeSearchClient,
    ));

    assert.equal(payload.kind, "content");
    const perf = readPerfReport(payload);
    assertPerfReport(perf, ["search", "normalize"]);
    const attributes = collectPerfAttributes(perf);
    assert.ok("searchInvocation" in attributes, "expected search invocation attributes");
    assert.ok("normalization" in attributes, "expected normalization attributes");
    assert.ok("nativeSearch" in attributes, "expected native Atrium search perf attributes");
    assert.ok("bundledRipgrep" in attributes, "expected bundled-ripgrep perf attributes");
  });

  it("perf search reruns preserve each MCP verb's scope and timeout", async () => {
    const invocations: Array<{
      command: string;
      all?: boolean;
      exclude?: string;
      glob?: string;
      query?: string;
      regex?: boolean;
      root?: string;
      timeoutMs?: number;
    }> = [];
    const fakeSearchClient: XraySearchClientLike = {
      async run(options) {
        invocations.push(options);
        return { ok: true, command: options.command, data: { matches: [] } };
      },
    };
    const fixture = await withTempFixture();

    await captureJsonOutput(() => mcpFindFilesCommand(
      fixture.root,
      { perf: true, glob: "**/*.txt", exclude: "**/vendor/**" },
      fakeSearchClient,
    ));
    await captureJsonOutput(() => mcpGrepCommand(
      fixture.root,
      { perf: true, queries: ["a.b", "c"], glob: "**/*.txt", exclude: "**/vendor/**" },
      fakeSearchClient,
    ));
    await captureJsonOutput(() => mcpGrepCodeCommand(
      fixture.root,
      { perf: true, queries: ["a.b", "c"], regex: true, glob: "**/*.ts", exclude: "**/dist/**" },
      fakeSearchClient,
    ));
    await captureJsonOutput(() => mcpGrepCodeCommand(
      fixture.root,
      { perf: true, queries: ["literal.pattern"] },
      fakeSearchClient,
    ));

    assert.deepEqual(invocations, [
      {
        command: "files",
        root: fixture.root,
        all: true,
        glob: "**/*.txt",
        exclude: "**/vendor/**",
        timeoutMs: 59_000,
      },
      {
        command: "search",
        root: fixture.root,
        query: "a\\.b|c",
        regex: true,
        all: true,
        glob: "**/*.txt",
        exclude: "**/vendor/**",
        timeoutMs: 59_000,
      },
      {
        command: "search",
        root: fixture.root,
        query: "a.b|c",
        regex: true,
        glob: "**/*.ts",
        exclude: "**/dist/**",
        timeoutMs: 59_000,
      },
      {
        command: "search",
        root: fixture.root,
        query: "literal.pattern",
        timeoutMs: 59_000,
      },
    ]);
  });

  it("operation-wait reports continue, completed, and failed status spans from local persisted snapshots", async () => {
    for (const scenario of [
      { status: "running" as const, expectedStatus: "continue", expectedName: "continue" },
      { status: "completed" as const, expectedStatus: "completed", expectedName: "completed" },
      { status: "failed" as const, expectedStatus: "failed", expectedName: "failed" },
    ]) {
      await withFakeOperationSnapshot(scenario.status, async (operationId) => {
        const payload = await captureJsonOutput(() => mcpOperationWaitCommand(
          operationId,
          { perf: true },
          { requestSafeWaitMs: 1 },
        ));
        assert.equal(payload.ok, scenario.status !== "failed");
        assert.equal(payload.status, scenario.expectedStatus);
        assert.equal(payload.operationId, operationId);
        const perf = readPerfReport(payload);
        assertPerfReport(perf, [scenario.expectedName]);
      });
    }
  });
});

function parseJsonPayload(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, "", "expected CLI output");
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function runCliJson(args: string[]): Record<string, unknown> {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseJsonPayload(result.stdout);
}

async function captureJsonOutput(callback: () => Promise<void>): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await callback();
  } finally {
    process.stdout.write = originalWrite;
  }
  return parseJsonPayload(chunks.join(""));
}

function readPerfReport(payload: Record<string, unknown>): Record<string, unknown> {
  assert.ok(payload.perf !== undefined, "expected perf report");
  assert.equal(typeof payload.perf, "object");
  assert.notEqual(payload.perf, null);
  return payload.perf as Record<string, unknown>;
}

function assertPerfReport(perf: Record<string, unknown>, expectedNames: string[]): void {
  assert.equal(typeof perf.operationId, "string");
  assert.equal(typeof perf.startedAt, "string");
  assert.equal(typeof perf.endedAt, "string");
  assert.equal(typeof perf.durationMs, "number");
  assert.ok((perf.durationMs as number) >= 0, "expected non-negative duration");
  assert.ok(Array.isArray(perf.spans), "expected spans array");
  const spans = perf.spans as Array<Record<string, unknown>>;
  assert.ok(spans.length > 0, "expected at least one perf span");

  const names = spans
    .filter((span) => typeof span.name === "string")
    .map((span) => span.name as string);

  for (const expectedName of expectedNames) {
    assert.ok(names.some((name) => name.toLowerCase().includes(expectedName.toLowerCase())), `expected span name matching ${expectedName}`);
  }

  for (const span of spans) {
    assert.equal(typeof span.startedAt, "string");
    assert.equal(typeof span.endedAt, "string");
    assert.equal(typeof span.durationMs, "number");
    assert.ok((span.durationMs as number) >= 0, "expected non-negative span duration");
  }
}

function collectPerfAttributes(perf: Record<string, unknown>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  collectAttributes(attributes, perf);
  const spans = Array.isArray(perf.spans) ? perf.spans : [];
  for (const span of spans) {
    collectAttributes(attributes, span);
  }
  return attributes;
}

function collectAttributes(target: Record<string, unknown>, source: unknown): void {
  if (source === null || typeof source !== "object") {
    return;
  }
  const record = source as Record<string, unknown>;
  if (record.attributes !== undefined && record.attributes !== null && typeof record.attributes === "object") {
    Object.assign(target, record.attributes as Record<string, unknown>);
  }
}

async function withTempFile(contents: string): Promise<{ filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "atrium-perf-spans-"));
  try {
    const filePath = join(root, "sample.txt");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
    return { filePath };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function withTempFixture(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "atrium-perf-grep-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "sample.txt"), "alpha\n", "utf8");
    return { root };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function withFakeOperationSnapshot<T>(status: "running" | "completed" | "failed", callback: (operationId: string) => Promise<T>): Promise<T> {
  const operationId = `fake-${status}-${Date.now().toString(36)}`;
  const resultPath = join(atriumTempPath("background-runs", operationId), "result.json");
  const snapshot = {
    ok: status !== "failed",
    status,
    operationId,
    resultPath,
    startedAt: new Date().toISOString(),
    ...(status === "completed" ? { result: { ok: true } } : {}),
    ...(status === "failed" ? { error: { code: "Boom", message: "boom" } } : {}),
  };

  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(snapshot)}\n`, "utf8");

  try {
    return await callback(operationId);
  } finally {
    await rm(dirname(resultPath), { recursive: true, force: true });
  }
}
