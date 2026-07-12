import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveBundledRgPath, resolveBundledRgPathWith } from "../../src/core/search/rgPath.js";

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

describe("resolveBundledRgPathWith existence guard", () => {
  it("returns null when the resolved binary is missing from disk", () => {
    const result = resolveBundledRgPathWith({
      loadRgPath: () => "C:\\atrium-test\\does-not-exist\\rg.exe",
      fileExists: () => false,
    });

    assert.equal(result, null);
  });

  it("returns the resolved path when the binary exists on disk", () => {
    const bin = "C:\\atrium-test\\bundled\\rg.exe";
    const result = resolveBundledRgPathWith({
      loadRgPath: () => bin,
      fileExists: (candidate) => candidate === bin,
    });

    assert.equal(result, bin);
  });
});
