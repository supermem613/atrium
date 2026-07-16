import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import { atriumTempPath } from "../../src/core/tempPaths.js";

describe("run args string shape", () => {
  it("executes a lone string arg as exactly one argument and never splits a spaced path", async () => {
    const directory = atriumTempPath("arg shape dir");
    await mkdir(directory, { recursive: true });
    const script = join(directory, "argCount.mjs");
    await writeFile(script, "process.stdout.write(String(process.argv.slice(2).length));");

    try {
      await withInMemoryClient(async (client) => {
        const result = await callRun(client, { tool: process.execPath, args: script });
        assert.equal(result.ok, true);
        assert.equal(result.stdout, "0");
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still accepts the array form", async () => {
    const directory = atriumTempPath("arg shape dir array");
    await mkdir(directory, { recursive: true });
    const script = join(directory, "argCount.mjs");
    await writeFile(script, "process.stdout.write(String(process.argv.slice(2).length));");

    try {
      await withInMemoryClient(async (client) => {
        const result = await callRun(client, { tool: process.execPath, args: [script] });
        assert.equal(result.ok, true);
        assert.equal(result.stdout, "0");
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function callRun(client: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name: "run", arguments: args });
  const content = (Array.isArray(response.content) ? response.content : []) as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? "";
  if (response.isError === true) {
    throw new Error(`run rejected args: ${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function withInMemoryClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-test", version: "0.5.0" });
  const server = createAtriumServer();

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
