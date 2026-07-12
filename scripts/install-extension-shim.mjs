import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Installs the Atrium instructions extension by writing a redirect shim into the
// personal Copilot extensions directory. The shim imports the extension entry
// from this repo instead of copying it, so edits go live on the next session
// with no reinstall. The extension delivers Atrium's surface-tailored guardrails
// as always-on model context, which the MCP `instructions` field cannot do.

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceExtension = path.join(repoRoot, "extension", "atrium.mjs");
const defaultTarget = path.join(os.homedir(), ".copilot", "extensions", "atrium");

const args = parseArgs(process.argv.slice(2));
const target = path.resolve(args.target ?? defaultTarget);

await assertSourceExists();
await assertSafeTarget(target);
await mkdir(target, { recursive: true });

const shimPath = path.join(target, "extension.mjs");
const importUrl = pathToFileURL(sourceExtension).href;
await writeFile(shimPath, `await import(${JSON.stringify(importUrl)});\n`, "utf8");

process.stdout.write(JSON.stringify({
  ok: true,
  command: "install-extension-shim",
  data: {
    target,
    shimPath,
    sourceExtension,
  },
}) + "\n");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      parsed.target = argv[index + 1];
      index += 1;
    } else if (arg === "--help") {
      process.stdout.write("Usage: node scripts/install-extension-shim.mjs [--target <extension-dir>]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function assertSourceExists() {
  await readFile(sourceExtension, "utf8");
}

async function assertSafeTarget(targetPath) {
  const stat = await lstatOrNull(targetPath);
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink: ${targetPath}`);
  }
}

async function lstatOrNull(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
