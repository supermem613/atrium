import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtriumServer } from "../../src/server.js";
import { composeInstructions, createSurfaces, surfaceOrder } from "../../src/mcp/surfaces.js";
import type { SearchClientLike } from "../../src/core/search/types.js";

// Deps stub for registry introspection. Tool names and instruction fragments do
// not depend on these values, and no handler is invoked by the meta-tests, so a
// never-called search client is sufficient.
const introspectionDeps = {
  executionOptions: {},
  backgroundHandoffAfterMs: 45_000,
  waitTimeoutMs: 59_000,
  searchClient: { run: async () => ({}) } as unknown as SearchClientLike,
};

// Golden characterization snapshot of the advertised instructions as of the
// behavior-preserving surface-registry refactor. This is the equivalence oracle:
// the composed default instructions must stay byte-identical to this literal so
// the refactor provably preserves what the client sees at the initialize
// handshake. It is authored independently of the code under test, not derived
// from it.
const GOLDEN_DEFAULT_INSTRUCTIONS = [
  "Atrium runs named CLIs and executables with structured JSON results. It is not a shell.",
  "",
  "Hard rules, enforced by the server:",
  "1. Shells are denied. Do not pass pwsh, powershell, bash, cmd, sh, or zsh as tool. Call the target binary directly with an args vector. Never pass a single shell command string.",
  "2. There is one execution behavior. Every run and search starts, waits briefly, then returns the result if it finished, otherwise returns a durable operationId. A handoff is not an error.",
  "",
  "Handoff contract:",
  "- When a tool returns status running with an operationId, it also returns a nextCheck object naming exactly what to call next: the operation-wait tool with that operationId.",
  "- Repeat operation-wait while it returns status continue. Never report success from a still-running handle.",
  "",
  "Value contract:",
  "- A plain string argument or stdin is used literally.",
  "- An object {file: path} is replaced with the UTF-8 contents of that file.",
  "- A tool result is itself either an inline value or an object {file, bytes}; read that file to get the full content when it is too large to inline.",
  "- Use the schema tool to discover a CLI invocation shape instead of scraping help through a shell.",
  "",
  "Read contract:",
  "- The read tool takes a path plus an optional startLine and either endLine or count. Line numbers are 1-based and positive.",
  "- A successful read returns ok, path, range, meta, and content. Treat the returned range together with meta.totalLines as authoritative for end-of-file and clamping instead of guessing bounds.",
  "",
  "Search primitives:",
  "- Content search verbs grep and grep-code use Atrium's native search implementation backed by bundled-ripgrep. find-files lists paths with Atrium's native file engine and never reads contents.",
  "- grep and grep-code take a single literal query or a queries array of one or more patterns to match any of several patterns. Set regex true to treat patterns as regular expressions. grep and find-files are unrestricted and include hidden, gitignored, and vendor files. grep-code is ignore-aware and skips hidden, gitignored, and vendor files.",
  "- Patterns match literally by default. Narrow with glob and exclude, and cap results with max. Results are structured JSON: file matches carry matches[].path, and content matches also carry matches[].line and matches[].text. Surface any normalization warnings.",
  "- These are first-class Atrium MCP tools. Use them for search instead of shelling out.",
].join("\n");

const EXPECTED_DEFAULT_TOOLS = [
  "schema",
  "run",
  "operation-wait",
  "read",
  "grep",
  "grep-code",
  "find-files",
];

async function withServer<T>(
  options: Parameters<typeof createAtriumServer>[0],
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "atrium-test", version: "0.5.0" });
  const server = createAtriumServer(options);
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe("surface registry — golden characterization", () => {
  it("advertises byte-identical default instructions", async () => {
    await withServer({}, async (client) => {
      assert.equal(client.getInstructions(), GOLDEN_DEFAULT_INSTRUCTIONS);
    });
  });

  it("registers exactly the default tool set", async () => {
    await withServer({}, async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...EXPECTED_DEFAULT_TOOLS].sort());
    });
  });
});

