import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { NativeSearchAddon } from "../../src/core/search/nativeAddon.js";

describe("doctor native search addon health", () => {
  it("wires a native-search-addon check into the doctor report", async () => {
    const mod = await import("../../src/commands/doctor.js");
    const writes: string[] = [];

    const originalWrite = process.stdout.write;
    const originalExit = process.exit;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await assert.rejects(async () => {
        await mod.doctorCommand({ json: true });
      });
    } finally {
      process.stdout.write = originalWrite;
      process.exit = originalExit;
    }

    const payload = JSON.parse(writes.join(""));
    const addonCheck = payload.checks.find((check: { name: string }) => check.name === "native-search-addon");
    assert.ok(addonCheck, "expected a native-search-addon doctor check");
  });

  it("reports in-process acceleration when the addon loads", async () => {
    const mod = await import("../../src/commands/doctor.js");
    const stubAddon = {
      searchContent: async () => ({ matches: [], truncated: false, timedOut: false }),
      searchFiles: async () => ({ paths: [], truncated: false, timedOut: false }),
    } as unknown as NativeSearchAddon;

    const check = mod.checkNativeSearchAddon(() => stubAddon);

    assert.equal(check.name, "native-search-addon");
    assert.equal(check.ok, true);
    assert.match(check.detail, /in-process/i);
  });

  it("fails when the addon is absent so the broken search surfaces", async () => {
    const mod = await import("../../src/commands/doctor.js");

    const check = mod.checkNativeSearchAddon(() => null);

    assert.equal(check.name, "native-search-addon");
    assert.equal(check.ok, false, "a missing addon must fail doctor");
    assert.doesNotMatch(check.detail, /bundled ripgrep/i);
    assert.ok(check.hint, "expected a remediation hint when the addon is absent");
    assert.match(check.hint, /build:native|prebuilt/i);
  });
});
