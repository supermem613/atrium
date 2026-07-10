import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { normalizeNativeSearchPath } from "./normalize.js";
import { resolveBundledRgPath } from "./rgPath.js";
import type { NativeFileSearchInvocation, NativeFileSearchOptions, NativeFileSearchResult } from "./types.js";

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

  const args = buildRipgrepArgs({ all, globs, excludes, rootIsFile, rootName: rootIsFile ? basename(root) : undefined });

  const matches: NativeFileSearchInvocation["paths"] = [];
  const warnings: string[] = [];
  let invocation: NativeFileSearchInvocation;

  try {
    invocation = await runner(args, { cwd, timeoutMs, max, perf: options.perf === true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`fatal ripgrep error: ${message}`);
  }

  if (invocation.timedOut) {
    warnings.push(`search stopped after ${timeoutMs} ms`);
  }
  if (invocation.truncated) {
    warnings.push("search output was truncated");
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

  if (max !== Number.POSITIVE_INFINITY && matches.length >= max && !warnings.some((warning) => warning.includes("display capped at"))) {
    warnings.push(`display capped at ${max} files`);
  }

  return {
    kind: "files",
    matches: matches.map((path) => ({ path })),
    warnings,
    ...(options.perf === true && invocation.metrics !== undefined ? { metrics: invocation.metrics } : {}),
  };
}

function buildRipgrepArgs(options: { all: boolean; globs: string[]; excludes: string[]; rootIsFile: boolean; rootName?: string }): string[] {
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

async function defaultNativeFileSearchRunner(args: string[], options: { cwd: string; timeoutMs: number; max: number; perf: boolean }): Promise<NativeFileSearchInvocation> {
  const rgPath = resolveBundledRgPath();
  if (rgPath === null) {
    throw new Error("fatal ripgrep error: ripgrep binary not available");
  }

  return new Promise((resolve, reject) => {
    const spawnStartedAt = options.perf ? performance.now() : undefined;
    const child = spawn(rgPath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const spawnReturnedAt = options.perf ? performance.now() : undefined;
    let spawnReadyAt = spawnReturnedAt;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };

    const finish = (result: NativeFileSearchInvocation) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      resolve(result);
    };

    const finishError = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      reject(new Error(message));
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      stdout += String(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      stderr += String(chunk);
    });

    if (options.perf) {
      child.on("spawn", () => {
        spawnReadyAt = performance.now();
      });
    }

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }

    child.on("error", (error: Error) => {
      finishError(`fatal ripgrep error: ${error.message}`);
    });

    child.on("close", (code: number | null) => {
      const childClosedAt = options.perf ? performance.now() : undefined;
      const warnings = stderr.trim().length > 0 ? [stderr.trim()] : [];
      const parseStartedAt = options.perf ? performance.now() : undefined;
      const paths = parseRipgrepFileOutput(stdout);
      const parseEndedAt = options.perf ? performance.now() : undefined;
      const metrics = options.perf
        ? {
          searches: 1,
          spawnCallMs: (spawnReturnedAt ?? 0) - (spawnStartedAt ?? 0),
          spawnReadyMs: (spawnReadyAt ?? 0) - (spawnReturnedAt ?? 0),
          childRunMs: (childClosedAt ?? 0) - (spawnReadyAt ?? 0),
          childTotalMs: (childClosedAt ?? 0) - (spawnStartedAt ?? 0),
          parseMs: (parseEndedAt ?? 0) - (parseStartedAt ?? 0),
        }
        : undefined;
      if (timedOut) {
        finish({ paths, warnings, timedOut: true, truncated: false, metrics });
        return;
      }
      if (code !== 0 && code !== 1) {
        finishError(`fatal ripgrep error: exited with code ${String(code)}`);
        return;
      }
      finish({ paths, warnings, timedOut: false, truncated: false, metrics });
    });
  });
}

function parseRipgrepFileOutput(output: string): string[] {
  return output.split(/\r?\n/u).filter((line) => line.trim().length > 0);
}

function normalizePath(filePath: string): string {
  return normalizeNativeSearchPath(filePath);
}
