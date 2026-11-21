import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PluginInstallResult = {
  repoRoot: string;
  pluginRoot: string;
  installed: boolean;
};

type PluginInstallDeps = {
  repoRoot?: string;
  execCommand?: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
  json?: boolean;
};

function repoRootFromModule(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

async function defaultExecCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const invocation = process.platform === "win32" && (command === "copilot")
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }
    : { command, args };
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export function pluginRootFromRepo(repoRoot: string): string {
  return join(repoRoot, ".github", "plugin");
}

export async function runPluginInstall(deps: PluginInstallDeps = {}): Promise<PluginInstallResult> {
  const repoRoot = deps.repoRoot ?? repoRootFromModule();
  const execCommand = deps.execCommand ?? defaultExecCommand;
  const pluginRoot = pluginRootFromRepo(repoRoot);
  const manifestPath = join(pluginRoot, "plugin.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`Atrium plugin manifest not found: ${manifestPath}`);
  }

  mkdirSync(pluginRoot, { recursive: true });
  const mcpPath = join(pluginRoot, "mcp.json");
  const mcp = {
    mcpServers: {
      atrium: {
        type: "stdio",
        command: process.execPath,
        args: [join(repoRoot, "dist", "cli.js"), "mcp-server"],
        cwd: repoRoot,
        tools: ["*"],
      },
    },
  };
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");

  await execCommand("copilot", ["plugin", "install", pluginRoot], repoRoot);
  return { repoRoot, pluginRoot, installed: true };
}

export async function installPluginCommand(opts: { json?: boolean } = {}): Promise<void> {
  try {
    const result = await runPluginInstall();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, command: "install-plugin", data: result }) + "\n");
    } else {
      process.stdout.write(`Installed Atrium Copilot plugin: ${result.pluginRoot}\n`);
    }
  } catch (err: unknown) {
    const hint = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, command: "install-plugin", error: "PLUGIN_INSTALL_FAILED", hint }) + "\n");
    } else {
      process.stderr.write(`Atrium plugin install failed: ${hint}\n`);
    }
    process.exitCode = 1;
  }
}
