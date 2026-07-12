import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { normalizeNativeSearchPath } from "./normalize.js";
import { resolveBundledRgPath } from "./rgPath.js";
import { planSmartSearch } from "./smartPlan.js";
import { loadNativeSearchAddon } from "./nativeAddon.js";
import type { NativeContentTypeDef, NativeSearchAddon } from "./nativeAddon.js";
import type { ContentSearchOptions, ContentSearchResult, ContentSearchInvocation, ContentSearchRunner, SearchContentMatch, ContentSearchRunMetrics } from "./types.js";

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
  const regex = options.regex ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const all = options.all ?? false;
  const globs = options.globs ?? [];
  const excludes = options.excludes === undefined
    ? (all ? [] : [...DEFAULT_CONTENT_SEARCH_EXCLUDES])
    : options.excludes;
  const runner = options.runner ?? defaultContentSearchRunner;

  // A file root must run from its parent directory with the file name as the search path.
  // Passing a file as the child process cwd makes Windows spawn fail with a misleading ENOENT
  // that names rg.exe rather than the bad cwd. An injected runner controls its own execution,
  // so the real filesystem probe only runs for the default spawning runner.
  const location = options.runner === undefined
    ? await resolveContentSearchRoot(options.root)
    : { cwd: options.root, rootIsFile: false, rootName: undefined };

  const plan = planSmartSearch({ query, regex });
  const laneArgSets = plan.strategy === "sequential"
    ? [[] as string[]]
    : plan.lanes.map((lane) => lane.args);

  const matches: SearchContentMatch[] = [];
  const warnings: string[] = [];
  const warningSeen = new Set<string>();
  const seen = new Set<string>();
  const metrics: ContentSearchRunMetrics | undefined = options.perf === true ? { searches: 0 } : undefined;
  let timedOut = false;
  let truncated = false;

  const pushWarning = (warning: string): void => {
    if (warningSeen.has(warning)) {
      return;
    }
    warningSeen.add(warning);
    warnings.push(warning);
  };

  const runLane = async (laneArgs: string[]): Promise<void> => {
    const args = buildRipgrepArgs({
      query,
      regex,
      all,
      globs,
      excludes,
      laneArgs,
      rootIsFile: location.rootIsFile,
      rootName: location.rootName,
    });

    let invocation: ContentSearchInvocation;
    try {
      invocation = await runner(args, { cwd: location.cwd, timeoutMs, query, regex, perf: options.perf === true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The spawning runner already prefixes its failures. Re-prefixing here produced a
      // doubly nested "fatal ripgrep error: fatal ripgrep error: ..." that hid the real cause.
      throw new Error(message.startsWith("fatal ripgrep error:") ? message : `fatal ripgrep error: ${message}`);
    }

    if (invocation.timedOut === true) {
      timedOut = true;
    }
    if (invocation.truncated === true) {
      truncated = true;
    }
    for (const warning of invocation.warnings ?? []) {
      pushWarning(warning);
    }
    if (metrics !== undefined) {
      accumulateMetrics(metrics, invocation.metrics);
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
  };

  for (const laneArgs of laneArgSets) {
    if (matches.length >= max) {
      break;
    }
    await runLane(laneArgs);
  }

  // A narrowed plan bets that the query only appears in one lane. When that bet returns nothing,
  // fall back to an unrestricted walk so callers do not miss matches living in other file types.
  if (matches.length === 0 && plan.fallbackOnZero && plan.strategy !== "sequential") {
    await runLane([]);
  }

  if (timedOut) {
    pushWarning(`search stopped after ${timeoutMs} ms`);
  }
  if (truncated) {
    pushWarning("search output was truncated");
  }

  if (max !== Number.POSITIVE_INFINITY && matches.length >= max && !warnings.some((warning) => warning.includes("display capped at"))) {
    pushWarning(`display capped at ${max} matches`);
  }

  return {
    kind: "content",
    matches,
    warnings,
    ...(metrics === undefined ? {} : { metrics }),
  };
}

interface ContentSearchLocation {
  cwd: string;
  rootIsFile: boolean;
  rootName: string | undefined;
}

async function resolveContentSearchRoot(root: string): Promise<ContentSearchLocation> {
  const resolved = resolve(root);
  try {
    const stats = await stat(resolved);
    if (stats.isDirectory()) {
      return { cwd: resolved, rootIsFile: false, rootName: undefined };
    }
    if (stats.isFile()) {
      return { cwd: dirname(resolved), rootIsFile: true, rootName: basename(resolved) };
    }
    throw new Error(`invalid root: ${root}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid root:")) {
      throw error;
    }
    if (error !== null && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`invalid root: ${root}`);
    }
    throw error;
  }
}

function accumulateMetrics(target: ContentSearchRunMetrics, source: ContentSearchRunMetrics | undefined): void {
  if (source === undefined) {
    return;
  }
  const keys: (keyof ContentSearchRunMetrics)[] = [
    "searches",
    "bytesSearched",
    "bytesPrinted",
    "matchedLines",
    "matches",
    "spawnCallMs",
    "spawnReadyMs",
    "childRunMs",
    "childTotalMs",
    "parseMs",
  ];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

function buildRipgrepArgs(options: { query: string; regex: boolean; all: boolean; globs: string[]; excludes: string[]; laneArgs: string[]; rootIsFile: boolean; rootName: string | undefined }): string[] {
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
  args.push(options.rootIsFile ? (options.rootName ?? ".") : ".");
  return args;
}

export async function spawnContentSearchRunner(args: string[], options: { cwd: string; timeoutMs: number; query: string; regex: boolean; perf: boolean }): Promise<ContentSearchInvocation> {
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

export interface ContentSearchRunnerDeps {
  loadAddon?: () => NativeSearchAddon | null;
  spawnRunner?: ContentSearchRunner;
  onFallback?: (error: unknown) => void;
}

// Reconstruct addon options from the ripgrep args the core layer built, so the
// native runner keeps the exact same include/exclude/type-lane behavior as the
// spawned ripgrep. Parsing stops at `--`, which separates flags from paths.
export function parseNativeContentArgs(args: string[]): {
  all: boolean;
  globs: string[];
  excludes: string[];
  typeDefs: NativeContentTypeDef[];
  typeSelect: string[];
  typeNegate: string[];
} {
  const globs: string[] = [];
  const excludes: string[] = [];
  const typeDefs: NativeContentTypeDef[] = [];
  const typeSelect: string[] = [];
  const typeNegate: string[] = [];
  let all = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    // The query is emitted as the value of `-e`. Skip that value so a query
    // string that looks like a flag is never parsed as one.
    if (arg === "-e") {
      i += 1;
      continue;
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
      continue;
    }
    if (arg === "--type-add") {
      const value = args[i + 1];
      i += 1;
      if (value === undefined) {
        continue;
      }
      const sep = value.indexOf(":");
      if (sep > 0) {
        typeDefs.push({ name: value.slice(0, sep), glob: value.slice(sep + 1) });
      }
      continue;
    }
    if (arg === "--type") {
      const value = args[i + 1];
      i += 1;
      if (value !== undefined) {
        typeSelect.push(value);
      }
      continue;
    }
    if (arg === "--type-not") {
      const value = args[i + 1];
      i += 1;
      if (value !== undefined) {
        typeNegate.push(value);
      }
    }
  }
  return { all, globs, excludes, typeDefs, typeSelect, typeNegate };
}

// Runs the search in-process through the napi addon when it loads, and falls
// back to spawning bundled ripgrep when the addon is absent or throws. The
// native path never records spawn metrics, which is how callers tell the two
// apart. `max` is deliberately not forwarded so the TS normalize layer owns
// display capping identically for both paths.
export function createNativeContentSearchRunner(deps: ContentSearchRunnerDeps = {}): ContentSearchRunner {
  const loadAddon = deps.loadAddon ?? loadNativeSearchAddon;
  const spawnRunner = deps.spawnRunner ?? spawnContentSearchRunner;
  const onFallback = deps.onFallback;

  return async (args, options) => {
    const addon = loadAddon();
    if (addon === null) {
      return spawnRunner(args, options);
    }

    const parsed = parseNativeContentArgs(args);
    try {
      const result = await addon.searchContent({
        root: options.cwd,
        query: options.query,
        regex: options.regex,
        all: parsed.all,
        globs: parsed.globs,
        excludes: parsed.excludes,
        typeDefs: parsed.typeDefs,
        typeSelect: parsed.typeSelect,
        typeNegate: parsed.typeNegate,
        timeoutMs: options.timeoutMs,
        perf: options.perf,
      });
      const metrics: ContentSearchRunMetrics | undefined = options.perf
        ? { searches: result.metrics?.searches ?? 1, childRunMs: result.metrics?.childRunMs }
        : undefined;
      return {
        args,
        matches: result.matches,
        warnings: [],
        timedOut: result.timedOut,
        truncated: result.truncated,
        metrics,
      };
    } catch (error) {
      if (onFallback !== undefined) {
        onFallback(error);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        // stderr is safe in the stdio MCP server; stdout is the protocol channel.
        console.error(`native search addon failed, falling back to ripgrep: ${message}`);
      }
      return spawnRunner(args, options);
    }
  };
}

const defaultContentSearchRunner: ContentSearchRunner = createNativeContentSearchRunner();

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
