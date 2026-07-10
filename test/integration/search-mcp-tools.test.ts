import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import type { NativeSearchEnvelope, NativeSearchRunOptions, XrayEnvelope, XrayRunOptions, XraySearchClientLike } from "../../src/core/search/types.js";

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

class FakeNativeSearchClient {
  public calls: NativeSearchRunOptions[] = [];

  async run(options: NativeSearchRunOptions): Promise<NativeSearchEnvelope> {
    this.calls.push(options);
    return {
      ok: true,
      command: options.command,
      kind: options.command === "files" ? "files" : "content",
      data: {
        matches: options.command === "files"
          ? [{ path: "src/native.ts" }]
          : [{ path: "src/native.ts", line: 11, text: "native hit" }],
        summary: { fileCount: 1, matchCount: 1 },
      },
      warnings: ["native warning"],
      metrics: {
        ripgrepMetrics: {
          searches: 2,
          bytesSearched: 4096,
          matches: 1,
        },
      },
    };
  }
}

describe("search MCP tools", () => {
  it("exposes the three search verbs with stable schemas and routes calls through the injected search client", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listedTools = await client.listTools();
      const visibleToolNames = listedTools.tools.map((tool) => tool.name).sort();
      assert.deepEqual(visibleToolNames, ["find-files", "grep", "grep-code", "operation-wait", "read", "run", "schema"]);

      for (const toolName of ["grep", "grep-code"] as const) {
        const tool = listedTools.tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool, `expected ${toolName} to be listed`);
        const inputSchema = tool.inputSchema as Record<string, unknown>;
        const properties = inputSchema.properties as Record<string, unknown> | undefined;
        assert.ok(properties, `${toolName} should expose properties`);
        for (const propertyName of ["root", "query", "queries", "regex", "glob", "exclude", "max"]) {
          assert.ok(properties?.[propertyName], `${toolName} should define ${propertyName}`);
        }
        assert.equal(properties?.timeoutMs, undefined);
        assert.equal((properties?.queries as Record<string, unknown>).type, "array", `${toolName} queries should be an array`);
        assert.equal((properties?.regex as Record<string, unknown>).type, "boolean", `${toolName} regex should be a boolean`);
        const required = inputSchema.required as string[] | undefined;
        assert.deepEqual(required, ["root"], `${toolName} should require only root`);
      }

      const findFiles = listedTools.tools.find((candidate) => candidate.name === "find-files");
      assert.ok(findFiles, "expected find-files to be listed");
      const findFilesSchema = findFiles.inputSchema as Record<string, unknown>;
      const findFilesProperties = findFilesSchema.properties as Record<string, unknown> | undefined;
      assert.deepEqual(Object.keys(findFilesProperties ?? {}).sort(), ["exclude", "glob", "max", "root"]);
      assert.deepEqual(findFilesSchema.required, ["root"]);

      const expectedContentResult = { kind: "content", matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], warnings: [] };

      // A single query stays a literal native search, so grep and grep-code behavior is unchanged.
      const singleLiteralRouting = [
        { name: "grep", args: { root: "/tmp/x", query: "needle", glob: "**/*.ts", exclude: "**/dist/**", max: 5 }, expected: { command: "search", root: "/tmp/x", query: "needle", all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 59_000 } },
        { name: "grep-code", args: { root: "/tmp/x", query: "needle", glob: "**/*.ts", exclude: "**/dist/**", max: 5 }, expected: { command: "search", root: "/tmp/x", query: "needle", glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 59_000 } },
      ] as const;
      for (const routing of singleLiteralRouting) {
        const parsed = await callJson(client, routing.name, routing.args);
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), routing.expected);
      }

      // Multiple literal queries are regex-escaped and joined into one alternation.
      const multiLiteralRouting = [
        { name: "grep", expected: { command: "search", root: "/tmp/x", query: "alpha|beta\\(x\\)|gamma", regex: true, all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 59_000 } },
        { name: "grep-code", expected: { command: "search", root: "/tmp/x", query: "alpha|beta\\(x\\)|gamma", regex: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 59_000 } },
      ] as const;
      for (const routing of multiLiteralRouting) {
        const parsed = await callJson(client, routing.name, { root: "/tmp/x", queries: ["alpha", "beta(x)", "gamma"], glob: "**/*.ts", exclude: "**/dist/**", max: 5 });
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), routing.expected);
      }

      // regex:true passes patterns through as a raw alternation without escaping.
      const regexRouting = [
        { name: "grep", args: { root: "/tmp/x", queries: ["alpha", "beta(x)", "gamma"], regex: true }, expected: { command: "search", root: "/tmp/x", query: "alpha|beta(x)|gamma", regex: true, all: true, timeoutMs: 59_000 } },
        { name: "grep-code", args: { root: "/tmp/x", query: "be.n", regex: true }, expected: { command: "search", root: "/tmp/x", query: "be.n", regex: true, timeoutMs: 59_000 } },
      ] as const;
      for (const routing of regexRouting) {
        const parsed = await callJson(client, routing.name, routing.args);
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), routing.expected);
      }

      // Ambiguous or empty pattern input is rejected with a clear, actionable message.
      for (const toolName of ["grep", "grep-code"] as const) {
        const both = await client.callTool({ name: toolName, arguments: { root: "/tmp/x", query: "a", queries: ["b"] } });
        assert.equal(both.isError, true, `${toolName} should reject query and queries together`);
        assert.match((both.content as Array<{ text: string }>)[0].text, /exactly one of query or queries/);
        const neither = await client.callTool({ name: toolName, arguments: { root: "/tmp/x" } });
        assert.equal(neither.isError, true, `${toolName} should reject missing query and queries`);
        assert.match((neither.content as Array<{ text: string }>)[0].text, /exactly one of query or queries/);
      }

      const parsedFiles = await callJson(client, "find-files", { root: "/tmp/f", glob: "**/*.ts", exclude: "**/dist/**", max: 50 });
      assert.deepEqual(parsedFiles, { kind: "files", matches: [{ path: "src/one.ts" }, { path: "src/two.ts" }], warnings: [] });
      assert.deepEqual(fakeClient.calls.at(-1), { command: "files", root: "/tmp/f", all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 50, timeoutMs: 59_000 });
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
        tool: "atrium.operation-wait",
        arguments: { operationId: started.operationId },
        callInMs: 0,
      });
      assert.equal(typeof started.message, "string");

      const completed = await waitForOperation(client, started.operationId);
      assert.equal(completed.status, "completed");
      assert.deepEqual(completed.result, { kind: "files", matches: [{ path: "src/slow.ts" }], warnings: [] });
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("does not expose injected native metrics in normal MCP responses", async () => {
    const fakeClient = new FakeNativeSearchClient();
    const server = createAtriumServer({ searchClient: fakeClient as unknown as XraySearchClientLike });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const parsed = await callJson(client, "grep", { root: "/tmp/x", query: "needle" });
      assert.deepEqual(parsed, { kind: "content", matches: [{ path: "src/native.ts", line: 11, text: "native hit" }], warnings: ["native warning"] });
      assert.equal(fakeClient.calls.at(-1)?.perf, undefined);
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });
});

async function waitForOperation(client: Client, operationId: unknown): Promise<Record<string, unknown>> {
  assert.equal(typeof operationId, "string");
  const deadline = Date.now() + 5_000;
  let snapshot = await callJson(client, "operation-wait", { operationId });
  while (snapshot.status === "continue" && Date.now() < deadline) {
    await delay(10);
    snapshot = await callJson(client, "operation-wait", { operationId });
  }

  assert.notEqual(snapshot.status, "continue");
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
