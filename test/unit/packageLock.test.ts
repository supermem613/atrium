import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("package lock", () => {
  it("contains the emnapi peer packages required by the native build CLI", () => {
    const lock: unknown = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    assert.ok(isRecord(lock));
    assert.ok(isRecord(lock.packages));

    // Guards CI run 29293976143, where npm ci failed because these resolved packages were omitted.
    for (const [name, version] of [
      ["@emnapi/core", "1.11.2"],
      ["@emnapi/runtime", "1.11.2"],
    ]) {
      const packageEntry: unknown = lock.packages[`node_modules/${name}`];
      assert.ok(isRecord(packageEntry), `missing lock entry for ${name}`);
      assert.equal(packageEntry.version, version);
    }
  });
});
