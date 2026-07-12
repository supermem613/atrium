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

describe("native search runner (concurrent calls)", () => {
  let croot: string;
  const fileCount = 12;

  // Padded, terminated tokens so a literal query for one file's token can never
  // be a substring of another file's token. tok003end must match only f3.
  const token = (i: number) => `tok${String(i).padStart(3, "0")}end`;
  const allFiles = () => Array.from({ length: fileCount }, (_, i) => `f${i}.txt`).sort();

  before(() => {
    croot = mkdtempSync(join(tmpdir(), "atrium-conc-"));
    execFileSync("git", ["init", "-q"], { cwd: croot });
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(croot, `f${i}.txt`), `${token(i)} sharedALLmarker\n`, { encoding: "utf8" });
    }
  });

  after(() => {
    if (croot) {
      rmSync(croot, { recursive: true, force: true });
    }
  });

  // Each napi AsyncTask owns its inputs and runs on the libuv threadpool. Firing
  // far more concurrent searches than the default 4-thread pool forces real
  // parallel execution plus queuing. A correct addon must never leak one call's
  // result into another, so distinct queries must each resolve to only their file.
  it("content: parallel distinct-query searches each return only their own match", async () => {
    const results = await Promise.all(
      Array.from({ length: fileCount }, (_, i) => runContentSearch({ query: token(i), root: croot })),
    );
    results.forEach((res, i) => {
      const paths = res.matches.map((m) => m.path).sort();
      assert.deepEqual(paths, [`f${i}.txt`], `query ${token(i)} must match only f${i}.txt`);
    });
  });

  it("content: many parallel same-query searches all return the full identical result set", async () => {
    const runs = 32;
    const results = await Promise.all(
      Array.from({ length: runs }, () => runContentSearch({ query: "sharedALLmarker", root: croot })),
    );
    for (const res of results) {
      const paths = res.matches.map((m) => m.path).sort();
      assert.deepEqual(paths, allFiles());
    }
  });

  it("mixed content and file searches run in parallel without interfering", async () => {
    const ops: Promise<{ kind: "content" | "files"; index: number; paths: string[] }>[] = [];
    for (let i = 0; i < fileCount; i++) {
      ops.push(
        runContentSearch({ query: token(i), root: croot }).then((r) => ({
          kind: "content",
          index: i,
          paths: r.matches.map((m) => m.path).sort(),
        })),
      );
      ops.push(
        runNativeFileSearch({ root: croot }).then((r) => ({
          kind: "files",
          index: i,
          paths: r.matches.map((m) => m.path).sort(),
        })),
      );
    }
    const results = await Promise.all(ops);
    for (const res of results) {
      if (res.kind === "content") {
        assert.deepEqual(res.paths, [`f${res.index}.txt`]);
      } else {
        assert.deepEqual(res.paths, allFiles());
      }
    }
  });
});
