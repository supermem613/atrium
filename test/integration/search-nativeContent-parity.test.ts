import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { contentParity } from "../../scripts/search-parity.mjs";

let root: string;

function write(rel: string, text: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, { encoding: "utf8" });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "atrium-content-parity-"));
  execFileSync("git", ["init", "-q"], { cwd: root });

  write("a.txt", "alpha here\nbeta gamma\n");
  write("src/b.ts", "const alpha = 1;\nfunction beta() {}\n");
  write("src/c.md", "# alpha heading\nsome beta text\n");
  write("src/deep/d.ts", "let alpha = beta;\n");
  write(".hidden.txt", "alpha hidden line\n");
  write("node_modules/dep/index.js", "alpha in dependency\n");
  write(".gitignore", "ignored.txt\nbuild/\n");
  write("ignored.txt", "alpha ignored\n");
  write("build/out.txt", "alpha built\n");
});

after(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native content search parity vs bundled ripgrep", () => {
  it("matches for a literal query with default ignore/hidden rules", async () => {
    const { rg, native } = await contentParity(root, { query: "alpha" });
    assert.ok(rg.length > 0, "expected ripgrep to find literal matches");
    assert.deepEqual(native, rg);
  });

  it("matches for a literal query with all=true (hidden + no-ignore)", async () => {
    const { rg, native } = await contentParity(root, { query: "alpha", all: true });
    assert.ok(rg.length > 0);
    assert.deepEqual(native, rg);
  });

  it("matches for a regex query", async () => {
    const { rg, native } = await contentParity(root, { query: "al\\w+a", regex: true });
    assert.ok(rg.length > 0);
    assert.deepEqual(native, rg);
  });

  it("matches when restricted by an include glob", async () => {
    const { rg, native } = await contentParity(root, { query: "alpha", globs: ["*.ts"] });
    assert.deepEqual(native, rg);
  });

  it("matches when an exclude glob is applied", async () => {
    const { rg, native } = await contentParity(root, { query: "alpha", excludes: ["*.md", "**/node_modules/**"] });
    assert.deepEqual(native, rg);
  });
});
