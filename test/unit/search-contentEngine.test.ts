import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContentSearch, parseNativeContentArgs, DEFAULT_CONTENT_SEARCH_EXCLUDES } from "../../src/core/search/contentSearch.js";
import type { ContentSearchRunner } from "../../src/core/search/types.js";

test("content search uses fixed-string defaults and exact default exclusions", async () => {
  const seen: string[][] = [];
  const runner: ContentSearchRunner = async (args) => {
    seen.push(args);
    return { args, matches: [], warnings: [], timedOut: false, truncated: false, metrics: { searches: 1 } };
  };

  const result = await runContentSearch({ query: "needle", root: "/tmp", runner });

  assert.equal(result.matches.length, 0);
  assert.ok(seen[0].includes("-F"));
  assert.deepEqual(seen[0].filter((arg) => arg.startsWith("!")), [...DEFAULT_CONTENT_SEARCH_EXCLUDES]);
  assert.deepEqual(result.warnings, []);
});

test("content search forwards explicit globs and excludes through ripgrep --glob args", async () => {
  const seen: string[][] = [];
  const runner: ContentSearchRunner = async (args) => {
    seen.push(args);
    return { args, matches: [], warnings: [], timedOut: false, truncated: false, metrics: { searches: 1 } };
  };

  await runContentSearch({ query: "needle", root: "/tmp", all: true, globs: ["**/*.ts"], excludes: ["**/vendor/**"], runner });

  assert.deepEqual(seen[0].filter((arg) => arg === "--hidden" || arg === "--no-ignore"), ["--hidden", "--no-ignore"]);
  assert.deepEqual(seen[0].filter((arg) => arg === "**/*.ts" || arg === "!**/vendor/**"), ["**/*.ts", "!**/vendor/**"]);
});

test("content search deduplicates matches and caps the global result set", async () => {
  const runner: ContentSearchRunner = async () => ({
    args: [],
    matches: [
      { path: "src/a.ts", line: 1, text: "needle" },
      { path: "src/a.ts", line: 1, text: "needle" },
      { path: "src/b.ts", line: 3, text: "needle" },
    ],
    warnings: [],
    timedOut: false,
    truncated: false,
    metrics: { searches: 1 },
  });

  const result = await runContentSearch({ query: "needle", root: "/tmp", max: 2, runner });

  assert.deepEqual(result.matches.map((match) => match.path), ["src/a.ts", "src/b.ts"]);
  assert.ok(result.warnings.some((warning) => warning.includes("display capped at 2 matches")));
});

test("content search surfaces timeout warnings and aggregates ripgrep metrics across lanes", async () => {
  const runner: ContentSearchRunner = async () => ({
    args: [],
    matches: [],
    warnings: ["partial result"],
    timedOut: true,
    truncated: false,
    metrics: { searches: 2, childRunMs: 10 },
  });

  const result = await runContentSearch({ query: "needle", root: "/tmp", timeoutMs: 59000, perf: true, runner });

  assert.ok(result.warnings.some((warning) => warning.includes("search stopped after 59000 ms")));
  // A literal query fans out across the markdown, code, and everything lanes, so the runner is
  // invoked once per lane and the reported metrics are the sum over all three invocations.
  assert.equal(result.metrics?.searches, 6);
  assert.equal(result.metrics?.childRunMs, 30);
});

test("content search deduplicates identical warnings from every lane", async () => {
  const runner: ContentSearchRunner = async () => ({
    args: [],
    matches: [],
    warnings: ["partial result"],
    timedOut: false,
    truncated: false,
    metrics: { searches: 1 },
  });

  const result = await runContentSearch({ query: "needle", root: "/tmp", runner });

  assert.deepEqual(result.warnings, ["partial result"]);
});

