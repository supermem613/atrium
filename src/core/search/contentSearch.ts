import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { normalizeNativeSearchPath } from "./normalize.js";
import { planSmartSearch } from "./smartPlan.js";
import { loadNativeSearchAddon } from "./nativeAddon.js";
import type { NativeContentTypeDef, NativeSearchAddon } from "./nativeAddon.js";
import type { ContentSearchOptions, ContentSearchResult, ContentSearchInvocation, ContentSearchRunner, SearchContentMatch, ContentSearchRunMetrics } from "./types.js";

export const DEFAULT_REPOSITORY_SEARCH_EXCLUDES = [
  "!**/.git/**",
  "!**/.sd/**",
] as const;

const DEFAULT_GENERATED_SEARCH_EXCLUDES = [
  "!**/node_modules/**",
  "!**/.copilot/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/coverage/**",
  "!**/.cache/**",
  "!AppData/**",
] as const;

export const DEFAULT_CONTENT_SEARCH_EXCLUDES = [
  ...DEFAULT_REPOSITORY_SEARCH_EXCLUDES,
  ...DEFAULT_GENERATED_SEARCH_EXCLUDES,
] as const;

export function configureContentSearchExcludes(repositoryExcludes?: readonly string[]): string[] {
  return [
    ...(repositoryExcludes ?? DEFAULT_REPOSITORY_SEARCH_EXCLUDES),
    ...DEFAULT_GENERATED_SEARCH_EXCLUDES,
  ];
}

const DEFAULT_TIMEOUT_MS = 59_000;
const DEFAULT_MAX_FILE_SIZE = "2M";

export async function runContentSearch(options: ContentSearchOptions): Promise<ContentSearchResult> {
  const query = options.query;
  const regex = options.regex ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const all = options.all ?? false;
  const globs = options.globs ?? [];
  const defaultExcludes = options.defaultExcludes ?? DEFAULT_CONTENT_SEARCH_EXCLUDES;
  const excludes = [...new Set([
    ...(all ? [] : defaultExcludes),
    ...(options.excludes ?? []),
  ].map(normalizeExcludePattern))];
  const runner = options.runner ?? defaultContentSearchRunner;

  // A file root must run from its parent directory with the file name as the search path.
  // Only the default runner needs the filesystem probe to classify the root as a file or a
  // directory. An injected runner controls its own execution and receives the root as given.
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
    const args = buildSearchArgs({
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
      const runnerOptions: Parameters<ContentSearchRunner>[1] = {
        cwd: location.cwd,
        timeoutMs,
        query,
        regex,
        perf: options.perf === true,
        ...(options.max !== undefined ? { max: options.max } : {}),
      };
      invocation = await runner(args, runnerOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The runner may already prefix its failures. Re-prefixing here produced a
      // doubly nested "fatal search error: fatal search error: ..." that hid the real cause.
      throw new Error(message.startsWith("fatal search error:") ? message : `fatal search error: ${message}`);
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
  if (max !== Number.POSITIVE_INFINITY && matches.length >= max && !truncated) {
    truncated = true;
  }
  if (truncated) {
    pushWarning("search output was truncated");
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
    "childRunMs",
  ];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") {
      target[key] = (target[key] ?? 0) + value;
    }
  }
}

function buildSearchArgs(options: { query: string; regex: boolean; all: boolean; globs: string[]; excludes: string[]; laneArgs: string[]; rootIsFile: boolean; rootName: string | undefined }): string[] {
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
    args.push("--glob", exclude);
  }
  args.push(...options.laneArgs);
  args.push("--");
  args.push(options.rootIsFile ? (options.rootName ?? ".") : ".");
  return args;
}

function normalizeExcludePattern(pattern: string): string {
  return pattern.startsWith("!") ? pattern : `!${pattern}`;
}

export interface ContentSearchRunnerDeps {
  loadAddon?: () => NativeSearchAddon | null;
}

// Reconstruct addon options from the search args the core layer built. Parsing
// stops at `--`, which separates flags from paths.
export function parseNativeContentArgs(args: string[]): {
  all: boolean;
  globs: string[];
  excludes: string[];
  typeDefs: NativeContentTypeDef[];
  typeSelect: string[];
  typeNegate: string[];
  rootIsFile: boolean;
  rootName?: string;
} {
  const globs: string[] = [];
  const excludes: string[] = [];
  const typeDefs: NativeContentTypeDef[] = [];
  const typeSelect: string[] = [];
  const typeNegate: string[] = [];
  let all = false;
  let rootIsFile = false;
  let rootName: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      // The token after `--` is the search path: `.` means the root is a
      // directory, any other value is a single file name relative to cwd.
      // Capturing it lets a single-file search restrict to that one file
      // instead of scanning its whole parent directory.
      const token = args[i + 1];
      if (token !== undefined && token !== ".") {
        rootIsFile = true;
        rootName = token;
      }
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
  return { all, globs, excludes, typeDefs, typeSelect, typeNegate, rootIsFile, rootName };
}

// Runs the search in-process through the napi addon, which is the only search
// engine. A missing or unloadable addon is a hard, loud failure so search never
// silently degrades. `max` is forwarded as the native produced-result cap; the
// TypeScript layer only uses it as a defensive normalization boundary when
// multi-lane merges would otherwise exceed it.
export function createNativeContentSearchRunner(deps: ContentSearchRunnerDeps = {}): ContentSearchRunner {
  const loadAddon = deps.loadAddon ?? loadNativeSearchAddon;

  return async (args, options) => {
    const addon = loadAddon();
    if (addon === null) {
      throw new Error("native search addon not available; run `bun run build:native` to build the in-process search engine");
    }

    const parsed = parseNativeContentArgs(args);
    const providedMax = options.max;
    const max = typeof providedMax === "number" && Number.isFinite(providedMax) ? providedMax : undefined;
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
        args,
        matches: result.matches,
        warnings: [],
        timedOut: result.timedOut,
        truncated: result.truncated,
        metrics,
      };
    } catch (error) {
      // The addon is the only engine. Surface its failure loudly instead of
      // silently degrading; runContentSearch adds the "fatal search error" prefix.
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
}

const defaultContentSearchRunner: ContentSearchRunner = createNativeContentSearchRunner();
