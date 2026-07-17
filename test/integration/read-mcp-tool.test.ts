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
      for (const propertyName of ["path", "startLine", "endLine", "count", "startByte", "countBytes", "snapshot"]) {
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
      const meta = parsed.meta as Record<string, unknown>;
      assert.equal(meta.totalLines, 3);
      assert.equal(meta.bytes, Buffer.byteLength(fileContent, "utf8"));
      assert.equal(meta.timing, undefined, "default read should not expose the per-phase timing breakdown");
      const timingMs = numberField(parsed, "timingMs");
      assert.equal(timingMs >= 0, true);
      assert.equal(parsed.perf, undefined, "default read should not expose perf detail");
      assert.equal(parsed.content, "two\nthree\n");

      const repeated = await callJson(client, "read", { path: filePath, startLine: 2, endLine: 99 });
      assert.equal(repeated.ok, true);
      assert.equal(repeated.path, filePath);
      assert.deepEqual(repeated.range, [2, 3]);
      assert.equal(repeated.content, "two\nthree\n");
      const repeatedMeta = repeated.meta as Record<string, unknown>;
      const repeatedCache = repeatedMeta.cache as Record<string, unknown> | undefined;
      assert.ok(repeatedCache, "expected repeated read to expose cache metadata");
      assert.equal(repeatedCache.hit, true);
      assert.equal(repeatedCache.reason, "same-file");

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

  it("line-mode reads always carry nextRead; oversized reads return a byte continuation over the materialized artifact", async () => {
    const server = createAtriumServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const dir = await mkdtemp(join(tmpdir(), "atrium-read-linemode-"));
      const smallFixturePath = join(dir, "small.txt");
      const smallFixtureContent = "alpha\nbeta\n";
      await writeFile(smallFixturePath, smallFixtureContent);

      const small = await callJson(client, "read", { path: smallFixturePath, startLine: 1, endLine: 2 });
      assert.equal(small.ok, true);
      assert.equal(typeof small.content, "string");
      assert.equal(small.nextRead, null, "line-mode nextRead is missing or not the required artifact byte continuation");

      const oversizedSingleLinePath = join(dir, "single-line.txt");
      const oversizedSingleLineContent = "x".repeat(9000);
      await writeFile(oversizedSingleLinePath, oversizedSingleLineContent);

      const oversizedSingleLine = await callJson(client, "read", { path: oversizedSingleLinePath, startLine: 1, endLine: 1 });
      assert.equal(oversizedSingleLine.ok, true);
      await verifyLineModeContinuationChain(client, oversizedSingleLine, oversizedSingleLineContent, 8192, "oversized single-line");

      const oversizedMultiLinePath = join(dir, "multi-line.txt");
      const oversizedMultiLineContent = ["prefix-", "x".repeat(4000), "y".repeat(4000), "z".repeat(4000)].join("\n");
      await writeFile(oversizedMultiLinePath, oversizedMultiLineContent);

      const oversizedMultiLine = await callJson(client, "read", { path: oversizedMultiLinePath, startLine: 1, endLine: 4 });
      assert.equal(oversizedMultiLine.ok, true);
      await verifyLineModeContinuationChain(client, oversizedMultiLine, oversizedMultiLineContent, 8192, "oversized multi-line");
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });
});

async function verifyLineModeContinuationChain(
  client: Client,
  initial: Record<string, unknown>,
  expectedContent: string,
  countBytes: number,
  label: string,
): Promise<void> {
  assert.equal(typeof initial.content, "object", `${label} should materialize oversized content as a file value`);
  const content = initial.content as Record<string, unknown>;
  assert.ok(content, `${label} should materialize oversized content as a file value`);
  assert.equal(typeof content.file, "string", `${label} should expose the materialized artifact path`);
  const artifactPath = content.file as string;
  const artifactBytes = numberField(content, "bytes");
  assert.equal(artifactBytes, Buffer.byteLength(expectedContent, "utf8"), `${label} should report the exact byte length`);

  const nextRead = initial.nextRead as Record<string, unknown> | undefined | null;
  const hasRequiredContinuation = nextRead !== null && nextRead !== undefined && nextRead.path === artifactPath && nextRead.startByte === 0 && nextRead.countBytes === countBytes && typeof nextRead.snapshot === "string" && nextRead.snapshot !== "";
  assert.ok(hasRequiredContinuation, "line-mode nextRead is missing or not the required artifact byte continuation");

  let current: Record<string, unknown> = initial;
  const pages: string[] = [];
  let previousStartByte = -1;
  let pageCount = 0;
  while (true) {
    if (typeof current.content === "string") {
      pages.push(current.content as string);
      const byteRange = current.byteRange as [number, number] | undefined;
      assert.ok(byteRange, `${label} should expose the byte range on each page`);
      assert.ok(byteRange[0] > previousStartByte, `${label} should advance through the byte pages`);
      previousStartByte = byteRange[0];
      pageCount += 1;
    }

    const continuation = current.nextRead as Record<string, unknown> | undefined | null;
    if (continuation === null || continuation === undefined) {
      break;
    }

    current = await callJson(client, "read", {
      path: continuation.path as string,
      startByte: continuation.startByte as number,
      countBytes: continuation.countBytes as number,
      snapshot: continuation.snapshot as string,
    });
    assert.equal(current.ok, true);
  }

  assert.equal(pageCount, Math.ceil(artifactBytes / countBytes), `${label} should use ${Math.ceil(artifactBytes / countBytes)} byte pages`);
  assert.equal(pages.join(""), expectedContent, `${label} should reconstruct the selected content exactly`);
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

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    assert.fail(`${key} should be a number`);
  }
  return value;
}