test("content search runs every fanout lane for a literal query", async () => {
  const seen: string[][] = [];
  const runner: ContentSearchRunner = async (args) => {
    seen.push(args);
    return { args, matches: [], warnings: [], timedOut: false, truncated: false, metrics: { searches: 1 } };
  };

  await runContentSearch({ query: "needle", root: "/tmp", runner });

  assert.equal(seen.length, 3);
  assert.ok(seen.some((args) => args.includes("xraymarkdown")));
  assert.ok(seen.some((args) => args.includes("xraycode")));
});

test("content search runs a single walk for regex queries", async () => {
  const seen: string[][] = [];
  const runner: ContentSearchRunner = async (args) => {
    seen.push(args);
    return { args, matches: [], warnings: [], timedOut: false, truncated: false, metrics: { searches: 1 } };
  };

  await runContentSearch({ query: "need.*", root: "/tmp", regex: true, runner });

  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes("-F"));
});

test("content search does not double-wrap fatal search errors", async () => {
  const runner: ContentSearchRunner = async () => {
    throw new Error("fatal search error: addon boom");
  };

  await assert.rejects(
    runContentSearch({ query: "needle", root: "/tmp", runner }),
    (error: Error) => {
      assert.equal(error.message, "fatal search error: addon boom");
      assert.ok(!error.message.includes("fatal search error: fatal search error:"));
      return true;
    },
  );
});

test("content search finds matches when the root is a single file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atrium-content-file-root-"));
  try {
    const file = join(dir, "sample.ts");
    await writeFile(file, "const needle = 1;\n", "utf8");

    const result = await runContentSearch({ query: "needle", root: file });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].text.includes("needle"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content search reports an invalid root instead of a misleading spawn error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atrium-content-missing-root-"));
  const missing = join(dir, "does-not-exist");
  try {
    await assert.rejects(runContentSearch({ query: "needle", root: missing }), /invalid root/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content search finds literal matches inside code files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atrium-content-code-lane-"));
  try {
    await writeFile(join(dir, "module.ts"), "export const distinctiveToken = 42;\n", "utf8");

    const result = await runContentSearch({ query: "distinctiveToken", root: dir });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path.endsWith("module.ts"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content search turns fatal search errors into explicit failures", async () => {
  const runner: ContentSearchRunner = async () => {
    throw new Error("regex parse error");
  };

  await assert.rejects(
    runContentSearch({ query: "[", root: "/tmp", regex: true, runner }),
    /fatal search error/u,
  );
});

test("parseNativeContentArgs treats the -e query value as data, not a flag", () => {
  // The query is emitted as the value of `-e`, before globs/excludes/lane args.
  // A query that happens to equal a ripgrep flag must not flip include/exclude
  // or type-lane options, or the native path would diverge from spawned rg.
  const args = [
    "--line-number", "--color=never", "--json", "--max-filesize", "2M", "-F",
    "-e", "--hidden",
    "--glob", "!**/.git/**",
    "--type-add", "xraymarkdown:*.md",
    "--type", "xraymarkdown",
    "--", ".",
  ];

  const parsed = parseNativeContentArgs(args);

  assert.equal(parsed.all, false, "query value --hidden must not enable all mode");
  assert.deepEqual(parsed.excludes, ["**/.git/**"]);
  assert.deepEqual(parsed.globs, []);
  assert.deepEqual(parsed.typeSelect, ["xraymarkdown"]);
  assert.deepEqual(parsed.typeDefs, [{ name: "xraymarkdown", glob: "*.md" }]);
});

test("parseNativeContentArgs keeps lane args when the query value is a separator", () => {
  // A `--` query value must not be mistaken for the flags/paths separator, or
  // the native path would drop the lane selection and default excludes.
  const args = [
    "--line-number", "--color=never", "--json", "--max-filesize", "2M", "-F",
    "-e", "--",
    "--glob", "!**/node_modules/**",
    "--type-add", "xraycode:*.ts",
    "--type", "xraycode",
    "--", ".",
  ];

  const parsed = parseNativeContentArgs(args);

  assert.deepEqual(parsed.excludes, ["**/node_modules/**"]);
  assert.deepEqual(parsed.typeSelect, ["xraycode"]);
});
