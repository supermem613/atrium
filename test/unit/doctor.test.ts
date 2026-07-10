import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

describe("doctor bundled ripgrep health", () => {
  it("reports a healthy bundled-ripgrep executable when resolved", async () => {
    const mod = await import("../../src/commands/doctor.js");
    const writes: string[] = [];
    const exitCodes: Array<number | undefined> = [];

    const originalWrite = process.stdout.write;
    const originalExit = process.exit;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    process.exit = ((code?: number) => {
      exitCodes.push(code);
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await assert.rejects(
        async () => {
          await mod.doctorCommand({ json: true });
        },
        /exit:0/,
      );
    } finally {
      process.stdout.write = originalWrite;
      process.exit = originalExit;
    }

    const payload = JSON.parse(writes.join(""));
    const bundledCheck = payload.checks.find((check: { name: string }) => check.name === "bundled-ripgrep");

    assert.ok(bundledCheck, "expected a bundled-ripgrep doctor check");
    assert.equal(bundledCheck.ok, true);
    assert.match(bundledCheck.detail, /resolved|healthy|bundled/i);
    assert.match(bundledCheck.detail, /bundled-ripgrep/i);
    assert.match(bundledCheck.detail, /native search/i);
  });
});
