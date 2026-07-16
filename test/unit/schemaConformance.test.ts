import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";
import type { XrayEnvelope, XrayRunOptions, XraySearchClientLike } from "../../src/core/search/types.js";

class RecordingSearchClient implements XraySearchClientLike {
  async run(options: XrayRunOptions): Promise<XrayEnvelope> {
    if (options.command === "files") {
      return { ok: true, command: "files", data: { matches: [{ path: "src/a.ts" }], summary: { fileCount: 1 } } };
    }
    return { ok: true, command: "search", data: { matches: [{ path: "src/a.ts", line: 1, text: "hit" }], summary: { matchCount: 1, fileCount: 1 } } };
  }
}

describe("schema conformance", () => {
  it("advertises a non-empty property set for every tool", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      assert.ok(listed.tools.length > 0, "expected at least one advertised tool");
      for (const tool of listed.tools) {
        const inputSchema = tool.inputSchema as Record<string, unknown>;
        const properties = inputSchema.properties as Record<string, unknown> | undefined;
        assert.ok(properties, `${tool.name} should advertise properties`);
        assert.equal(typeof properties, "object");
        assert.ok(Object.keys(properties).length > 0, `${tool.name} should advertise a non-empty property set`);
      }
    });
  });

  it("advertises run.args as a flat union of string, {file}, and array rather than a bare array", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      const run = listed.tools.find((tool) => tool.name === "run");
      assert.ok(run, "expected run to be listed");
      const properties = (run.inputSchema as Record<string, unknown>).properties as Record<string, unknown>;
      const argsSchema = properties.args as Record<string, unknown>;

      assert.ok(Array.isArray(argsSchema.anyOf), "run.args should advertise anyOf, not a bare array");
      assert.notEqual(argsSchema.type, "array", "run.args should not advertise as a bare array");

      const options = flattenUnion(argsSchema);
      assert.ok(options.some((option) => option.type === "string"), "run.args should accept a lone string");
      assert.ok(
        options.some((option) => option.type === "object" && (option.properties as Record<string, unknown> | undefined)?.file !== undefined),
        "run.args should accept the {file} variant",
      );
      assert.ok(options.some((option) => option.type === "array"), "run.args should accept an array");
    });
  });

  it("normalizes and executes every scalar/string shape rather than throwing opaquely", async () => {
    const directory = atriumTempPath("conformance read");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "lines.txt");
    await writeFile(file, "l1\nl2\nl3\nl4\nl5\n");

    const rows: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "run", args: { tool: process.execPath, args: "-v" } },
      { tool: "grep", args: { root: directory, query: "hit", regex: "true", max: "5" } },
      { tool: "grep-code", args: { root: directory, query: "hit", regex: "true", max: "5" } },
      { tool: "find-files", args: { root: directory, max: "5" } },
      { tool: "read", args: { path: file, startLine: "1", count: "2" } },
      { tool: "read", args: { path: file, startByte: "0", countBytes: "4" } },
    ];

    try {
      await withServer(async (client) => {
        for (const row of rows) {
          const outcome = await call(client, row.tool, row.args);
          assert.ok(outcome.text.length > 0, `${row.tool} returned empty content`);
          assert.equal(outcome.isError, false, `${row.tool} rejected a coercible scalar shape: ${outcome.text}`);
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function flattenUnion(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    return (anyOf as Array<Record<string, unknown>>).flatMap(flattenUnion);
  }
  return [schema];
}

async function withServer<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const server = createAtriumServer({ searchClient: new RecordingSearchClient() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-test", version: "0.5.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const response = await client.callTool({ name, arguments: args });
  const content = (Array.isArray(response.content) ? response.content : []) as Array<{ text?: string }>;
  return { isError: response.isError === true, text: content[0]?.text ?? "" };
}
