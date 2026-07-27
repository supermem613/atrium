import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = createAtriumServer({ searchClient: { run: async () => ({ ok: false }) } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await serverTransport.close();
  }
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(response.content));
  const firstContent = response.content[0];
  assert.equal(typeof firstContent, "object");
  assert.notEqual(firstContent, null);
  assert.equal("text" in firstContent, true);
  assert.equal(typeof firstContent.text, "string");
  return JSON.parse(firstContent.text) as Record<string, unknown>;
}

describe("schema self-description", () => {
  it("describes an Atrium verb addressed by its namespaced tool name", async () => {
    await withClient(async (client) => {
      const parsed = await callJson(client, "schema", { tool: "atrium-grep" });

      assert.equal(parsed.ok, true);
      assert.equal(parsed.source, "atrium");
      assert.equal(parsed.tool, "atrium-grep");

      const data = parsed.data as Record<string, unknown>;
      assert.equal(data.name, "grep");
      assert.equal(typeof data.title, "string");
      assert.match(String(data.description), /content search/i);

      const parameters = data.parameters as Array<Record<string, unknown>>;
      const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
      assert.equal(byName.get("root")?.required, true);
      assert.equal(byName.get("query")?.required, true);
      assert.equal(byName.get("regex")?.required, false);
      assert.match(String(byName.get("query")?.description), /array of patterns/i);
    });
  });

  it("accepts the dotted server-qualified form for the same verb", async () => {
    await withClient(async (client) => {
      const dotted = await callJson(client, "schema", { tool: "atrium.read" });
      assert.equal(dotted.source, "atrium");
      assert.equal((dotted.data as Record<string, unknown>).name, "read");
    });
  });

  it("falls back to its own verb schema when a bare Atrium verb is not an executable", async () => {
    await withClient(async (client) => {
      const parsed = await callJson(client, "schema", { tool: "grep-code" });

      assert.equal(parsed.ok, true);
      assert.equal(parsed.source, "atrium");
      assert.equal((parsed.data as Record<string, unknown>).name, "grep-code");
    });
  });

  it("explains that tool names an executable when no Atrium verb matches", async () => {
    await withClient(async (client) => {
      const parsed = await callJson(client, "schema", { tool: "definitely-not-a-real-binary-xyz" });

      assert.equal(parsed.ok, false);
      const error = parsed.error as Record<string, unknown>;
      assert.match(String(error.message), /executable/i);
      assert.match(String(error.message), /atrium-grep/);
    });
  });
});
