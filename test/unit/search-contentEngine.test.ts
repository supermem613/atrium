import test from "node:test";
import assert from "node:assert/strict";
import { runContentSearch, DEFAULT_CONTENT_SEARCH_EXCLUDES } from "../../src/core/search/contentSearch.js";
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

  const result = await runContentSearch({ query: "needle", root: "/tmp", timeoutMs: 59000, runner });

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
