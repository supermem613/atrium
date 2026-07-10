import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeFileSearch } from "../../src/core/search/fileSearch.js";
import type { NativeFileSearchRunner } from "../../src/core/search/types.js";

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function paths(result: Awaited<ReturnType<typeof runNativeFileSearch>>): string[] {
  return result.matches.map((match) => normalizePath(match.path));
}

test("lists files from a directory root", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-native-files-"));
  try {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "alpha.txt"), "alpha\n", "utf8");
    await writeFile(join(root, "src", "beta.ts"), "beta\n", "utf8");
    await writeFile(join(root, "src", "nested", "gamma.md"), "gamma\n", "utf8");

    const result = await runNativeFileSearch({ root });

    assert.deepEqual(new Set(paths(result)), new Set(["alpha.txt", "src/beta.ts", "src/nested/gamma.md"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scopes to a single-file root", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-native-file-root-"));
  try {
    await writeFile(join(root, "target.txt"), "target\n", "utf8");
    await writeFile(join(root, "other.txt"), "other\n", "utf8");

    const result = await runNativeFileSearch({ root: join(root, "target.txt") });

    assert.deepEqual(new Set(paths(result)), new Set(["target.txt"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("works outside a git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-native-nongit-"));
  try {
    await writeFile(join(root, "only.txt"), "hello\n", "utf8");

    const result = await runNativeFileSearch({ root });

    assert.deepEqual(new Set(paths(result)), new Set(["only.txt"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includes hidden and ignored files when all mode is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-native-all-"));
  try {
    await writeFile(join(root, ".gitignore"), "ignored.log\n", "utf8");
    await writeFile(join(root, "ignored.log"), "ignored\n", "utf8");
    await writeFile(join(root, ".secret.txt"), "hidden\n", "utf8");
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "vendor\n", "utf8");

    const result = await runNativeFileSearch({ root, all: true });
    const listed = paths(result);

    assert.ok(listed.includes("ignored.log"));
    assert.ok(listed.includes(".secret.txt"));
    assert.ok(listed.includes("node_modules/dep/index.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filters files by glob patterns", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-native-globs-"));
  try {
    await writeFile(join(root, "keep.ts"), "keep\n", "utf8");
    await writeFile(join(root, "skip.md"), "skip\n", "utf8");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "nested.ts"), "nested\n", "utf8");

    const result = await runNativeFileSearch({ root, globs: ["**/*.ts"] });

    assert.deepEqual(new Set(paths(result)), new Set(["keep.ts", "src/nested.ts"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caps results and warns when the display limit is reached", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-native-cap-"));
  try {
    for (let i = 0; i < 4; i += 1) {
      await writeFile(join(root, `file-${i}.txt`), `${i}\n`, "utf8");
    }

    const result = await runNativeFileSearch({ root, max: 2 });

    assert.equal(result.matches.length, 2);
    assert.ok(result.warnings.some((warning) => warning.includes("display capped at 2 files")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("surfaces timeout warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-native-timeout-"));
  try {
    await writeFile(join(root, "one.txt"), "one\n", "utf8");

    const runner: NativeFileSearchRunner = async () => ({
      paths: ["one.txt"],
      warnings: ["partial result"],
      timedOut: true,
      truncated: false,
    });

    const result = await runNativeFileSearch({ root, timeoutMs: 7, runner });

    assert.ok(result.warnings.some((warning) => warning.includes("search stopped after 7 ms")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
