import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import { parseSurfaceArg } from "../../src/mcp/surfaces.js";

describe("--surface CLI argument parsing", () => {
  it("parses a comma-separated surface list into a selection", () => {
    assert.deepEqual(parseSurfaceArg("core,read"), ["core", "read"]);
  });

  it("accumulates repeated --surface values", () => {
    const first = parseSurfaceArg("core");
    const both = parseSurfaceArg("read", first);
    assert.deepEqual(both, ["core", "read"]);
  });

  it("trims whitespace and drops empty entries", () => {
    assert.deepEqual(parseSurfaceArg(" core , read , "), ["core", "read"]);
  });

  it("builds a server that omits search tools for the parsed selection", async () => {
    const selection = parseSurfaceArg("core,read");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cli-surface-test", version: "0.0.0" });
    const server = createAtriumServer({ surfaces: selection });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((tool) => tool.name));
      assert.equal(names.has("read"), true);
      assert.equal(names.has("grep"), false);
      assert.equal(names.has("grep-code"), false);
      assert.equal(names.has("find-files"), false);
    } finally {
      await client.close();
    }
  });
});
