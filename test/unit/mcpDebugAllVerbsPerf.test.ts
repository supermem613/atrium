import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import { MAX_CLI_LAUNCHES, getCliLaunchCount, runCliDebug } from "../helpers/cliLaunchBudget.js";

type CliPayload = Record<string, unknown>;

type CliScenario = {
  name: string;
  toolName: string;
  buildToolArgs: (fixture: TempFixture) => Record<string, unknown>;
  assertContract: (payload: CliPayload, fixture: TempFixture) => void;
};

interface TempFixture {
  root: string;
  filePath: string;
}

describe("mcp debug CLI verbs expose stable payloads and perf reports", { concurrency: false }, () => {
  let fixture: TempFixture;
  let client: Client;

  before(async () => {
    fixture = await createTempFixture();
    client = await createInMemoryClient();
  });

  after(async () => {
    await client.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const scenarios: CliScenario[] = [
    {
      name: "schema",
      toolName: "schema",
      buildToolArgs: () => ({ tool: process.execPath }),
      assertContract: (payload) => {
        assert.equal(payload.ok, true);
        assert.equal(payload.tool, process.execPath);
        assert.equal(payload.source, "help");
        assert.equal(typeof payload.text, "string");
        const text = payload.text as string;
        assert.ok(text.includes("Usage: node"));
      },
    },
    {
      name: "run",
      toolName: "run",
      buildToolArgs: () => ({
        tool: process.execPath,
        args: ["-e", "process.stdout.write('hello')"],
      }),
      assertContract: (payload) => {
        assert.equal(payload.ok, true);
        assert.equal(payload.tool, process.execPath);
        assert.equal(payload.stdout, "hello");
        assert.equal(typeof payload.timingMs, "number");
        const metrics = payload.metrics as Record<string, unknown> | undefined;
        assert.ok(metrics);
        assert.equal(metrics?.childTool, "node");
      },
    },
    {
      name: "operation-wait",
      toolName: "operation-wait",
      buildToolArgs: () => ({ operationId: "missing-operation" }),
      assertContract: (payload) => {
        assert.equal(payload.ok, false);
        assert.equal(payload.status, "failed");
        assert.equal(payload.operationId, "missing-operation");
        const errorPayload = payload.error as Record<string, unknown> | undefined;
        assert.ok(errorPayload);
        assert.equal(errorPayload?.code, "UnknownRun");
        assert.equal(typeof errorPayload?.message, "string");
      },
    },
    {
      name: "read",
      toolName: "read",
      buildToolArgs: (fixture) => ({
        path: fixture.filePath,
        startLine: 2,
        endLine: 3,
      }),
      assertContract: (payload, fixture) => {
        assert.equal(payload.ok, true);
        assert.equal(payload.path, fixture.filePath);
        assert.deepEqual(payload.range, [2, 3]);
        const meta = payload.meta as Record<string, unknown> | undefined;
        assert.ok(meta);
        assert.equal(meta?.totalLines, 3);
        assert.equal(payload.content, "alpha\nbeta\n");
        assert.equal(payload.nextRead, null);
      },
    },
    {
      name: "find-files",
      toolName: "find-files",
      buildToolArgs: (fixture) => ({
        root: fixture.root,
        glob: "**/*.txt",
        exclude: "**/vendor/**",
        max: 5,
      }),
      assertContract: (payload) => {
        assert.equal(payload.kind, "files");
        const matches = payload.matches as Array<Record<string, unknown>> | undefined;
        assert.ok(matches);
        assert.equal(matches?.length, 1);
        assert.equal(matches?.[0]?.path, "docs/sample.txt");
        assert.deepEqual(payload.warnings, []);
      },
    },
    {
      name: "grep",
      toolName: "grep",
      buildToolArgs: (fixture) => ({
        root: fixture.root,
        query: ["alpha", "beta"],
        glob: "**/*.txt",
        exclude: "**/vendor/**",
        max: 5,
      }),
      assertContract: (payload) => {
        assert.equal(payload.kind, "content");
        const matches = payload.matches as Array<Record<string, unknown>> | undefined;
        assert.ok(matches);
        assert.equal(matches?.length, 2);
        assert.deepEqual(payload.warnings, []);
        assert.equal(matches?.[0]?.path, "docs/sample.txt");
        assert.equal(matches?.[0]?.line, 2);
        assert.equal(matches?.[0]?.text, "alpha\n");
        assert.equal(matches?.[1]?.path, "docs/sample.txt");
        assert.equal(matches?.[1]?.line, 3);
        assert.equal(matches?.[1]?.text, "beta\n");
      },
    },
    {
      name: "grep-code",
      toolName: "grep-code",
      buildToolArgs: (fixture) => ({
        root: fixture.root,
        query: ["alpha", "beta"],
        regex: true,
        glob: "**/*.txt",
        exclude: "**/dist/**",
        max: 5,
      }),
      assertContract: (payload) => {
        assert.equal(payload.kind, "content");
        const matches = payload.matches as Array<Record<string, unknown>> | undefined;
        assert.ok(matches);
        assert.equal(matches?.length, 2);
        assert.deepEqual(payload.warnings, []);
        assert.equal(matches?.[0]?.path, "docs/sample.txt");
        assert.equal(matches?.[0]?.line, 2);
        assert.equal(matches?.[0]?.text, "alpha\n");
        assert.equal(matches?.[1]?.path, "docs/sample.txt");
        assert.equal(matches?.[1]?.line, 3);
        assert.equal(matches?.[1]?.text, "beta\n");
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name} keeps its in-process payload contract`, async () => {
      const payload = await callMcpToolJson(client, scenario.toolName, scenario.buildToolArgs(fixture));
      scenario.assertContract(payload, fixture);
    });
  }

  it("mcp debug CLI verbs keep the default CLI payload parity for read", async () => {
    const expectedPayload = await callMcpToolJson(client, "read", {
      path: fixture.filePath,
      startLine: 2,
      endLine: 3,
    });
    const cliPayload = runCliDebug([
      "mcp-read",
      fixture.filePath,
      "--start-line",
      "2",
      "--end-line",
      "3",
    ]);

    assert.deepEqual(normalizePayload(cliPayload), normalizePayload(expectedPayload));
  });

  it("mcp debug CLI verbs keep the grep perf report shape", async () => {
    const expectedPayload = await callMcpToolJson(client, "grep", {
      root: fixture.root,
      query: ["alpha", "beta"],
      glob: "**/*.txt",
      exclude: "**/vendor/**",
      max: 5,
    });
    const cliPayload = runCliDebug([
      "mcp-grep",
      "--perf",
      fixture.root,
      "--query",
      "alpha",
      "beta",
      "--glob",
      "**/*.txt",
      "--exclude",
      "**/vendor/**",
      "--max",
      "5",
    ]);

    assert.equal(typeof cliPayload.perf, "object");
    assert.notEqual(cliPayload.perf, null);
    const perfReport = cliPayload.perf as { operationId?: unknown; spans?: Array<{ attributes?: Record<string, unknown> }> };
    assert.equal(typeof perfReport.operationId, "string");
    assertSearchPerfTelemetry(perfReport);

    const payloadWithoutPerf = { ...cliPayload } as CliPayload;
    delete payloadWithoutPerf.perf;
    assert.deepEqual(normalizePayload(payloadWithoutPerf), normalizePayload(expectedPayload));
  });

  it("mcp debug CLI verbs launch dist/cli.js at most twice", () => {
    const observedLaunchCount = getCliLaunchCount();
    assert.ok(
      observedLaunchCount >= 1 && observedLaunchCount <= MAX_CLI_LAUNCHES,
      `observed dist/cli.js launch count ${observedLaunchCount} against the ceiling of ${MAX_CLI_LAUNCHES}`,
    );
  });
});

function assertSearchPerfTelemetry(perfReport: { spans?: Array<{ attributes?: Record<string, unknown> }> }): void {
  const spans = perfReport.spans ?? [];
  assert.ok(spans.some((span) => span.attributes?.searchMetrics !== undefined), "expected native search metrics in perf spans");
  assert.ok(spans.every((span) => span.attributes?.xrayMetrics === undefined), "expected no xray metrics in native perf spans");
}

function normalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => normalizePayload(child));
  }

  if (typeof value === "object" && value !== null) {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "file" && typeof child === "string") {
        normalized[key] = "<temp-file>";
      } else if (key === "cache" && typeof child === "object" && child !== null) {
        normalized[key] = { hit: true, reason: "same-file" };
      } else if (typeof key === "string" && /ms$/i.test(key)) {
        normalized[key] = 0;
      } else {
        normalized[key] = normalizePayload(child);
      }
    }
    return normalized;
  }

  return value;
}

async function createTempFixture(): Promise<TempFixture> {
  const root = await mkdtemp(join(tmpdir(), "atrium-cli-debug-"));
  const filePath = join(root, "docs", "sample.txt");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, "one\nalpha\nbeta\n");
  return { root, filePath };
}

async function createInMemoryClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-debug-test", version: "0.5.0" });
  const server = createAtriumServer();

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return client;
}

async function callMcpToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<CliPayload> {
  const response = await client.callTool({ name, arguments: args });
  if (!("content" in response) || !Array.isArray(response.content)) {
    throw new Error(`expected ${name} MCP response text content`);
  }

  const firstContent = response.content[0];
  assert.equal(firstContent.type, "text");
  assert.equal(typeof firstContent.text, "string");
  return JSON.parse(firstContent.text) as CliPayload;
}
