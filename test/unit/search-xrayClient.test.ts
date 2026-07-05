import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildXrayArgs, createXrayClient } from "../../src/core/search/xrayClient.js";
import type { RunExecutableResult } from "../../src/core/runner.js";

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
