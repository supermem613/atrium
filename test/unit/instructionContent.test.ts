import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createSurfaces, composeInstructions } from "../../src/mcp/surfaces.js";

function defaultInstructions(): string {
  return composeInstructions(
    createSurfaces({
      executionOptions: {},
      backgroundHandoffAfterMs: 0,
      waitTimeoutMs: 0,
      searchClient: { run: async () => ({ ok: false }) },
    }),
  );
}

describe("core guardrail instructions", () => {
  const required = [
    "Prefer this server for running named CLIs and binaries over a separate shell tool",
    "never claim a call happened without an actual tool result",
    "Never invent a tool or verb name",
    "must point at a file that already exists on disk",
    "Do not post-process a file-backed tool result through a separate shell",
  ];
  for (const phrase of required) {
    it(`advertises the core guardrail: ${phrase}`, () => {
      assert.ok(defaultInstructions().includes(phrase), `missing core guardrail: ${phrase}`);
    });
  }
});
