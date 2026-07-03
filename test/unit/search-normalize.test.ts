import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeXrayResult } from "../../src/core/search/normalize.js";
import type { XrayEnvelope } from "../../src/core/search/types.js";

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
});
