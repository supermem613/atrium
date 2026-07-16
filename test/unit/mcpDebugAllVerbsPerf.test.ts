import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";

type CliPayload = Record<string, unknown>;

type CliScenario = {
  name: string;
  buildCliArgs: (perf: boolean, fixture: TempFixture) => string[];
  callMcpTool: (client: Client, fixture: TempFixture) => Promise<CliPayload>;
};

interface TempFixture {
  root: string;
  filePath: string;
}

describe("mcp debug CLI verbs expose stable payloads and perf reports", () => {
  const scenarios: CliScenario[] = [
    {
      name: "schema",
      buildCliArgs: (perf) => ["mcp-schema", ...(perf ? ["--perf"] : []), process.execPath],
      callMcpTool: async (client) => callMcpToolJson(client, "schema", { tool: process.execPath }),
    },
    {
      name: "run",
      buildCliArgs: (perf) => [
        "mcp-run",
        ...(perf ? ["--perf"] : []),
        process.execPath,
        "--",
        "-e",
        "process.stdout.write('hello')",
      ],
      callMcpTool: async (client) => callMcpToolJson(client, "run", {
        tool: process.execPath,
        args: ["-e", "process.stdout.write('hello')"],
      }),
    },
    {
      name: "operation-wait",
      buildCliArgs: (perf, _fixture) => ["mcp-operation-wait", ...(perf ? ["--perf"] : []), "missing-operation"],
      callMcpTool: async (client) => callMcpToolJson(client, "operation-wait", { operationId: "missing-operation" }),
    },
    {
      name: "read",
      buildCliArgs: (perf, fixture) => [
        "mcp-read",
        ...(perf ? ["--perf"] : []),
        fixture.filePath,
        "--start-line",
        "2",
        "--end-line",
        "3",
      ],
      callMcpTool: async (client, fixture) => callMcpToolJson(client, "read", {
        path: fixture.filePath,
        startLine: 2,
        endLine: 3,
      }),
    },
    {
      name: "find-files",
      buildCliArgs: (perf, fixture) => [
        "mcp-find-files",
        ...(perf ? ["--perf"] : []),
        fixture.root,
        "--glob",
        "**/*.txt",
        "--exclude",
        "**/vendor/**",
        "--max",
        "5",
      ],
      callMcpTool: async (client, fixture) => callMcpToolJson(client, "find-files", {
        root: fixture.root,
        glob: "**/*.txt",
        exclude: "**/vendor/**",
        max: 5,
      }),
    },
    {
      name: "grep",
      buildCliArgs: (perf, fixture) => [
        "mcp-grep",
        ...(perf ? ["--perf"] : []),
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
      ],
      callMcpTool: async (client, fixture) => callMcpToolJson(client, "grep", {
        root: fixture.root,
        query: ["alpha", "beta"],
        glob: "**/*.txt",
        exclude: "**/vendor/**",
        max: 5,
      }),
    },
    {
      name: "grep-code",
      buildCliArgs: (perf, fixture) => [
        "mcp-grep-code",
        ...(perf ? ["--perf"] : []),
        fixture.root,
        "--query",
        "alpha",
        "beta",
        "--regex",
        "--glob",
        "**/*.txt",
        "--exclude",
        "**/dist/**",
        "--max",
        "5",
      ],
      callMcpTool: async (client, fixture) => callMcpToolJson(client, "grep-code", {
        root: fixture.root,
        query: ["alpha", "beta"],
        regex: true,
        glob: "**/*.txt",
        exclude: "**/dist/**",
        max: 5,
      }),
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name} keeps the default CLI debug payload shape stable`, async () => {
      await withTempFixture(async (fixture) => {
        const expectedPayload = await withInMemoryClient(async (client) => scenario.callMcpTool(client, fixture));
        const cliPayload = runCliDebug(scenario.buildCliArgs(false, fixture));
        assert.deepEqual(normalizePayload(cliPayload), normalizePayload(expectedPayload));
      });
    });

    it(`${scenario.name} emits a CLI-only perf report when --perf is provided`, async () => {
      await withTempFixture(async (fixture) => {
        const expectedPayload = await withInMemoryClient(async (client) => scenario.callMcpTool(client, fixture));
        const cliPayload = runCliDebug(scenario.buildCliArgs(true, fixture));
        assert.equal(typeof cliPayload.perf, "object");
        assert.notEqual(cliPayload.perf, null);
        const perfReport = cliPayload.perf as { operationId?: unknown; spans?: Array<{ attributes?: Record<string, unknown> }> };
        assert.equal(typeof perfReport.operationId, "string");
        if (scenario.name === "find-files" || scenario.name === "grep" || scenario.name === "grep-code") {
          assertSearchPerfTelemetry(perfReport);
        }
        const payloadWithoutPerf = { ...cliPayload };
        delete payloadWithoutPerf.perf;
        assert.deepEqual(normalizePayload(payloadWithoutPerf), normalizePayload(expectedPayload));
      });
    });
  }
});

function runCliDebug(args: string[]): CliPayload {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseJsonPayload(result.stdout);
}

function parseJsonPayload(stdout: string): CliPayload {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, "", "expected CLI output");
  return JSON.parse(trimmed) as CliPayload;
}

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

async function withTempFixture<T>(callback: (fixture: TempFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "atrium-cli-debug-"));
  try {
    const filePath = join(root, "docs", "sample.txt");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "one\ntwo\nthree\n");
    return await callback({ root, filePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withInMemoryClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-debug-test", version: "0.5.0" });
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
