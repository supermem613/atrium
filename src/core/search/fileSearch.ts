import { stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { normalizeNativeSearchPath } from "./normalize.js";
import { loadNativeSearchAddon } from "./nativeAddon.js";
import type { NativeSearchAddon } from "./nativeAddon.js";
import type { NativeFileSearchInvocation, NativeFileSearchOptions, NativeFileSearchResult, NativeFileSearchRunner, ContentSearchRunMetrics } from "./types.js";

const DEFAULT_TIMEOUT_MS = 59_000;

export async function runNativeFileSearch(options: NativeFileSearchOptions): Promise<NativeFileSearchResult> {
  const root = resolve(options.root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const runner = options.runner ?? defaultNativeFileSearchRunner;
  const globs = options.globs ?? [];
  const excludes = options.excludes ?? [];
  const all = options.all ?? false;

  let cwd: string;
  let relativeBase: string;
  let rootIsFile = false;

  try {
    const rootStats = await stat(root);
    if (rootStats.isDirectory()) {
      cwd = root;
      relativeBase = root;
      rootIsFile = false;
    } else if (rootStats.isFile()) {
      cwd = dirname(root);
      relativeBase = dirname(root);
      rootIsFile = true;
    } else {
      throw new Error(`invalid root: ${options.root}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid root:")) {
      throw error;
    }
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`invalid root: ${options.root}`);
    }
    throw error;
  }

  const args = buildSearchArgs({ all, globs, excludes, rootIsFile, rootName: rootIsFile ? basename(root) : undefined });

  const matches: NativeFileSearchInvocation["paths"] = [];
  const warnings: string[] = [];
  let invocation: NativeFileSearchInvocation;
  let truncated = false;

  try {
    invocation = await runner(args, { cwd, timeoutMs, max: options.max ?? Number.POSITIVE_INFINITY, perf: options.perf === true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`fatal search error: ${message}`);
  }

  if (invocation.timedOut) {
    warnings.push(`search stopped after ${timeoutMs} ms`);
  }
  if (invocation.truncated) {
    truncated = true;
  }
  for (const warning of invocation.warnings ?? []) {
    warnings.push(warning);
  }

  for (const path of invocation.paths) {
    if (matches.length >= max) {
      break;
    }
    const normalized = normalizePath(relative(relativeBase, resolve(cwd, path)));
    if (normalized.length === 0) {
      continue;
    }
    matches.push(normalized);
  }

  if (max !== Number.POSITIVE_INFINITY && matches.length >= max && !truncated) {
    truncated = true;
  }
  if (truncated && !warnings.some((warning) => warning.includes("search output was truncated"))) {
    warnings.push("search output was truncated");
  }

  return {
    kind: "files",
    matches: matches.map((path) => ({ path })),
    warnings,
    ...(options.perf === true && invocation.metrics !== undefined ? { metrics: invocation.metrics } : {}),
  };
}

function buildSearchArgs(options: { all: boolean; globs: string[]; excludes: string[]; rootIsFile: boolean; rootName?: string }): string[] {
  const args = ["--files"];
  if (options.all) {
    args.push("--hidden", "--no-ignore");
  }
  for (const glob of options.globs) {
    args.push("--glob", glob);
  }
  for (const exclude of options.excludes) {
    args.push("--glob", `!${exclude}`);
  }
  if (options.rootIsFile) {
    args.push("--", options.rootName ?? "");
  } else {
    args.push("--", ".");
  }
  return args;
}

export interface FileSearchRunnerDeps {
  loadAddon?: () => NativeSearchAddon | null;
}

// Reconstruct addon options from the search args the core layer built. The
// token after `--` is the search path: `.` means the root is a directory, any
// other value is a single file name relative to cwd.
export function parseNativeFileArgs(args: string[]): {
  all: boolean;
  globs: string[];
  excludes: string[];
  rootIsFile: boolean;
  rootName?: string;
} {
  const globs: string[] = [];
  const excludes: string[] = [];
  let all = false;
  let rootIsFile = false;
  let rootName: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      const token = args[i + 1];
      if (token !== undefined && token !== ".") {
        rootIsFile = true;
        rootName = token;
      }
      break;
    }
    if (arg === "--hidden" || arg === "--no-ignore") {
      all = true;
      continue;
    }
    if (arg === "--glob") {
      const value = args[i + 1];
      i += 1;
      if (value === undefined) {
        continue;
      }
      if (value.startsWith("!")) {
        excludes.push(value.slice(1));
      } else {
        globs.push(value);
      }
    }
  }
  return { all, globs, excludes, rootIsFile, rootName };
}

// Lists files in-process through the napi addon, which is the only search
// engine. A missing or unloadable addon is a hard, loud failure so search never
// silently degrades.
export function createNativeFileSearchRunner(deps: FileSearchRunnerDeps = {}): NativeFileSearchRunner {
  const loadAddon = deps.loadAddon ?? loadNativeSearchAddon;

  return async (args, options) => {
    const addon = loadAddon();
    if (addon === null) {
      throw new Error("native search addon not available; run `bun run build:native` to build the in-process search engine");
    }

    const parsed = parseNativeFileArgs(args);
    const providedMax = options.max;
    const max = typeof providedMax === "number" && Number.isFinite(providedMax) ? providedMax : undefined;
    try {
      const result = await addon.searchFiles({
        root: options.cwd,
        all: parsed.all,
        globs: parsed.globs,
        excludes: parsed.excludes,
        rootIsFile: parsed.rootIsFile,
        rootName: parsed.rootName,
        timeoutMs: options.timeoutMs,
        max,
        perf: options.perf,
      });
      const metrics: ContentSearchRunMetrics | undefined = options.perf
        ? { searches: result.metrics?.searches ?? 1, childRunMs: result.metrics?.childRunMs }
        : undefined;
      return {
        paths: result.paths,
        warnings: [],
        timedOut: result.timedOut,
        truncated: result.truncated,
        metrics,
      };
    } catch (error) {
      // The addon is the only engine. Surface its failure loudly instead of
      // silently degrading; runNativeFileSearch adds the "fatal search error" prefix.
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
}

const defaultNativeFileSearchRunner: NativeFileSearchRunner = createNativeFileSearchRunner();

function normalizePath(filePath: string): string {
  return normalizeNativeSearchPath(filePath);
}
