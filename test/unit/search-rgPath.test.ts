import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveBundledRgPath } from "../../src/core/search/rgPath.js";

describe("resolveBundledRgPath", () => {
  it("resolves the installed platform binary", () => {
    const result = resolveBundledRgPath();

    if (result === null) {
      throw new Error("Expected bundled ripgrep path to be resolved");
    }

    const expectedBin = process.platform === "win32" ? "rg.exe" : "rg";

    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
    assert.equal(path.basename(result), expectedBin);
    assert.ok(path.isAbsolute(result));
    assert.equal(existsSync(result), true);
  });
});
