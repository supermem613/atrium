import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseServerArgv } from "../../src/server.js";

describe("atrium-mcp entrypoint argument parsing", () => {
  it("parses --surface into a server selection", () => {
    assert.deepEqual(parseServerArgv(["node", "server.js", "--surface", "core,read"]), {
      surfaces: ["core", "read"],
    });
  });

  it("accumulates repeated --surface flags", () => {
    assert.deepEqual(
      parseServerArgv(["node", "server.js", "--surface", "core", "--surface", "read"]),
      { surfaces: ["core", "read"] },
    );
  });

  it("leaves the selection undefined when --surface is absent", () => {
    assert.deepEqual(parseServerArgv(["node", "server.js"]), { surfaces: undefined });
  });
});
