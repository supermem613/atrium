import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";

describe("read MCP tool", () => {
  it("exposes the lean read contract with deterministic range clamping", async () => {
    const server = createAtriumServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listedTools = await client.listTools();
      const readTool = listedTools.tools.find((candidate) => candidate.name === "read");
      assert.ok(readTool, "expected read to be listed");

      const inputSchema = readTool.inputSchema as Record<string, unknown>;
      const properties = inputSchema.properties as Record<string, unknown> | undefined;
      assert.ok(properties, "read should expose properties");
      for (const propertyName of ["path", "startLine", "endLine", "count"]) {
        assert.ok(properties[propertyName], `read should define ${propertyName}`);
      }
      assert.deepEqual(inputSchema.required, ["path"]);

      const dir = await mkdtemp(join(tmpdir(), "atrium-read-"));
      const filePath = join(dir, "sample.txt");
      const fileContent = "one\ntwo\nthree\n";
      await writeFile(filePath, fileContent);

      const parsed = await callJson(client, "read", { path: filePath, startLine: 2, endLine: 99 });
      assert.equal(parsed.ok, true);
      assert.equal(parsed.path, filePath);
      assert.deepEqual(parsed.range, [2, 3]);
      assert.deepEqual(parsed.meta, { totalLines: 3, bytes: Buffer.byteLength(fileContent, "utf8") });
      assert.equal(parsed.content, "two\nthree\n");

      const missingPath = join(dir, "missing", "nope.txt");
      await mkdir(join(dir, "missing"));
      const missing = await callJson(client, "read", { path: missingPath });
      assert.equal(missing.ok, false);
      assert.equal(missing.status, "not-found");
      assert.equal(missing.path, missingPath);
      assert.equal(typeof missing.hint, "string");
      assert.notEqual(missing.hint, "");
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });
});

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
