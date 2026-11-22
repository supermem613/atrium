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
  cacheVerified: boolean;
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

function parseInstalledPlugins(stdout: string): Array<{ name?: unknown; enabled?: unknown }> {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as Array<{ name?: unknown; enabled?: unknown }>;
  }
  if (typeof parsed === "object" && parsed !== null && "plugins" in parsed && Array.isArray(parsed.plugins)) {
    return parsed.plugins as Array<{ name?: unknown; enabled?: unknown }>;
  }
  throw new Error("Copilot plugin list --json returned an unexpected shape");
}

async function verifyPluginCache(execCommand: PluginInstallDeps["execCommand"], repoRoot: string): Promise<boolean> {
  if (execCommand === undefined) {
    throw new Error("execCommand is required");
  }
  const result = await execCommand("copilot", ["plugin", "list", "--json"], repoRoot);
  let entries: Array<{ name?: unknown; enabled?: unknown }>;
  try {
    entries = parseInstalledPlugins(result.stdout);
  } catch (error) {
    throw new Error(`Atrium plugin cache verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const atrium = entries.find((entry) => entry.name === "atrium");
  if (atrium?.enabled !== true) {
    throw new Error("Atrium plugin cache verification failed: plugin atrium is missing or disabled");
  }
  return true;
}

export async function installAndVerifyPlugin(
  execCommand: (command: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>,
  repoRoot: string,
): Promise<boolean> {
  const pluginRoot = pluginRootFromRepo(repoRoot);
  await execCommand("copilot", ["plugin", "install", pluginRoot], repoRoot);
  return verifyPluginCache(execCommand, repoRoot);
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

  const cacheVerified = await installAndVerifyPlugin(execCommand, repoRoot);
  return { repoRoot, pluginRoot, installed: true, cacheVerified };
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
