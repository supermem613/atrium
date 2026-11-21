import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginRootFromRepo, runPluginInstall } from "../../src/commands/plugin.js";

describe("plugin install", () => {
  it("writes an MCP config that points to this checkout and invokes one plugin install", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "atrium-plugin-"));
    await mkdir(join(repoRoot, ".github", "plugin"), { recursive: true });
    await writeFile(join(repoRoot, ".github", "plugin", "plugin.json"), JSON.stringify({ name: "atrium" }), "utf8");

    const calls: string[] = [];
    const result = await runPluginInstall({
      repoRoot,
      execCommand: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return { stdout: "installed\n", stderr: "" };
      },
    });

    assert.equal(result.pluginRoot, pluginRootFromRepo(repoRoot));
    assert.equal(result.installed, true);
    assert.equal(
      calls.some((call) => call === `copilot plugin install ${join(repoRoot, ".github", "plugin")}`),
      true,
    );
  });

  it("fails clearly when the plugin manifest is absent", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "atrium-plugin-"));
    await assert.rejects(
      () => runPluginInstall({
        repoRoot,
        execCommand: async () => ({ stdout: "", stderr: "" }),
      }),
      /plugin manifest not found/i,
    );
  });
});
