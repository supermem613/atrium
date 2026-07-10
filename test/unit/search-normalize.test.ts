import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchResult, normalizeXrayResult } from "../../src/core/search/normalize.js";
import type { NativeSearchEnvelope, XrayEnvelope } from "../../src/core/search/types.js";

describe("normalizeXrayResult", () => {
  it("maps a search envelope to a content result", () => {
    const envelope: XrayEnvelope = {
      ok: true,
      command: "search",
      data: {
        matches: [{ path: ".\\src\\a.ts", line: 7, text: "hello" }],
        summary: { matchCount: 1, fileCount: 1 },
      },
    };
    const result = normalizeXrayResult(envelope, "content");
    assert.equal(result.kind, "content");
    assert.deepEqual(result.matches, [{ path: ".\\src\\a.ts", line: 7, text: "hello" }]);
    assert.deepEqual(result.warnings, []);
  });

  it("maps a files envelope to a files result and keeps only path", () => {
    const envelope: XrayEnvelope = {
      ok: true,
      command: "files",
      data: {
        matches: [{ path: ".\\src\\a.ts" }, { path: ".\\src\\b.ts" }],
        summary: { fileCount: 2 },
      },
    };
    const result = normalizeXrayResult(envelope, "files");
    assert.equal(result.kind, "files");
    assert.deepEqual(result.matches, [{ path: ".\\src\\a.ts" }, { path: ".\\src\\b.ts" }]);
  });

  it("surfaces truncated and timedOut and passes through warnings", () => {
    const envelope: XrayEnvelope = {
      ok: true,
      command: "files",
      warnings: ["display capped at 50 files"],
      data: { matches: [], summary: { fileCount: 50, truncated: true, timedOut: true } },
    };
    const result = normalizeXrayResult(envelope, "files");
    assert.ok(result.warnings.includes("display capped at 50 files"));
    assert.ok(result.warnings.includes("results truncated by max"));
    assert.ok(result.warnings.includes("search timed out"));
  });

  it("normalizes native envelopes and exposes ripgrep metrics", () => {
    const envelope: NativeSearchEnvelope = {
      ok: true,
      command: "search",
      kind: "content",
      warnings: ["native warning"],
      data: {
        matches: [{ path: "src/app.ts", line: 4, text: "needle" }],
        summary: { matchCount: 1, truncated: true, timedOut: true },
      },
      metrics: {
        ripgrepMetrics: { searches: 2, bytesSearched: 8192, matches: 1 },
      },
    };
    const result = normalizeSearchResult(envelope, "content", {
      command: "search",
      regex: false,
      max: null,
      globCount: 0,
      typeCount: 0,
    });
    assert.equal(result.kind, "content");
    assert.deepEqual(result.matches, [{ path: "src/app.ts", line: 4, text: "needle" }]);
    assert.ok(result.warnings.includes("native warning"));
    assert.ok(result.warnings.includes("results truncated by max"));
    assert.ok(result.warnings.includes("search timed out"));
    assert.deepEqual(result.perf?.ripgrepMetrics, { searches: 2, bytesSearched: 8192, matches: 1 });
    assert.equal(result.perf?.xrayMetrics, undefined);
  });

  it("normalizes native windows-relative paths before exposing public matches", () => {
    const envelope: NativeSearchEnvelope = {
      ok: true,
      command: "files",
      kind: "files",
      data: {
        matches: [{ path: ".\\src\\a.ts" }, { path: ".\\src\\b.ts" }],
        summary: { fileCount: 2 },
      },
    };
    const result = normalizeSearchResult(envelope, "files", {
      command: "files",
      regex: false,
      max: null,
      globCount: 0,
      typeCount: 0,
    });
    assert.equal(result.kind, "files");
    assert.deepEqual(result.matches, [{ path: "src/a.ts" }, { path: "src/b.ts" }]);
  });
});
