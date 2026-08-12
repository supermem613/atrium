import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { loadNativeSearchAddon } from "../../src/core/search/nativeAddon.js";

describe("native search addon loader", () => {
  it("loads the built addon and exports async searchContent and searchFiles", () => {
    const addon = loadNativeSearchAddon();

    if (addon === null) {
      throw new Error("Expected the native search addon to load (build it with `bun run build:native`)");
    }

    assert.equal(typeof addon.searchContent, "function");
    assert.equal(typeof addon.searchFiles, "function");
  });
});
