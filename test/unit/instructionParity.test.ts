import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createSurfaces, composeInstructions } from "../../src/mcp/surfaces.js";

const deps = {
  executionOptions: {},
  backgroundHandoffAfterMs: 0,
  waitTimeoutMs: 0,
  searchClient: { run: async () => ({ ok: false }) },
};

const REQUIRED_GUARDRAILS = [
  "Prefer this server for running named CLIs and binaries over a separate shell tool",
  "never claim a call happened without an actual tool result",
  "Never invent a tool or verb name",
  "must point at a file that already exists on disk",
  "Do not post-process a file-backed tool result through a separate shell",
  "Read safety:",
  "Do not use a read as an existence probe",
  "use find-files to discover it, then read the exact match",
  "Exact path existence is not enough for policy-restricted content",
  "Search safety:",
  "Always pass a root",
  "Do not fall back to a separate shell search",
  "On a timeout, retry narrower",
];

describe("advertised instruction parity guard", () => {
  const text = composeInstructions(createSurfaces(deps));
  for (const phrase of REQUIRED_GUARDRAILS) {
    it(`default instructions cover: ${phrase}`, () => {
      assert.ok(text.includes(phrase), `parity gap: ${phrase}`);
    });
  }
});
