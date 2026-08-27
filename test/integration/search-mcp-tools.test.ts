import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import { adoptBackgroundRun, defaultRequestSafeResponseBudgetMs, resolveRequestSafeBudgetMs } from "../../src/core/backgroundRuns.js";
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
        searchMetrics: {
          searches: 2,
          childRunMs: 3,
        },
      },
    };
  }
}

describe("search MCP tools", () => {
  // The MCP host abandons a request after this long, so a handoff budget has to
  // return well before it. The original single test proved this by sleeping out
  // the whole production budget; it is asserted directly instead.
  const hostRequestDeadlineMs = 15_000;
  const requiredHandoffMarginMs = 5_000;

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
        for (const propertyName of ["root", "query", "regex", "path", "glob", "exclude", "max"]) {
          assert.ok(properties?.[propertyName], `${toolName} should define ${propertyName}`);
        }
        assert.equal(properties?.timeoutMs, undefined);
        assert.equal(properties?.queries, undefined, `${toolName} should not expose a separate queries field`);
        assert.equal((properties?.regex as Record<string, unknown>).type, "boolean", `${toolName} regex should be a boolean`);
        const required = inputSchema.required as string[] | undefined;
        assert.deepEqual(required, ["query"], `${toolName} should require query; root is optional when path is absolute`);
      }

      const findFiles = listedTools.tools.find((candidate) => candidate.name === "find-files");
      assert.ok(findFiles, "expected find-files to be listed");
      const findFilesSchema = findFiles.inputSchema as Record<string, unknown>;
      const findFilesProperties = findFilesSchema.properties as Record<string, unknown> | undefined;
      assert.deepEqual(Object.keys(findFilesProperties ?? {}).sort(), ["exclude", "glob", "max", "root"]);
      assert.deepEqual(findFilesSchema.required, ["root"]);

      const expectedContentResult = { kind: "content", matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], warnings: [] };

      const configuredExcludes = ["**/.git/**", "**/.sd/**"];
      const excludedContent = await callJson(client, "grep-code", {
        root: "/tmp/x",
        query: "needle",
        exclude: configuredExcludes,
      });
      assert.deepEqual(excludedContent, expectedContentResult);
      assert.deepEqual(fakeClient.calls.at(-1), {
        command: "search",
        root: "/tmp/x",
        query: "needle",
        exclude: configuredExcludes,
        timeoutMs: 59_000,
      });

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
        const parsed = await callJson(client, routing.name, { root: "/tmp/x", query: ["alpha", "beta(x)", "gamma"], glob: "**/*.ts", exclude: "**/dist/**", max: 5 });
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), routing.expected);
      }

      // regex:true passes patterns through as a raw alternation without escaping.
      const regexRouting = [
        { name: "grep", args: { root: "/tmp/x", query: ["alpha", "beta(x)", "gamma"], regex: true }, expected: { command: "search", root: "/tmp/x", query: "alpha|beta(x)|gamma", regex: true, all: true, timeoutMs: 59_000 } },
        { name: "grep-code", args: { root: "/tmp/x", query: "be.n", regex: true }, expected: { command: "search", root: "/tmp/x", query: "be.n", regex: true, timeoutMs: 59_000 } },
      ] as const;
      for (const routing of regexRouting) {
        const parsed = await callJson(client, routing.name, routing.args);
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), routing.expected);
      }

      // A query is required. Omitting it is rejected at the schema boundary.
      for (const toolName of ["grep", "grep-code"] as const) {
        const missing = await client.callTool({ name: toolName, arguments: { root: "/tmp/x" } });
        assert.equal(missing.isError, true, `${toolName} should reject a call with no query`);
      }

      const parsedFiles = await callJson(client, "find-files", { root: "/tmp/f", glob: "**/*.ts", exclude: "**/dist/**", max: 50 });
      assert.deepEqual(parsedFiles, { kind: "files", matches: [{ path: "src/one.ts" }, { path: "src/two.ts" }], warnings: [] });
      assert.deepEqual(fakeClient.calls.at(-1), { command: "files", root: "/tmp/f", all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 50, timeoutMs: 59_000 });

      const excludedFiles = await callJson(client, "find-files", {
        root: "/tmp/f",
        exclude: configuredExcludes,
      });
      assert.deepEqual(excludedFiles, { kind: "files", matches: [{ path: "src/one.ts" }, { path: "src/two.ts" }], warnings: [] });
      assert.deepEqual(fakeClient.calls.at(-1), {
        command: "files",
        root: "/tmp/f",
        all: true,
        exclude: configuredExcludes,
        timeoutMs: 59_000,
      });
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
      const completedResult = completed.result as Record<string, unknown>;
      assert.equal(typeof completedResult.timingMs, "number", "backgrounded search result should include timingMs");
      delete completedResult.timingMs;
      assert.deepEqual(completedResult, { kind: "files", matches: [{ path: "src/slow.ts" }], warnings: [] });
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("returns handoff and continue responses concurrently, well inside the configured budget", async () => {
    const handoffBudgetMs = 1_000;
    const never = new Promise<XrayEnvelope>(() => {});
    const fakeClient: XraySearchClientLike = {
      run: async () => never,
    };
    const server = createAtriumServer({
      searchClient: fakeClient,
      backgroundHandoffAfterMs: handoffBudgetMs,
      waitTimeoutMs: handoffBudgetMs,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const existing = await adoptBackgroundRun({
      startedAt: new Date().toISOString(),
      result: new Promise(() => {}),
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const startedAt = Date.now();
      const [handoff, continued] = await Promise.all([
        callJson(client, "find-files", { root: "/tmp/slow" }),
        callJson(client, "operation-wait", { operationId: existing.operationId }),
      ]);
      const elapsedMs = Date.now() - startedAt;

      assert.equal(handoff.status, "running");
      assert.equal(continued.status, "continue");
      // Under one budget, not two. Serializing the pair would cost 2 x handoffBudgetMs
      // and fail this bound, which is the guarantee that keeps a real host request
      // safe when both calls are in flight at once.
      assert.ok(
        elapsedMs < handoffBudgetMs * 2 - 100,
        `handoff and operation-wait must overlap within one ${handoffBudgetMs} ms budget; elapsed ${elapsedMs} ms`,
      );
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("defaults the handoff and wait budgets to a value with margin before the host request deadline", () => {
    assert.equal(resolveRequestSafeBudgetMs(undefined), defaultRequestSafeResponseBudgetMs);
    assert.equal(resolveRequestSafeBudgetMs(250), 250);
    assert.ok(
      defaultRequestSafeResponseBudgetMs <= hostRequestDeadlineMs - requiredHandoffMarginMs,
      `the default ${defaultRequestSafeResponseBudgetMs} ms budget must leave at least ${requiredHandoffMarginMs} ms before the ${hostRequestDeadlineMs} ms host request deadline`,
    );
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

  it("accepts one or many patterns through the single query field without a separate queries field", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const expectedContentResult = { kind: "content", matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], warnings: [] };

      // A single string keeps the literal single-pattern search unchanged.
      const single = await callJson(client, "grep", { root: "/tmp/x", query: "needle", glob: "**/*.ts", exclude: "**/dist/**", max: 5 });
      assert.deepEqual(single, expectedContentResult);
      assert.deepEqual(fakeClient.calls.at(-1), { command: "search", root: "/tmp/x", query: "needle", all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 59_000 });

      // An array of patterns handed directly to query is accepted and joined into
      // one escaped alternation. This is the shape a model reaches for when it has
      // several patterns, so it must not fail schema validation with a type error.
      const many = await callJson(client, "grep", { root: "/tmp/x", query: ["alpha", "beta(x)", "gamma"], glob: "**/*.ts", exclude: "**/dist/**", max: 5 });
      assert.deepEqual(many, expectedContentResult);
      assert.deepEqual(fakeClient.calls.at(-1), { command: "search", root: "/tmp/x", query: "alpha|beta\\(x\\)|gamma", regex: true, all: true, glob: "**/*.ts", exclude: "**/dist/**", max: 5, timeoutMs: 59_000 });
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("restricts the search to a single file when path is set", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const parsed = await callJson(client, "grep", { root: "/tmp/x", query: "needle", path: "/tmp/x/only.ts" });
      assert.deepEqual(parsed, { kind: "content", matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], warnings: [] });
      // path narrows the search to the one file, so the search client runs against that file as its root.
      assert.deepEqual(fakeClient.calls.at(-1), { command: "search", root: "/tmp/x/only.ts", query: "needle", all: true, timeoutMs: 59_000 });
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("searches an absolute path without requiring root", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const expectedContentResult = { kind: "content", matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], warnings: [] };
      const cases = [
        { name: "grep", expectedCall: { command: "search", root: "/tmp/x/only.ts", query: "needle", all: true, timeoutMs: 59_000 } },
        { name: "grep-code", expectedCall: { command: "search", root: "/tmp/x/only.ts", query: "needle", timeoutMs: 59_000 } },
      ] as const;
      for (const tool of cases) {
        const response = await client.callTool({
          name: tool.name,
          arguments: { query: "needle", path: "/tmp/x/only.ts" },
        });
        assert.ok(Array.isArray(response.content));
        const firstContent = response.content[0];
        assert.equal(typeof firstContent, "object");
        assert.notEqual(firstContent, null);
        assert.equal("text" in firstContent, true);
        assert.equal(typeof firstContent.text, "string");
        assert.equal(
          firstContent.text.startsWith("{"),
          true,
          `${tool.name} should return a JSON search result when path is absolute and root is omitted; got: ${firstContent.text}`,
        );
        const parsed = JSON.parse(firstContent.text) as Record<string, unknown>;
        delete parsed.timingMs;
        assert.deepEqual(parsed, expectedContentResult);
        assert.deepEqual(fakeClient.calls.at(-1), tool.expectedCall);
      }
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("anchors a relative path filter under the search root instead of passing it as the bare root", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const parsed = await callJson(client, "grep", { root: "/tmp/x", query: "needle", path: "only.ts" });
      assert.deepEqual(parsed, { kind: "content", matches: [{ path: "src/one.ts", line: 7, text: "matched text" }], warnings: [] });
      // A relative path names a file inside root. It must be anchored to root. Passing the
      // bare relative name as the search root makes the engine resolve it against the process
      // working directory and reject it as `invalid root: only.ts`.
      const receivedRoot = fakeClient.calls.at(-1)?.root;
      assert.notEqual(receivedRoot, "only.ts", "a relative path filter must not be passed as the bare search root");
      assert.equal(receivedRoot, join("/tmp/x", "only.ts"));
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("names the offending element when a multi-pattern regex query cannot compile", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const parsed = await callJson(client, "grep", {
        root: "/tmp/x",
        query: ["function partitionGlobalArgs", "partitionGlobalArgs("],
        regex: true,
      });

      assert.equal(parsed.ok, false);
      const error = parsed.error as Record<string, unknown>;
      assert.equal(error.code, "InvalidPatternElement");
      assert.equal(error.index, 1);
      assert.equal(error.pattern, "partitionGlobalArgs(");
      assert.match(String(error.message), /unclosed group/i);
      assert.equal(fakeClient.calls.length, 0, "a rejected query must never reach the search engine");

      // Rust-dialect syntax that JavaScript's RegExp rejects must still route
      // through untouched, proving the guard is structural rather than a
      // JavaScript regex parser standing in for the native engine.
      await callJson(client, "grep", { root: "/tmp/x", query: ["(?i)alpha", "beta[0-9]"], regex: true });
      assert.deepEqual(fakeClient.calls.at(-1), {
        command: "search",
        root: "/tmp/x",
        query: "(?i)alpha|beta[0-9]",
        regex: true,
        all: true,
        timeoutMs: 59_000,
      });

      // Extended mode makes # start a comment, so parentheses inside it are not
      // group delimiters. The guard cannot read extended mode, so it must defer
      // to the engine rather than rejecting a pattern Rust would compile.
      await callJson(client, "grep", { root: "/tmp/x", query: ["(?x)a #(open", "beta"], regex: true });
      assert.deepEqual(fakeClient.calls.at(-1), {
        command: "search",
        root: "/tmp/x",
        query: "(?x)a #(open|beta",
        regex: true,
        all: true,
        timeoutMs: 59_000,
      });

      // Rust allows one character class to nest inside another, which makes the
      // parenthesis here a class member rather than a group. The guard cannot
      // model nested classes, so it must defer to the engine.
      await callJson(client, "grep", { root: "/tmp/x", query: ["[a[b](]", "beta"], regex: true });
      assert.deepEqual(fakeClient.calls.at(-1), {
        command: "search",
        root: "/tmp/x",
        query: "[a[b](]|beta",
        regex: true,
        all: true,
        timeoutMs: 59_000,
      });
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("names the offending pattern when a single regex query cannot compile", async () => {
    const fakeClient = new FakeXrayClient();
    const server = createAtriumServer({ searchClient: fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const parsed = await callJson(client, "grep", { root: "/tmp/x", query: "partitionGlobalArgs(", regex: true });

      assert.equal(parsed.ok, false);
      const error = parsed.error as Record<string, unknown>;
      assert.equal(error.code, "InvalidPatternElement");
      assert.equal(error.index, 0);
      assert.equal(error.pattern, "partitionGlobalArgs(");
      assert.match(String(error.message), /unclosed group/i);
      assert.equal(fakeClient.calls.length, 0, "a rejected single pattern must never reach the search engine");

      await callJson(client, "grep", { root: "/tmp/x", query: "(?i)alpha", regex: true });
      assert.deepEqual(fakeClient.calls.at(-1), { command: "search", root: "/tmp/x", query: "(?i)alpha", regex: true, all: true, timeoutMs: 59_000 });
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
  const parsed = JSON.parse(firstContent.text) as Record<string, unknown>;
  if (parsed.kind === "content" || parsed.kind === "files") {
    assert.equal(typeof parsed.timingMs, "number", "search result should include timingMs");
    delete parsed.timingMs;
  }
  return parsed;
}
