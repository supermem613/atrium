// Test-only parity oracle. Runs bundled ripgrep and the native addon over the
// same fixture root with the same structured options, then normalizes and sorts
// both result sets so a parity test can compare them order-insensitively.
//
// The ripgrep side mirrors the core `buildRipgrepArgs` semantics in
// contentSearch.ts / fileSearch.ts WITHOUT the smartPlan type lanes. Lane
// translation parity is covered separately by the Phase 5 full-path test.
import { spawn } from "node:child_process";
import { resolveBundledRgPath } from "../src/core/search/rgPath.js";
import { normalizeNativeSearchPath } from "../src/core/search/normalize.js";
import { loadNativeSearchAddon } from "../src/core/search/nativeAddon.js";
import { basename } from "node:path";

function spawnRg(args, cwd) {
  const rgPath = resolveBundledRgPath();
  if (rgPath === null) {
    throw new Error("bundled ripgrep not available");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        reject(new Error(`rg exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function buildContentArgs({ query, regex, all, globs, excludes }) {
  const args = ["--line-number", "--color=never", "--json", "--max-filesize", "2M"];
  if (!regex) {
    args.push("-F");
  }
  if (all) {
    args.push("--hidden", "--no-ignore");
  }
  args.push("-e", query);
  for (const glob of globs ?? []) {
    args.push("--glob", glob);
  }
  for (const exclude of excludes ?? []) {
    args.push("--glob", exclude.startsWith("!") ? exclude : `!${exclude}`);
  }
  args.push("--", ".");
  return args;
}

function parseContentJson(output) {
  const matches = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    let env;
    try {
      env = JSON.parse(line);
    } catch {
      continue;
    }
    if (env.type !== "match") {
      continue;
    }
    const path = env.data?.path?.text;
    const lineNumber = env.data?.line_number;
    const text = env.data?.lines?.text;
    if (typeof path === "string" && typeof lineNumber === "number" && typeof text === "string") {
      matches.push({ path, line: lineNumber, text });
    }
  }
  return matches;
}

function normContent(matches) {
  return matches
    .map((m) => ({ path: normalizeNativeSearchPath(m.path), line: m.line, text: m.text.replace(/\r?\n$/u, "") }))
    .sort((a, b) => (a.path + "\u0000" + a.line + "\u0000" + a.text).localeCompare(b.path + "\u0000" + b.line + "\u0000" + b.text));
}

function normFiles(paths) {
  return paths
    .map((p) => normalizeNativeSearchPath(p))
    .filter((p) => p.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

export async function contentParity(root, options) {
  const rgOut = await spawnRg(buildContentArgs(options), root);
  const rg = normContent(parseContentJson(rgOut));

  const addon = loadNativeSearchAddon();
  if (addon === null) {
    throw new Error("native search addon not built");
  }
  const result = await addon.searchContent({
    root,
    query: options.query,
    regex: options.regex ?? false,
    all: options.all ?? false,
    globs: options.globs ?? [],
    excludes: options.excludes ?? [],
  });
  const native = normContent(result.matches);
  return { rg, native };
}

function buildFilesArgs({ all, globs, excludes, rootIsFile, rootName }) {
  const args = ["--files"];
  if (all) {
    args.push("--hidden", "--no-ignore");
  }
  for (const glob of globs ?? []) {
    args.push("--glob", glob);
  }
  for (const exclude of excludes ?? []) {
    args.push("--glob", `!${exclude}`);
  }
  args.push("--", rootIsFile ? (rootName ?? "") : ".");
  return args;
}

export async function filesParity(root, options = {}) {
  const rgOut = await spawnRg(buildFilesArgs(options), root);
  const rg = normFiles(rgOut.split(/\r?\n/u).filter((l) => l.trim().length > 0));

  const addon = loadNativeSearchAddon();
  if (addon === null) {
    throw new Error("native search addon not built");
  }
  const result = await addon.searchFiles({
    root,
    all: options.all ?? false,
    globs: options.globs ?? [],
    excludes: options.excludes ?? [],
    rootIsFile: options.rootIsFile ?? false,
    rootName: options.rootName ?? (options.rootIsFile ? basename(root) : undefined),
  });
  const native = normFiles(result.paths);
  return { rg, native };
}
