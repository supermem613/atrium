import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";

describe("MCP initialize instructions", () => {
  it("advertises the hard constraints to the client at handshake", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "atrium-test", version: "0.5.0" });
    const server = createAtriumServer();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const instructions = client.getInstructions();
      assert.equal(typeof instructions, "string");
      assert.equal((instructions as string).length > 0, true);

      const text = instructions as string;
      assert.match(text, /Shells are denied/);
      assert.match(text, /one execution behavior/);
      assert.match(text, /operationId/);
      assert.match(text, /nextCheck/);
      assert.match(text, /operation-wait/);
      assert.match(text, /\{file: path\}/);
      assert.match(text, /native search/i);
      assert.match(text, /bundled-ripgrep/i);
    } finally {
      await client.close();
    }
  });
});
