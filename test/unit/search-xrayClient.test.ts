import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildXrayArgs, createXrayClient } from "../../src/core/search/xrayClient.js";
import type { RunExecutableInput, RunExecutableResult } from "../../src/core/runner.js";

function okResult(stdout: string): RunExecutableResult {
  return { ok: true, tool: "xray", timingMs: 1, metrics: {} as RunExecutableResult["metrics"], stdout };
}

describe("buildXrayArgs", () => {
  it("maps content-search options including exclude to a negated glob and --all", () => {
    const args = buildXrayArgs({ command: "search", root: "C:\\repo", query: "foo", glob: "src/**", exclude: "**/x/**", all: true, max: 50, timeoutMs: 1000 });
    assert.deepEqual(args, ["search", "foo", "--root", "C:\\repo", "--all", "--glob", "src/**", "--glob", "!**/x/**", "--max", "50", "--timeoutMs", "1000"]);
  });

  it("uses --query when the query starts with a dash and adds --regex", () => {
    const args = buildXrayArgs({ command: "search", root: "C:\\repo", query: "-x|-y", regex: true });
    assert.deepEqual(args, ["search", "--query", "-x|-y", "--root", "C:\\repo", "--regex"]);
  });

  it("builds a files listing with no query", () => {
    const args = buildXrayArgs({ command: "files", root: "C:\\repo", all: true, glob: "**/*.ts" });
    assert.deepEqual(args, ["files", "--root", "C:\\repo", "--all", "--glob", "**/*.ts"]);
  });
});

describe("createXrayClient", () => {
  it("parses a successful envelope", async () => {
    const client = createXrayClient(async () => okResult(JSON.stringify({ ok: true, command: "files", data: { matches: [{ path: "a.ts" }] } })));
    const envelope = await client.run({ command: "files", root: "C:\\repo" });
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data?.matches, [{ path: "a.ts" }]);
  });

  it("throws with the xray error and hint when ok is false", async () => {
    const client = createXrayClient(async () => okResult(JSON.stringify({ ok: false, command: "files", error: "FILES_FAILED", hint: "bad root" })));
    await assert.rejects(() => client.run({ command: "files", root: "C:\\repo" }), /FILES_FAILED.*bad root/);
  });
});

describe("createXrayClient runner kill grace margin", () => {
  // Invariant: xray must reach its own --timeoutMs and flush partial results plus a
  // timeout warning before the runner's hard kill fires. When the runner kill deadline
  // equals xray's --timeoutMs the two coincide and the kill truncates xray's JSON mid
  // flush, turning a graceful partial result into a hard "Process exceeded timeoutMs"
  // failure. The runner deadline must therefore exceed the xray deadline.
  it("gives the runner a longer kill deadline than xray's own --timeoutMs", async () => {
    let captured: RunExecutableInput | undefined;
    const client = createXrayClient(async (input) => {
      captured = input;
      return okResult(JSON.stringify({ ok: true, command: "search", data: { matches: [] } }));
    });

    await client.run({ command: "search", root: "C:\\repo", query: "foo", timeoutMs: 25_000 });

    assert.deepEqual(captured?.args, ["search", "foo", "--root", "C:\\repo", "--timeoutMs", "25000"]);
    assert.equal(captured?.timeoutMs, 26_000);
  });

  it("leaves the runner deadline unset when no timeoutMs is supplied", async () => {
    let captured: RunExecutableInput | undefined;
    const client = createXrayClient(async (input) => {
      captured = input;
      return okResult(JSON.stringify({ ok: true, command: "files", data: { matches: [] } }));
    });

    await client.run({ command: "files", root: "C:\\repo" });

    assert.equal(captured?.timeoutMs, undefined);
    assert.ok(!(captured?.args ?? []).includes("--timeoutMs"));
  });
});
