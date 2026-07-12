import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runContentSearch,
  createNativeContentSearchRunner,
} from "../../src/core/search/contentSearch.js";
import {
  runNativeFileSearch,
  createNativeFileSearchRunner,
} from "../../src/core/search/fileSearch.js";

let root: string;

function write(rel: string, text: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, { encoding: "utf8" });
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

describe("native search runner (in-process)", () => {
  it("content: the default runner finds matches across the tree", async () => {
    const native = await runContentSearch({ query: "needle", root });
    const paths = native.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ["a.md", "notes.txt", "src/b.ts", "src/deep/c.ts"]);
  });

  it("content: the default runner searches in-process and reports native metrics", async () => {
    const native = await runContentSearch({ query: "needle", root, perf: true });
    assert.equal(typeof native.metrics?.searches, "number");
    assert.equal(typeof native.metrics?.childRunMs, "number");
  });

  it("content: a missing addon is a hard error", async () => {
    const runner = createNativeContentSearchRunner({ loadAddon: () => null });
    await assert.rejects(
      () => runContentSearch({ query: "needle", root, runner }),
      /native search addon not available/,
    );
  });

  it("files: the default runner lists the tracked files", async () => {
    const native = await runNativeFileSearch({ root });
    const paths = native.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ["a.md", "notes.txt", "src/b.ts", "src/deep/c.ts"]);
  });

  it("files: the default runner lists in-process and reports native metrics", async () => {
    const native = await runNativeFileSearch({ root, perf: true });
    assert.equal(typeof native.metrics?.searches, "number");
    assert.equal(typeof native.metrics?.childRunMs, "number");
  });

  it("files: a missing addon is a hard error", async () => {
    const runner = createNativeFileSearchRunner({ loadAddon: () => null });
    await assert.rejects(
      () => runNativeFileSearch({ root, runner }),
      /native search addon not available/,
    );
  });
});
