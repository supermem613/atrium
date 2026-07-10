import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNativeSearchClient } from "../../src/core/search/searchClient.js";
import type { ContentSearchOptions, ContentSearchResult, NativeFileSearchResult } from "../../src/core/search/types.js";

describe("createNativeSearchClient", () => {
  it("emits ripgrep metrics only for explicit perf requests", async () => {
    const seen: ContentSearchOptions[] = [];
    const client = createNativeSearchClient({
      runContentSearch: async (options) => {
        seen.push(options);
        return {
          kind: "content",
          matches: [{ path: "src/a.ts", line: 3, text: "needle" }],
          warnings: ["native warning"],
          metrics: { searches: 2, bytesSearched: 123, matches: 1 },
        } satisfies ContentSearchResult;
      },
      runFileSearch: async () => {
        throw new Error("unexpected file search");
      },
    });

    const envelope = await client.run({ command: "search", root: "/repo", query: "needle", regex: true, max: 3, timeoutMs: 2500, exclude: "**/dist/**" });

    assert.deepEqual(seen[0], { query: "needle", root: "/repo", regex: true, max: 3, timeoutMs: 2500, excludes: ["**/dist/**"] });
    assert.equal(envelope.kind, "content");
    assert.deepEqual(envelope.data?.matches, [{ path: "src/a.ts", line: 3, text: "needle" }]);
    assert.deepEqual(envelope.warnings, ["native warning"]);
    assert.equal(envelope.metrics, undefined);

    const perfEnvelope = await client.run({
      command: "search",
      root: "/repo",
      query: "needle",
      regex: true,
      max: 3,
      timeoutMs: 2500,
      exclude: "**/dist/**",
      perf: true,
    });

    assert.deepEqual(seen[1], {
      query: "needle",
      root: "/repo",
      regex: true,
      max: 3,
      timeoutMs: 2500,
      excludes: ["**/dist/**"],
      perf: true,
    });
    assert.deepEqual(perfEnvelope.metrics, {
      ripgrepMetrics: {
        searches: 2,
        bytesSearched: 123,
        bytesPrinted: undefined,
        matchedLines: undefined,
        matches: 1,
      },
    });
  });

  it("routes file lookups to the native file engine", async () => {
    const seen: Array<{ root: string; max?: number; timeoutMs?: number; globs?: string[]; excludes?: string[]; all?: boolean }> = [];
    const client = createNativeSearchClient({
      runContentSearch: async () => {
        throw new Error("unexpected content search");
      },
      runFileSearch: async (options) => {
        seen.push(options);
        return {
          kind: "files",
          matches: [{ path: "src/b.ts" }],
          warnings: ["file warning"],
        } satisfies NativeFileSearchResult;
      },
    });

    const envelope = await client.run({ command: "files", root: "/repo", glob: "**/*.ts", exclude: "**/node_modules/**", max: 4, timeoutMs: 1800, all: true });

    assert.deepEqual(seen[0], { root: "/repo", max: 4, timeoutMs: 1800, globs: ["**/*.ts"], excludes: ["**/node_modules/**"], all: true });
    assert.equal(envelope.kind, "files");
    assert.deepEqual(envelope.data?.matches, [{ path: "src/b.ts" }]);
    assert.deepEqual(envelope.warnings, ["file warning"]);
    assert.equal(envelope.metrics, undefined);
  });
});
