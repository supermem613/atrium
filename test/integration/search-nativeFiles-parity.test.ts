import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { filesParity } from "../../scripts/search-parity.mjs";

let root: string;

function write(rel: string, text: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text, { encoding: "utf8" });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "atrium-files-parity-"));
  execFileSync("git", ["init", "-q"], { cwd: root });

  write("a.txt", "alpha\n");
  write("src/b.ts", "beta\n");
  write("src/c.md", "gamma\n");
  write("src/deep/d.ts", "delta\n");
  write(".hidden.txt", "hidden\n");
  write("node_modules/dep/index.js", "dep\n");
  write(".gitignore", "ignored.txt\nbuild/\n");
  write("ignored.txt", "ignored\n");
  write("build/out.txt", "built\n");
});

after(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native file search parity vs bundled ripgrep --files", () => {
  it("matches the default file listing (gitignore + hidden rules)", async () => {
    const { rg, native } = await filesParity(root, {});
    assert.ok(rg.length > 0, "expected ripgrep to list files");
    assert.deepEqual(native, rg);
  });

  it("matches with all=true (hidden + no-ignore)", async () => {
    const { rg, native } = await filesParity(root, { all: true });
    assert.ok(rg.length > 0);
    assert.deepEqual(native, rg);
  });

  it("matches with an include glob", async () => {
    const { rg, native } = await filesParity(root, { globs: ["*.ts"] });
    assert.deepEqual(native, rg);
  });

  it("matches with exclude globs", async () => {
    const { rg, native } = await filesParity(root, { excludes: ["*.md", "**/node_modules/**"] });
    assert.deepEqual(native, rg);
  });

  it("matches for a single-file root", async () => {
    const { rg, native } = await filesParity(join(root, "src"), { rootIsFile: true, rootName: "b.ts" });
    assert.deepEqual(native, rg);
    assert.deepEqual(native, ["b.ts"]);
  });
});
