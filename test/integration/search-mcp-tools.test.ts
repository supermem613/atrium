import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import type { XrayEnvelope, XrayRunOptions, XraySearchClientLike } from "../../src/core/search/types.js";

class FakeXrayClient implements XraySearchClientLike {
  public calls: XrayRunOptions[] = [];

  async run(options: XrayRunOptions): Promise<XrayEnvelope> {
    this.calls.push(options);
    if (options.command === "files") {
      return { ok: true, command: "files", data: { matches: [{ path: "src/one.ts" }, { path: "src/two.ts" }], summary: { fileCount: 2 } } };
    }
    return { ok: true, command: "search", data: { matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], summary: { matchCount: 1, fileCount: 1 } } };
  }
}

describe("search MCP tools", () => {
  it("exposes the five verbs with stable schemas and routes calls to xray", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listedTools = await client.listTools();
      const visibleToolNames = listedTools.tools.map((tool) => tool.name);
      for (const expectedName of ["find-files", "grep", "multi-grep", "grep-code", "multi-grep-code"]) {
        assert.ok(visibleToolNames.includes(expectedName), `expected ${expectedName} to be listed`);
      }

      for (const toolName of ["grep", "grep-code"] as const) {
        const tool = listedTools.tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool, `expected ${toolName} to be listed`);
        const inputSchema = tool.inputSchema as Record<string, unknown>;
        const properties = inputSchema.properties as Record<string, unknown> | undefined;
        assert.ok(properties, `${toolName} should expose properties`);
        for (const propertyName of ["root", "query", "glob", "exclude", "max", "timeoutMs"]) {
          assert.ok(properties?.[propertyName], `${toolName} should define ${propertyName}`);
        }
        const required = inputSchema.required as string[] | undefined;
        assert.ok(required?.includes("root"), `${toolName} should require root`);
        assert.ok(required?.includes("query"), `${toolName} should require query`);
      }

      for (const toolName of ["multi-grep", "multi-grep-code"] as const) {
        const tool = listedTools.tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool, `expected ${toolName} to be listed`);
        const inputSchema = tool.inputSchema as Record<string, unknown>;
        const properties = inputSchema.properties as Record<string, unknown> | undefined;
        assert.ok(properties, `${toolName} should expose properties`);
        for (const propertyName of ["root", "queries", "glob", "exclude", "max", "timeoutMs"]) {
          assert.ok(properties?.[propertyName], `${toolName} should define ${propertyName}`);
        }
        assert.equal(properties?.query, undefined, `${toolName} should not define a single query`);
        const queriesSchema = properties?.queries as Record<string, unknown>;
        assert.equal(queriesSchema.type, "array", `${toolName} queries should be an array`);
        const required = inputSchema.required as string[] | undefined;
        assert.ok(required?.includes("root"), `${toolName} should require root`);
        assert.ok(required?.includes("queries"), `${toolName} should require queries`);
        assert.ok(!required?.includes("query"), `${toolName} should not require query`);
      }

      const findFiles = listedTools.tools.find((candidate) => candidate.name === "find-files");
      assert.ok(findFiles, "expected find-files to be listed");
      const findFilesSchema = findFiles.inputSchema as Record<string, unknown>;
      const findFilesProperties = findFilesSchema.properties as Record<string, unknown> | undefined;
      assert.deepEqual(Object.keys(findFilesProperties ?? {}).sort(), ["exclude", "glob", "max", "root", "timeoutMs"]);
      assert.deepEqual(findFilesSchema.required, ["root"]);

      const contentArguments = { root: "/tmp/x", query: "needle", glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 250 };
      const expectedContentResult = { kind: "content", matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], warnings: [] };
      const singleRouting = [
        { name: "grep", expected: { command: "search", root: "/tmp/x", query: "needle", all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 250 } },
        { name: "grep-code", expected: { command: "search", root: "/tmp/x", query: "needle", glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 250 } },
      ] as const;

      for (const routing of singleRouting) {
        const parsed = await callJson(client, routing.name, contentArguments);
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), routing.expected);
      }

      const multiArguments = { root: "/tmp/x", queries: ["alpha", "beta(x)", "gamma"], glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 250 };
      const multiRouting = [
        { name: "multi-grep", expected: { command: "search", root: "/tmp/x", query: "alpha|beta(x)|gamma", regex: true, all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 250 } },
        { name: "multi-grep-code", expected: { command: "search", root: "/tmp/x", query: "alpha|beta(x)|gamma", regex: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 250 } },
      ] as const;

      for (const routing of multiRouting) {
        const parsed = await callJson(client, routing.name, multiArguments);
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), routing.expected);
      }

      const parsedFiles = await callJson(client, "find-files", { root: "/tmp/f", glob: "**/*.ts", exclude: "**/dist/**", max: 50, timeoutMs: 250 });
      assert.deepEqual(parsedFiles, { kind: "files", matches: [{ path: "src/one.ts" }, { path: "src/two.ts" }], warnings: [] });
      assert.deepEqual(fakeClient.calls.at(-1), { command: "files", root: "/tmp/f", all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 50, timeoutMs: 250 });
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("returns a durable operation handle when find-files is still running near the MCP deadline", async () => {
    const fakeClient: XraySearchClientLike = {
      async run(): Promise<XrayEnvelope> {
        await delay(100);
        return { ok: true, command: "files", data: { matches: [{ path: "src/slow.ts" }], summary: { fileCount: 1 } } };
      },
    };
    const server = createAtriumServer({ searchClient: fakeClient, backgroundHandoffAfterMs: 5 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const started = await callJson(client, "find-files", { root: "/tmp/slow" });
      assert.equal(started.ok, true);
      assert.equal(started.status, "running");
      assert.equal(typeof started.operationId, "string");
      assert.equal(typeof started.resultPath, "string");
      assert.deepEqual(started.nextCheck, {
        tool: "atrium.operation-status",
        arguments: { operationId: started.operationId },
        callInMs: 60_000,
      });
      assert.equal(typeof started.message, "string");

      const completed = await pollOperationStatus(client, started.operationId);
      assert.equal(completed.status, "completed");
      assert.deepEqual(completed.result, { kind: "files", matches: [{ path: "src/slow.ts" }], warnings: [] });
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });
});

async function pollOperationStatus(client: Client, operationId: unknown): Promise<Record<string, unknown>> {
  assert.equal(typeof operationId, "string");
  const deadline = Date.now() + 5_000;
  let snapshot = await callJson(client, "operation-status", { operationId });
  while (snapshot.status === "running" && Date.now() < deadline) {
    await delay(10);
    snapshot = await callJson(client, "operation-status", { operationId });
  }

  assert.notEqual(snapshot.status, "running");
  return snapshot;
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
