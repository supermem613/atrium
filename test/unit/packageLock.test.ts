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
    // The invariant is that each peer resolves to an installable lock entry, not that it sits at
    // one specific version, so a legitimate upstream bump must not turn this guard red.
    for (const name of ["@emnapi/core", "@emnapi/runtime"]) {
      const packageEntry: unknown = lock.packages[`node_modules/${name}`];
      assert.ok(isRecord(packageEntry), `missing lock entry for ${name}`);
      assert.match(String(packageEntry.version), /^\d+\.\d+\.\d+/, `${name} needs a resolved version`);
      assert.match(String(packageEntry.resolved), /^https?:\/\//, `${name} needs a resolved tarball URL`);
      assert.match(String(packageEntry.integrity), /^sha\d+-/, `${name} needs an integrity hash`);
    }
  });
});
