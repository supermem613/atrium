import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadNativeSearchAddon } from "../../src/core/search/nativeAddon.js";

let root: string;

// Each file holds MATCHES_PER_FILE matching lines so max/timeout early-stop is
// observable and deterministic.
const FILE_COUNT = 5;
const MATCHES_PER_FILE = 4;
const TOTAL_MATCHES = FILE_COUNT * MATCHES_PER_FILE;

function write(rel: string, text: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, { encoding: "utf8" });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "atrium-control-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const line = "needle here\n";
  for (let i = 0; i < FILE_COUNT; i++) {
    write(`f${i}.txt`, line.repeat(MATCHES_PER_FILE));
  }
});

after(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

function addon() {
  const a = loadNativeSearchAddon();
  if (a === null) {
    throw new Error("native search addon not built");
  }
  return a;
}

describe("native search control: max, timeout, and perf metrics", () => {
  it("content: max caps returned matches and marks truncated", async () => {
    const r = await addon().searchContent({ root, query: "needle", max: 3 });
    assert.equal(r.matches.length, 3);
    assert.equal(r.truncated, true);
    assert.equal(r.timedOut, false);
  });

  it("content: no max returns all matches and truncated is false", async () => {
    const r = await addon().searchContent({ root, query: "needle" });
    assert.equal(r.matches.length, TOTAL_MATCHES);
    assert.equal(r.truncated, false);
    assert.equal(r.timedOut, false);
  });

  it("content: a zero-millisecond deadline cooperatively aborts and marks timedOut", async () => {
    const r = await addon().searchContent({ root, query: "needle", timeoutMs: 0 });
    assert.equal(r.timedOut, true);
    assert.ok(r.matches.length < TOTAL_MATCHES, "expected the search to stop before returning every match");
  });

  it("content: perf true returns numeric metrics; omitted returns none", async () => {
    const withPerf = await addon().searchContent({ root, query: "needle", perf: true });
    assert.ok(withPerf.metrics, "expected metrics when perf is true");
    assert.equal(typeof withPerf.metrics?.childRunMs, "number");
    assert.equal(typeof withPerf.metrics?.searches, "number");

    const noPerf = await addon().searchContent({ root, query: "needle" });
    assert.equal(noPerf.metrics ?? null, null);
  });

  it("files: max caps returned paths and marks truncated", async () => {
    const r = await addon().searchFiles({ root, max: 2 });
    assert.equal(r.paths.length, 2);
    assert.equal(r.truncated, true);
    assert.equal(r.timedOut, false);
  });

  it("files: no max returns all paths and truncated is false", async () => {
    const r = await addon().searchFiles({ root });
    assert.equal(r.paths.length, FILE_COUNT);
    assert.equal(r.truncated, false);
  });

  it("files: a zero-millisecond deadline cooperatively aborts and marks timedOut", async () => {
    const r = await addon().searchFiles({ root, timeoutMs: 0 });
    assert.equal(r.timedOut, true);
    assert.ok(r.paths.length < FILE_COUNT, "expected the walk to stop before listing every file");
  });

  it("files: perf true returns numeric metrics; omitted returns none", async () => {
    const withPerf = await addon().searchFiles({ root, perf: true });
    assert.ok(withPerf.metrics, "expected metrics when perf is true");
    assert.equal(typeof withPerf.metrics?.childRunMs, "number");

    const noPerf = await addon().searchFiles({ root });
    assert.equal(noPerf.metrics ?? null, null);
  });
});
