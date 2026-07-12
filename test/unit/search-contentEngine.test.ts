import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContentSearch, spawnContentSearchRunner, parseNativeContentArgs, DEFAULT_CONTENT_SEARCH_EXCLUDES } from "../../src/core/search/contentSearch.js";
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

test("content search surfaces timeout warnings and ripgrep metrics", async () => {
  const runner: ContentSearchRunner = async () => ({
    args: [],
    matches: [],
    warnings: ["partial result"],
    timedOut: true,
    truncated: false,
    metrics: { searches: 2, bytesSearched: 4096, bytesPrinted: 256, matchedLines: 1, matches: 1 },
  });

  const result = await runContentSearch({ query: "needle", root: "/tmp", timeoutMs: 59000, perf: true, runner });

  assert.ok(result.warnings.some((warning) => warning.includes("search stopped after 59000 ms")));
  assert.equal(result.metrics?.searches, 2);
  assert.equal(result.metrics?.bytesSearched, 4096);
  assert.equal(result.metrics?.bytesPrinted, 256);
});

test("content search turns fatal ripgrep errors into explicit failures", async () => {
  const runner: ContentSearchRunner = async () => {
    throw new Error("regex parse error");
  };

  await assert.rejects(
    runContentSearch({ query: "[", root: "/tmp", regex: true, runner }),
    /fatal ripgrep error/u,
  );
});

test("content search emits complete ripgrep lifecycle metrics only when perf is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "atrium-content-perf-"));
  try {
    await writeFile(join(root, "sample.txt"), "needle\n", "utf8");

    const withoutPerf = await runContentSearch({ query: "needle", root, runner: spawnContentSearchRunner });
    const withPerf = await runContentSearch({ query: "needle", root, perf: true, runner: spawnContentSearchRunner });

    assert.equal(withoutPerf.metrics?.spawnCallMs, undefined);
    assert.equal(withoutPerf.metrics?.childTotalMs, undefined);
    assertLifecycleMetrics(withPerf.metrics);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

function assertLifecycleMetrics(metrics: Awaited<ReturnType<typeof runContentSearch>>["metrics"]): void {
  assert.ok(metrics);
  for (const field of ["spawnCallMs", "spawnReadyMs", "childRunMs", "childTotalMs", "parseMs"] as const) {
    assert.equal(typeof metrics[field], "number", `expected numeric ${field}`);
    assert.ok((metrics[field] ?? -1) >= 0, `expected nonnegative ${field}`);
  }
  assert.ok((metrics.childTotalMs ?? 0) >= (metrics.spawnCallMs ?? 0) + (metrics.spawnReadyMs ?? 0) + (metrics.childRunMs ?? 0));
}
