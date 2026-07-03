import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer, type FffSupervisorLike } from "../../src/server.js";

class FakeFffSupervisor implements FffSupervisorLike {
  public calls: Array<{ rootPath: string; toolName: string; input: Record<string, unknown> | undefined }> = [];

  async callTool(rootPath: string, toolName: string, input?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ rootPath, toolName, input });
    return {
      content: [
        {
          type: "text",
          text: toolName === "find-files"
            ? "src/one.ts\nsrc/two.ts\n"
            : "src/one.ts:7:matched text\n",
        },
      ],
    };
  }
}

describe("fff MCP tools", () => {
  it("exposes search primitives with stable schemas and routes calls through the injected supervisor", async () => {
    const fakeSupervisor = new FakeFffSupervisor();
    const server = createAtriumServer({ fffSupervisor: fakeSupervisor });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listedTools = await client.listTools();
      const visibleToolNames = listedTools.tools.map((tool) => tool.name);
      assert.deepEqual(
        visibleToolNames.filter((name) => ["find-files", "grep", "multi-grep", "grep-code", "multi-grep-code"].includes(name)),
        ["find-files", "grep", "multi-grep", "grep-code", "multi-grep-code"],
      );
      assert.equal(visibleToolNames.includes("find-code"), false);

      const expectedSchemaProperties = ["root", "query", "glob", "exclude", "max", "timeoutMs"];
      for (const toolName of ["find-files", "grep", "multi-grep", "grep-code", "multi-grep-code"] as const) {
        const tool = listedTools.tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool, `expected ${toolName} to be listed`);

        const inputSchema = tool.inputSchema as Record<string, unknown>;
        assert.ok(inputSchema, `${toolName} should expose an input schema`);
        const properties = inputSchema.properties as Record<string, unknown> | undefined;
        assert.ok(properties, `${toolName} should expose JSON-schema properties`);
        for (const propertyName of expectedSchemaProperties) {
          assert.ok(properties?.[propertyName], `${toolName} should define ${propertyName}`);
        }

        const required = inputSchema.required as string[] | undefined;
        assert.ok(required, `${toolName} should list required fields`);
        assert.ok(required.includes("root"), `${toolName} should require root`);
        assert.ok(required.includes("query"), `${toolName} should require query`);
      }

      const expectedCalls = [
        {
          visibleToolName: "find-files",
          underlyingToolName: "find-files",
          expectedResult: {
            kind: "files",
            matches: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
            warnings: [],
          },
          arguments: {
            root: "/tmp/one",
            query: "needle",
            glob: "**/*.ts",
            exclude: "**/dist/**",
            max: 5,
            timeoutMs: 250,
          },
        },
        {
          visibleToolName: "grep",
          underlyingToolName: "grep",
          expectedResult: {
            kind: "content",
            matches: [{ path: "src/one.ts", line: 7, text: "matched text" }],
            warnings: [],
          },
          arguments: {
            root: "/tmp/two",
            query: "pattern",
            glob: "**/*.{js,ts}",
            exclude: "**/node_modules/**",
            max: 3,
            timeoutMs: 600,
          },
        },
        {
          visibleToolName: "multi-grep",
          underlyingToolName: "multi-grep",
          expectedResult: {
            kind: "content",
            matches: [{ path: "src/one.ts", line: 7, text: "matched text" }],
            warnings: [],
          },
          arguments: {
            root: "/tmp/three",
            query: "value",
            glob: "**/*.md",
            exclude: "**/.git/**",
            max: 9,
            timeoutMs: 1500,
          },
        },
        {
          visibleToolName: "grep-code",
          underlyingToolName: "grep",
          expectedResult: {
            kind: "content",
            matches: [{ path: "src/one.ts", line: 7, text: "matched text" }],
            warnings: [],
          },
          arguments: {
            root: "/tmp/four",
            query: "impl",
            glob: "**/*.ts",
            exclude: "**/dist/**",
            max: 4,
            timeoutMs: 900,
          },
        },
        {
          visibleToolName: "multi-grep-code",
          underlyingToolName: "multi-grep",
          expectedResult: {
            kind: "content",
            matches: [{ path: "src/one.ts", line: 7, text: "matched text" }],
            warnings: [],
          },
          arguments: {
            root: "/tmp/five",
            query: "api",
            glob: "**/*.{ts,js}",
            exclude: "**/node_modules/**",
            max: 7,
            timeoutMs: 1200,
          },
        },
      ] as const;

      for (const expectedCall of expectedCalls) {
        const result = await client.callTool({
          name: expectedCall.visibleToolName,
          arguments: expectedCall.arguments,
        });
        assert.ok(Array.isArray(result.content), `${expectedCall.visibleToolName} should return content array`);
        assert.ok(result.content[0], `${expectedCall.visibleToolName} should return content`);
        const firstContent = result.content[0];
        assert.equal(typeof firstContent, "object");
        assert.notEqual(firstContent, null);
        assert.equal("text" in firstContent, true);
        assert.equal(typeof firstContent.text, "string");
        const parsed = JSON.parse(firstContent.text);
        assert.deepEqual(parsed, expectedCall.expectedResult);

        assert.deepEqual(fakeSupervisor.calls.at(-1), {
          rootPath: expectedCall.arguments.root,
          toolName: expectedCall.underlyingToolName,
          input: {
            query: expectedCall.arguments.query,
            glob: expectedCall.arguments.glob,
            exclude: expectedCall.arguments.exclude,
            max: expectedCall.arguments.max,
            timeoutMs: expectedCall.arguments.timeoutMs,
          },
        });
      }
    } finally {
      await client.close();
      await serverTransport.close();
    }
  });

  it("returns a durable operation handle when a search primitive is still running near the MCP deadline", async () => {
    const fakeSupervisor: FffSupervisorLike = {
      async callTool(): Promise<unknown> {
        await delay(100);
        return {
          content: [
            {
              type: "text",
              text: "src/slow.ts\n",
            },
          ],
        };
      },
    };
    const server = createAtriumServer({
      fffSupervisor: fakeSupervisor,
      autoBackgroundAfterMs: 5,
      waitTimeoutMs: 1_000,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const started = await callJson(client, "find-files", {
        root: "/tmp/slow",
        query: "slow",
      });

      assert.equal(started.ok, true);
      assert.equal(started.status, "running");
      assert.equal(started.operationId, started.runId);
      assert.equal(typeof started.resultPath, "string");
      assert.deepEqual(started.wait, {
        tool: "atrium.wait",
        arguments: { operationId: started.operationId, follow: false },
        maxWaitMs: 45_000,
      });

      const completed = await callJson(client, "wait", {
        operationId: started.operationId,
        maxWaitMs: 1_000,
      });
      assert.equal(completed.status, "completed");
      assert.deepEqual(completed.result, {
        kind: "files",
        matches: [{ path: "src/slow.ts" }],
        warnings: [],
      });
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
