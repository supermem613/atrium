import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNativeSearchClient } from "../../src/core/search/searchClient.js";
import type { ContentSearchResult, NativeFileSearchResult } from "../../src/core/search/types.js";

describe("native search integration", () => {
  it("returns native content envelopes for content search requests", async () => {
    const client = createNativeSearchClient({
      runContentSearch: async () => ({
        kind: "content",
        matches: [{ path: "src/alpha.ts", line: 9, text: "needle" }],
        warnings: ["native content warning"],
        metrics: { searches: 1, bytesSearched: 512, matches: 1 },
      } satisfies ContentSearchResult),
      runFileSearch: async () => {
        throw new Error("unexpected file search");
      },
    });

    const envelope = await client.run({ command: "search", root: "/tmp/project", query: "needle" });
    assert.equal(envelope.kind, "content");
    assert.deepEqual(envelope.data?.matches, [{ path: "src/alpha.ts", line: 9, text: "needle" }]);
    assert.deepEqual(envelope.warnings, ["native content warning"]);
    assert.equal(envelope.metrics, undefined);
  });

  it("returns native file envelopes for file search requests", async () => {
    const client = createNativeSearchClient({
      runContentSearch: async () => {
        throw new Error("unexpected content search");
      },
      runFileSearch: async () => ({
        kind: "files",
        matches: [{ path: "src/beta.ts" }],
        warnings: ["native file warning"],
      } satisfies NativeFileSearchResult),
    });

    const envelope = await client.run({ command: "files", root: "/tmp/project", all: true });
    assert.equal(envelope.kind, "files");
    assert.deepEqual(envelope.data?.matches, [{ path: "src/beta.ts" }]);
    assert.deepEqual(envelope.warnings, ["native file warning"]);
    assert.equal(envelope.metrics, undefined);
  });
});
