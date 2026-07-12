import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createSurfaces, composeInstructions, selectEnabledSurfaces } from "../../src/mcp/surfaces.js";

const deps = {
  executionOptions: {},
  backgroundHandoffAfterMs: 0,
  waitTimeoutMs: 0,
  searchClient: { run: async () => ({ ok: false }) },
};

function composed(selection?: string[]): string {
  return composeInstructions(selectEnabledSurfaces(createSurfaces(deps), selection));
}

describe("search surface tailoring", () => {
  it("advertises search guardrails when search is enabled", () => {
    const text = composed();
    for (const phrase of [
      "Search safety:",
      "Always pass a root",
      "grep-code for git-aware code content search",
      "Do not fall back to a separate shell search",
      "On a timeout, retry narrower",
    ]) {
      assert.ok(text.includes(phrase), `missing search guardrail: ${phrase}`);
    }
  });

  it("omits search guardrails when search is disabled", () => {
    const text = composed(["core", "read"]);
    assert.equal(text.includes("Search safety:"), false, "search-safety present despite search disabled");
  });
});
