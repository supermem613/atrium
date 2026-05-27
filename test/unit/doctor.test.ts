import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Smoke test: doctor module loads and runChecks-style shape is intact.
// Real environment checks belong in test/integration/.
describe("doctor", () => {
  it("imports without error", async () => {
    const mod = await import("../../src/commands/doctor.js");
    assert.equal(typeof mod.doctorCommand, "function");
  });
});