describe("surface registry — meta guardrail", () => {
  it("declares surfaces in the documented order", () => {
    const surfaces = createSurfaces(introspectionDeps);
    assert.deepEqual(surfaces.map((surface) => surface.name), [...surfaceOrder]);
  });

  it("every surface owns >=1 tool and all its tools appear in tools/list", async () => {
    const surfaces = createSurfaces(introspectionDeps);
    await withServer({}, async (client) => {
      const { tools } = await client.listTools();
      const listed = new Set(tools.map((tool) => tool.name));
      for (const surface of surfaces) {
        assert.ok(surface.tools.length >= 1, `surface ${surface.name} registers at least one tool`);
        for (const tool of surface.tools) {
          assert.ok(listed.has(tool.name), `tool ${tool.name} from surface ${surface.name} appears in tools/list`);
        }
      }
    });
  });

  it("composes every non-empty fragment verbatim into the default instructions", () => {
    const surfaces = createSurfaces(introspectionDeps);
    const composed = composeInstructions(surfaces);
    for (const surface of surfaces) {
      if (surface.instructionFragment.length > 0) {
        assert.ok(
          composed.includes(surface.instructionFragment),
          `fragment for surface ${surface.name} is present in composed instructions`,
        );
      }
    }
  });

  it("core and search surfaces own advertised instruction text", () => {
    const byName = new Map(createSurfaces(introspectionDeps).map((surface) => [surface.name, surface]));
    assert.ok((byName.get("core")?.instructionFragment.length ?? 0) > 0, "core fragment is non-empty");
    assert.ok((byName.get("search")?.instructionFragment.length ?? 0) > 0, "search fragment is non-empty");
  });
});

const SEARCH_TOOLS = ["grep", "grep-code", "find-files"];
const SEARCH_FRAGMENT_MARKER = "Search primitives:";
const PREAMBLE_MARKER = "Atrium runs named CLIs and executables with structured JSON results. It is not a shell.";

describe("surface registry — subset enablement", () => {
  it("omits a disabled surface from both tools/list and the composed instructions", async () => {
    await withServer({ surfaces: ["core", "read"] }, async (client) => {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((tool) => tool.name));
      for (const searchTool of SEARCH_TOOLS) {
        assert.equal(names.has(searchTool), false, `${searchTool} is omitted when search is disabled`);
      }
      assert.equal(names.has("read"), true, "read tool remains when read is enabled");
      assert.equal(names.has("schema"), true, "core tools remain");

      const instructions = client.getInstructions() as string;
      assert.equal(instructions.includes(SEARCH_FRAGMENT_MARKER), false, "search fragment is omitted");
      assert.equal(instructions.includes(PREAMBLE_MARKER), true, "preamble remains present");
    });
  });

  it("rejects a selection that omits the required core surface", () => {
    assert.throws(() => createAtriumServer({ surfaces: ["read"] }), /core/i);
  });

  it("rejects a selection naming an unknown surface", () => {
    assert.throws(() => createAtriumServer({ surfaces: ["core", "bogus"] }), /bogus|unknown/i);
  });
});

describe("surface registry — tool-contract delta", () => {
  const DELTA_SENTENCES = [
    "A tool result is itself either an inline value or an object {file, bytes}",
    "Read contract:",
    "The read tool takes a path plus an optional startLine and either endLine or count. Line numbers are 1-based and positive.",
    "Treat the returned range together with meta.totalLines as authoritative",
    "Patterns match literally by default.",
    "content matches also carry matches[].line and matches[].text",
  ];

  it("carries the migrated Atrium tool-contract facts in the composed default instructions", async () => {
    await withServer({}, async (client) => {
      const instructions = client.getInstructions() as string;
      for (const sentence of DELTA_SENTENCES) {
        assert.ok(instructions.includes(sentence), `composed instructions include: ${sentence}`);
      }
    });
  });

  it("keeps read-contract facts out of the composed instructions when read is disabled", async () => {
    await withServer({ surfaces: ["core", "search"] }, async (client) => {
      const instructions = client.getInstructions() as string;
      assert.equal(instructions.includes("Read contract:"), false, "read fragment is omitted when read is disabled");
    });
  });
});
