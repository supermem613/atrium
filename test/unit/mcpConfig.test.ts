import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildMcpConfig, mcpConfigCommand } from "../../src/commands/mcpConfig.js";

describe("buildMcpConfig surface derivation", () => {
  it("emits today's wildcard config for the default all-surface selection", () => {
    const atrium = buildMcpConfig().mcpServers.atrium;
    assert.deepEqual(atrium.args, ["mcp-server"]);
    assert.deepEqual(atrium.tools, ["*"]);
  });

  it("derives both the surface arg and a tool allowlist for a restricted selection", () => {
    const atrium = buildMcpConfig(["core", "read"]).mcpServers.atrium;
    assert.deepEqual(atrium.args, ["mcp-server", "--surface", "core,read"]);
    assert.deepEqual(atrium.tools, ["schema", "run", "operation-wait", "read"]);
    assert.equal(atrium.tools.includes("grep"), false);
  });

  it("rejects a restricted selection that drops the required core surface", () => {
    assert.throws(() => buildMcpConfig(["read"]), /core/i);
  });
});

describe("mcpConfigCommand selection forwarding", () => {
  async function captureStdout(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await run();
    } finally {
      process.stdout.write = original;
    }
    return chunks.join("");
  }

  it("emits today's wildcard config when no selection is passed", async () => {
    const output = await captureStdout(() => mcpConfigCommand());
    const atrium = (JSON.parse(output) as ReturnType<typeof buildMcpConfig>).mcpServers.atrium;
    assert.deepEqual(atrium.args, ["mcp-server"]);
    assert.deepEqual(atrium.tools, ["*"]);
  });

  it("forwards a restricted selection into the emitted config", async () => {
    const output = await captureStdout(() => mcpConfigCommand(["core", "read"]));
    const atrium = (JSON.parse(output) as ReturnType<typeof buildMcpConfig>).mcpServers.atrium;
    assert.deepEqual(atrium.args, ["mcp-server", "--surface", "core,read"]);
    assert.deepEqual(atrium.tools, ["schema", "run", "operation-wait", "read"]);
  });
});
