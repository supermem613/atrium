import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";

describe("read MCP tool byte paging", () => {
  it("pages a single-line JSON artifact across inline byte ranges", async () => {
    const server = createAtriumServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const dir = await mkdtemp(join(tmpdir(), "atrium-byte-paging-"));
      const filePath = join(dir, "artifact.json");
      const payload = `{"artifact":"${"x".repeat(20_000)}"}`;
      await writeFile(filePath, payload);

      const first = await callJson(client, "read", { path: filePath, startByte: 0, countBytes: 4096 });
      assert.equal(first.ok, true);
      assert.equal(typeof first.content, "string");
      assert.equal(Array.isArray(first.content), false);
      assert.deepEqual(first.byteRange, [0, 4096]);
      const meta = first.meta as Record<string, unknown>;
      assert.equal(meta.totalBytes, Buffer.byteLength(payload, "utf8"));
      const firstNextRead = first.nextRead as Record<string, unknown>;
      assert.equal(firstNextRead.startByte, 4096);

      const pages = [first];
      let current = first as Record<string, unknown>;
      while (true) {
        const nextRead = current.nextRead as Record<string, unknown> | null | undefined;
        if (nextRead === null || nextRead === undefined) {
          break;
        }
        current = await callJson(client, "read", {
          path: filePath,
          startByte: nextRead.startByte as number,
          countBytes: 4096,
        });
        pages.push(current);
      }

      const concatenated = pages.map((page) => page.content as string).join("");
      assert.equal(concatenated, payload);
      const lastPage = pages[pages.length - 1];
      assert.deepEqual(lastPage.byteRange, [4096 * (pages.length - 1), Buffer.byteLength(payload, "utf8")]);
      assert.equal((lastPage.meta as Record<string, unknown>).totalBytes, Buffer.byteLength(payload, "utf8"));
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });
  it("pages UTF-8-safe content across byte boundaries without splitting codepoints", async () => {
    const server = createAtriumServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const dir = await mkdtemp(join(tmpdir(), "atrium-byte-paging-"));
      const filePath = join(dir, "artifact.json");
      const segment = "é漢😀\"\\\n\t𐍈💩";
      const content = Array.from({ length: 3_000 }, () => segment).join("");
      const payload = JSON.stringify({ fixture: content });
      await writeFile(filePath, payload);

      assert.ok(Buffer.byteLength(payload, "utf8") >= 20_000);

      const pages: Array<Record<string, unknown>> = [];
      let current = await callJson(client, "read", { path: filePath, startByte: 0, countBytes: 8192 });
      assert.equal(current.ok, true);
      assert.equal(typeof current.content, "string");
      assert.equal(Array.isArray(current.content), false);
      assert.equal((current.content as string).includes("\uFFFD"), false);
      assert.ok(Buffer.byteLength(current.content as string, "utf8") <= 8192);
      const firstRange = current.byteRange as [number, number];
      assert.ok(firstRange[1] > firstRange[0]);
      assert.ok(firstRange[1] <= 8192);
      pages.push(current);

      while (true) {
        const nextRead = current.nextRead as Record<string, unknown> | null | undefined;
        if (nextRead === null || nextRead === undefined) {
          break;
        }
        current = await callJson(client, "read", {
          path: filePath,
          startByte: nextRead.startByte as number,
          countBytes: 8192,
        });
        assert.equal((current.content as string).includes("\uFFFD"), false);
        assert.ok(Buffer.byteLength(current.content as string, "utf8") > 0);
        const range = current.byteRange as [number, number];
        assert.ok(range[1] > range[0]);
        assert.ok((range[1] - range[0]) > 0);
        pages.push(current);
      }

      const concatenated = pages.map((page) => page.content as string).join("");
      assert.equal(Buffer.from(concatenated, "utf8").equals(Buffer.from(payload, "utf8")), true);
      assert.ok(pages.length > 1);
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("returns EOF at 8192 bytes and requests a second page at 8193 bytes", async () => {
    const server = createAtriumServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const dir = await mkdtemp(join(tmpdir(), "atrium-byte-paging-"));
      const filePath = join(dir, "artifact.txt");
      const exact8192 = "a".repeat(8192);
      const exact8193 = "b".repeat(8193);
      await writeFile(filePath, exact8192);

      const firstPage = await callJson(client, "read", { path: filePath, startByte: 0, countBytes: 8192 });
      assert.deepEqual(firstPage.byteRange, [0, 8192]);
      assert.equal(firstPage.content, exact8192);
      assert.equal(firstPage.nextRead, null);

      await writeFile(filePath, exact8193);
      const firstPage8193 = await callJson(client, "read", { path: filePath, startByte: 0, countBytes: 8192 });
      assert.deepEqual(firstPage8193.byteRange, [0, 8192]);
      assert.equal(firstPage8193.content, exact8193.slice(0, 8192));
      assert.equal((firstPage8193.nextRead as Record<string, unknown> | null | undefined)?.startByte, 8192);

      const secondPage8193 = await callJson(client, "read", { path: filePath, startByte: 8192, countBytes: 8192 });
      assert.deepEqual(secondPage8193.byteRange, [8192, 8193]);
      assert.equal(secondPage8193.content, exact8193.slice(8192));
      assert.equal(secondPage8193.nextRead, null);

      const concatenated = `${firstPage8193.content}${secondPage8193.content}`;
      assert.equal(Buffer.from(concatenated, "utf8").equals(Buffer.from(exact8193, "utf8")), true);
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("does not split a multibyte character when the requested byte count falls inside it", async () => {
    const server = createAtriumServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const dir = await mkdtemp(join(tmpdir(), "atrium-byte-paging-"));
      const filePath = join(dir, "artifact.txt");
      const payload = "😀A";
      await writeFile(filePath, payload);

      const firstPage = await callJson(client, "read", { path: filePath, startByte: 0, countBytes: 3 });
      assert.equal(firstPage.content, "😀");
      assert.deepEqual(firstPage.byteRange, [0, 4]);
      assert.equal((firstPage.nextRead as Record<string, unknown> | null | undefined)?.startByte, 4);

      const secondPage = await callJson(client, "read", { path: filePath, startByte: 4, countBytes: 3 });
      assert.equal(secondPage.content, "A");
      assert.deepEqual(secondPage.byteRange, [4, 5]);
      assert.equal(secondPage.nextRead, null);
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("returns a stable snapshot token and rejects stale byte-page continuations after source mutation", async () => {
    const server = createAtriumServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const dir = await mkdtemp(join(tmpdir(), "atrium-byte-paging-"));
      const filePath = join(dir, "artifact.txt");
      const originalContent = "x".repeat(4096);
      await writeFile(filePath, originalContent);

      const firstPage = await callJson(client, "read", { path: filePath, startByte: 0, countBytes: 4096 });
      const firstSnapshot = firstPage.snapshot;
      assert.equal(typeof firstSnapshot, "string");
      assert.ok((firstSnapshot as string).length > 0);

      const secondPage = await callJson(client, "read", { path: filePath, startByte: 0, countBytes: 4096 });
      assert.equal(secondPage.snapshot, firstSnapshot);

      const mutatedContent = "y".repeat(8192);
      await writeFile(filePath, mutatedContent);

      const staleContinuation = await callJson(client, "read", {
        path: filePath,
        startByte: 4096,
        countBytes: 4096,
        snapshot: firstSnapshot,
      });

      assert.equal(staleContinuation.ok, false);
      assert.equal(staleContinuation.status, "mutation_rejected");
      assert.equal(typeof staleContinuation.hint, "string");
      assert.ok((staleContinuation.hint as string).length > 0);
      assert.equal("content" in staleContinuation, false);
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
