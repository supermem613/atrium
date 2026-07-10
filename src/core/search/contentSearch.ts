import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { normalizeNativeSearchPath } from "./normalize.js";
import { resolveBundledRgPath } from "./rgPath.js";
import { planSmartSearch } from "./smartPlan.js";
import type { ContentSearchOptions, ContentSearchResult, ContentSearchInvocation, SearchContentMatch, ContentSearchRunMetrics } from "./types.js";

export const DEFAULT_CONTENT_SEARCH_EXCLUDES = [
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/.copilot/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/coverage/**",
  "!**/.cache/**",
  "!AppData/**",
] as const;

const DEFAULT_TIMEOUT_MS = 59_000;
const DEFAULT_MAX_FILE_SIZE = "2M";

export async function runContentSearch(options: ContentSearchOptions): Promise<ContentSearchResult> {
  const query = options.query;
  const root = options.root;
  const regex = options.regex ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const all = options.all ?? false;
  const globs = options.globs ?? [];
  const excludes = options.excludes === undefined
    ? (all ? [] : [...DEFAULT_CONTENT_SEARCH_EXCLUDES])
    : options.excludes;
  const runner = options.runner ?? defaultContentSearchRunner;
  const plan = planSmartSearch({ query, regex });
  const laneArgs = plan.strategy === "sequential" ? [] : (plan.lanes[0]?.args ?? []);

  const matches: SearchContentMatch[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const metrics: ContentSearchRunMetrics | undefined = options.perf === true ? { searches: 0 } : undefined;
  const args = buildRipgrepArgs({ query, regex, all, globs, excludes, laneArgs });

  let invocation: ContentSearchInvocation;
  try {
    invocation = await runner(args, { cwd: root, timeoutMs, query, regex, perf: options.perf === true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`fatal ripgrep error: ${message}`);
  }

  if (metrics !== undefined) {
    metrics.searches = invocation.metrics?.searches ?? 1;
    metrics.bytesSearched = invocation.metrics?.bytesSearched;
    metrics.bytesPrinted = invocation.metrics?.bytesPrinted;
    metrics.matchedLines = invocation.metrics?.matchedLines;
    metrics.matches = invocation.metrics?.matches;
    metrics.spawnCallMs = invocation.metrics?.spawnCallMs;
    metrics.spawnReadyMs = invocation.metrics?.spawnReadyMs;
    metrics.childRunMs = invocation.metrics?.childRunMs;
    metrics.childTotalMs = invocation.metrics?.childTotalMs;
    metrics.parseMs = invocation.metrics?.parseMs;
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

  for (const match of invocation.matches) {
    if (matches.length >= max) {
      break;
    }
    const normalizedPath = normalizeNativeSearchPath(match.path);
    const id = `${normalizedPath}:${match.line}:${match.text}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    matches.push({ ...match, path: normalizedPath });
  }

  if (max !== Number.POSITIVE_INFINITY && matches.length >= max && !warnings.some((warning) => warning.includes("display capped at"))) {
    warnings.push(`display capped at ${max} matches`);
  }

  return {
    kind: "content",
    matches,
    warnings,
    ...(metrics === undefined ? {} : { metrics }),
  };
}

function buildRipgrepArgs(options: { query: string; regex: boolean; all: boolean; globs: string[]; excludes: string[]; laneArgs: string[] }): string[] {
  const args = ["--line-number", "--color=never", "--json", "--max-filesize", DEFAULT_MAX_FILE_SIZE];
  if (!options.regex) {
    args.push("-F");
  }
  if (options.all) {
    args.push("--hidden", "--no-ignore");
  }
  args.push("-e", options.query);
  for (const glob of options.globs) {
    args.push("--glob", glob);
  }
  for (const exclude of options.excludes) {
    args.push("--glob", exclude.startsWith("!") ? exclude : `!${exclude}`);
  }
  args.push(...options.laneArgs);
  args.push("--");
  args.push(".");
  return args;
}

async function defaultContentSearchRunner(args: string[], options: { cwd: string; timeoutMs: number; query: string; regex: boolean; perf: boolean }): Promise<ContentSearchInvocation> {
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

    const finish = (result: ContentSearchInvocation) => {
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
      const matches = parseRipgrepJsonOutput(stdout);
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
        finish({ args, matches, warnings, timedOut: true, truncated: false, metrics });
        return;
      }
      if (code !== 0 && code !== 1) {
        finishError(`fatal ripgrep error: exited with code ${String(code)}`);
        return;
      }
      finish({ args, matches, warnings, timedOut: false, truncated: false, metrics });
    });
  });
}

function parseRipgrepJsonOutput(output: string): SearchContentMatch[] {
  const matches: SearchContentMatch[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (envelope.type !== "match") {
      continue;
    }
    const data = envelope.data as { path?: { text?: string }; line_number?: number; lines?: { text?: string } } | undefined;
    const path = data?.path?.text;
    const lineNumber = data?.line_number;
    const text = data?.lines?.text;
    if (typeof path === "string" && typeof lineNumber === "number" && typeof text === "string") {
      matches.push({ path, line: lineNumber, text });
    }
  }
  return matches;
}
