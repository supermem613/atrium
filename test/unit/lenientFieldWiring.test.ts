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
  public calls: XrayRunOptions[] = [];

  async run(options: XrayRunOptions): Promise<XrayEnvelope> {
    this.calls.push(options);
    if (options.command === "files") {
      return { ok: true, command: "files", data: { matches: [{ path: "src/a.ts" }], summary: { fileCount: 1 } } };
    }
    return { ok: true, command: "search", data: { matches: [{ path: "src/a.ts", line: 1, text: "hit" }], summary: { matchCount: 1, fileCount: 1 } } };
  }
}

describe("lenient field wiring", () => {
  it("read accepts numeric-string startLine and count", async () => {
    const directory = atriumTempPath("field wiring read");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "lines.txt");
    await writeFile(file, "l1\nl2\nl3\nl4\nl5\n");

    try {
      await withServer(async (client) => {
        const result = await call(client, "read", { path: file, startLine: "2", count: "3" });
        assert.equal(result.isError, false, result.text);
        assert.equal(result.json?.ok, true);
        assert.deepStrictEqual(result.json?.range, [2, 4]);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("find-files accepts a numeric-string max", async () => {
    await withServer(async (client, search) => {
      const result = await call(client, "find-files", { root: "/tmp/x", max: "5" });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.json?.kind, "files");
      assert.equal(search.calls.at(-1)?.max, 5);
    });
  });

  it("grep and grep-code accept a string regex flag and search in regex mode", async () => {
    await withServer(async (client, search) => {
      for (const tool of ["grep", "grep-code"] as const) {
        const result = await call(client, tool, { root: "/tmp/x", query: "a.b", regex: "true" });
        assert.equal(result.isError, false, result.text);
        assert.equal(result.json?.kind, "content");
        assert.equal(search.calls.at(-1)?.regex, true);
      }
    });
  });

  it("grep accepts a numeric-string max", async () => {
    await withServer(async (client, search) => {
      const result = await call(client, "grep", { root: "/tmp/x", query: "needle", max: "5" });
      assert.equal(result.isError, false, result.text);
      assert.equal(search.calls.at(-1)?.max, 5);
    });
  });

  it("rejects non-coercible field values instead of silently coercing", async () => {
    await withServer(async (client) => {
      const badLine = await call(client, "read", { path: "/tmp/x", startLine: "abc" });
      assert.equal(badLine.isError, true);
      const badRegex = await call(client, "grep", { root: "/tmp/x", query: "n", regex: "yes" });
      assert.equal(badRegex.isError, true);
    });
  });

  it("rejects an empty query array so a search always has at least one pattern", async () => {
    await withServer(async (client) => {
      for (const tool of ["grep", "grep-code"] as const) {
        const result = await call(client, tool, { root: "/tmp/x", query: [] });
        assert.equal(result.isError, true, `${tool} accepted an empty query array`);
      }
    });
  });
});

async function withServer<T>(
  callback: (client: Client, search: RecordingSearchClient) => Promise<T>,
): Promise<T> {
  const search = new RecordingSearchClient();
  const server = createAtriumServer({ searchClient: search });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-test", version: "0.5.0" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    return await callback(client, search);
  } finally {
    await client.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; json: Record<string, unknown> | undefined; text: string }> {
  const response = await client.callTool({ name, arguments: args });
  const content = (Array.isArray(response.content) ? response.content : []) as Array<{ text?: string }>;
  const text = content[0]?.text ?? "";
  const isError = response.isError === true;
  return { isError, json: isError ? undefined : (JSON.parse(text) as Record<string, unknown>), text };
}
