import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runContentSearch,
  spawnContentSearchRunner,
  createNativeContentSearchRunner,
} from "../../src/core/search/contentSearch.js";
import {
  runNativeFileSearch,
  spawnFileSearchRunner,
  createNativeFileSearchRunner,
} from "../../src/core/search/fileSearch.js";
import type { SearchContentMatch } from "../../src/core/search/types.js";

let root: string;

function write(rel: string, text: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, { encoding: "utf8" });
}

function sortContent(matches: SearchContentMatch[]) {
  return [...matches].sort((a, b) =>
    `${a.path}\u0000${a.line}\u0000${a.text}`.localeCompare(`${b.path}\u0000${b.line}\u0000${b.text}`),
  );
}

function sortPaths(matches: { path: string }[]) {
  return matches.map((m) => m.path).sort((a, b) => a.localeCompare(b));
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "atrium-runner-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  write("a.md", "needle in markdown\n");
  write("notes.txt", "needle in text\n");
  write("src/b.ts", "needle in code\n");
  write("src/deep/c.ts", "another needle here\n");
});

after(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native search runner wiring with ripgrep fallback", () => {
  it("content: default (native) runner returns the same matches as the spawn-rg runner", async () => {
    const rg = await runContentSearch({ query: "needle", root, runner: spawnContentSearchRunner });
    const native = await runContentSearch({ query: "needle", root });
    assert.ok(rg.matches.length > 0, "expected ripgrep to return matches");
    assert.deepEqual(sortContent(native.matches), sortContent(rg.matches));
  });

  it("content: the default runner searches in-process (no child spawn metrics)", async () => {
    const native = await runContentSearch({ query: "needle", root, perf: true });
    assert.equal(native.metrics?.spawnCallMs, undefined);
    assert.equal(typeof native.metrics?.searches, "number");
  });

  it("content: a failed addon load falls back to spawn-rg with identical matches", async () => {
    const fallbackRunner = createNativeContentSearchRunner({
      loadAddon: () => null,
      spawnRunner: spawnContentSearchRunner,
    });
    const rg = await runContentSearch({ query: "needle", root, runner: spawnContentSearchRunner });
    const fallback = await runContentSearch({ query: "needle", root, perf: true, runner: fallbackRunner });
    assert.deepEqual(sortContent(fallback.matches), sortContent(rg.matches));
    assert.equal(typeof fallback.metrics?.spawnCallMs, "number");
  });

  it("files: default (native) runner returns the same paths as the spawn-rg runner", async () => {
    const rg = await runNativeFileSearch({ root, runner: spawnFileSearchRunner });
    const native = await runNativeFileSearch({ root });
    assert.ok(rg.matches.length > 0, "expected ripgrep to list files");
    assert.deepEqual(sortPaths(native.matches), sortPaths(rg.matches));
  });

  it("files: the default runner lists in-process (no child spawn metrics)", async () => {
    const native = await runNativeFileSearch({ root, perf: true });
    assert.equal(native.metrics?.spawnCallMs, undefined);
    assert.equal(typeof native.metrics?.searches, "number");
  });

  it("files: a failed addon load falls back to spawn-rg with identical paths", async () => {
    const fallbackRunner = createNativeFileSearchRunner({
      loadAddon: () => null,
      spawnRunner: spawnFileSearchRunner,
    });
    const rg = await runNativeFileSearch({ root, runner: spawnFileSearchRunner });
    const fallback = await runNativeFileSearch({ root, perf: true, runner: fallbackRunner });
    assert.deepEqual(sortPaths(fallback.matches), sortPaths(rg.matches));
    assert.equal(typeof fallback.metrics?.spawnCallMs, "number");
  });
});
