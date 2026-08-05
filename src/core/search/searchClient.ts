import { configureContentSearchExcludes, runContentSearch } from "./contentSearch.js";
import { runNativeFileSearch } from "./fileSearch.js";
import type {
  ContentSearchOptions,
  ContentSearchResult,
  NativeFileSearchResult,
  NativeSearchEnvelope,
  NativeSearchRunOptions,
  NativeSearchPerfMetrics,
} from "./types.js";

export interface NativeSearchClientDependencies {
  repositoryExcludes?: readonly string[];
  runContentSearch?: (options: ContentSearchOptions) => Promise<ContentSearchResult>;
  runFileSearch?: (options: { root: string; max?: number; timeoutMs?: number; globs?: string[]; excludes?: string[]; all?: boolean; perf?: boolean }) => Promise<NativeFileSearchResult>;
}

export interface NativeSearchClientLike {
  run(options: NativeSearchRunOptions): Promise<NativeSearchEnvelope>;
}

export function createNativeSearchClient(dependencies: NativeSearchClientDependencies = {}): NativeSearchClientLike {
  const contentSearch = dependencies.runContentSearch ?? runContentSearch;
  const fileSearch = dependencies.runFileSearch ?? runNativeFileSearch;
  const contentDefaultExcludes = dependencies.repositoryExcludes === undefined
    ? undefined
    : configureContentSearchExcludes(dependencies.repositoryExcludes);

  return {
    async run(options: NativeSearchRunOptions): Promise<NativeSearchEnvelope> {
      if (options.command === "files") {
        const result = await fileSearch({
          root: options.root,
          ...(options.max !== undefined ? { max: options.max } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.glob === undefined ? {} : { globs: [options.glob] }),
          ...(options.exclude === undefined ? {} : { excludes: asArray(options.exclude) }),
          ...(options.all === true ? { all: true } : {}),
          ...(options.perf === true ? { perf: true } : {}),
        });

        return {
          ok: true,
          command: "files",
          kind: "files",
          data: {
            matches: result.matches.map((match) => ({ path: match.path })),
            summary: { fileCount: result.matches.length, truncated: false, timedOut: false },
          },
          warnings: result.warnings,
          ...(options.perf === true ? {
            metrics: {
              searchMetrics: buildSearchMetrics(result),
            },
          } : {}),
        };
      }

      const result = await contentSearch({
        query: options.query ?? "",
        root: options.root,
        ...(contentDefaultExcludes === undefined ? {} : { defaultExcludes: contentDefaultExcludes }),
        ...(options.regex === true ? { regex: true } : {}),
        ...(options.max !== undefined ? { max: options.max } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.all === true ? { all: true } : {}),
        ...(options.glob === undefined ? {} : { globs: [options.glob] }),
        ...(options.exclude === undefined ? {} : { excludes: asArray(options.exclude) }),
        ...(options.perf === true ? { perf: true } : {}),
      });

      return {
        ok: true,
        command: "search",
        kind: "content",
        data: {
          matches: result.matches.map((match) => ({ path: match.path, line: match.line, text: match.text })),
          summary: { matchCount: result.matches.length, truncated: false, timedOut: false },
        },
        warnings: result.warnings,
        ...(options.perf === true ? {
          metrics: {
            searchMetrics: buildSearchMetrics(result),
          },
        } : {}),
      };
    },
  };
}

function asArray(value: string | readonly string[]): string[] {
  return typeof value === "string" ? [value] : [...value];
}

function buildSearchMetrics(result: ContentSearchResult | NativeFileSearchResult): NativeSearchPerfMetrics | undefined {
  if (result.metrics === undefined) {
    return undefined;
  }
  return {
    ...(result.metrics.searches === undefined ? {} : { searches: result.metrics.searches }),
    ...(result.metrics.childRunMs === undefined ? {} : { childRunMs: result.metrics.childRunMs }),
  };
}
