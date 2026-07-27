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

describe("read surface tailoring", () => {
  it("advertises read-safety guardrails when read is enabled", () => {
    const text = composed();
    for (const phrase of [
      "Read safety:",
      "Do not use a read as an existence probe",
      "use find-files to discover it, then read the exact match",
      "Exact path existence is not enough for policy-restricted content",
    ]) {
      assert.ok(text.includes(phrase), `missing read guardrail: ${phrase}`);
    }
  });

  it("omits read-safety guardrails when read is disabled", () => {
    const text = composed(["core", "search"]);
    assert.equal(text.includes("Read safety:"), false, "read-safety present despite read disabled");
  });

  it("names the read tool as the executor of a nextRead continuation", () => {
    const text = composed();
    assert.ok(
      text.includes("Issue a nextRead continuation by passing its path, startByte, countBytes, and snapshot back to this read tool"),
      "nextRead does not name the tool that executes it",
    );
  });
});
