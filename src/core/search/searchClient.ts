import { runContentSearch } from "./contentSearch.js";
import { runNativeFileSearch } from "./fileSearch.js";
import type {
  ContentSearchOptions,
  ContentSearchResult,
  NativeFileSearchResult,
  NativeSearchEnvelope,
  NativeSearchRunOptions,
  RipgrepMetricsPerfAttributes,
} from "./types.js";

export interface NativeSearchClientDependencies {
  runContentSearch?: (options: ContentSearchOptions) => Promise<ContentSearchResult>;
  runFileSearch?: (options: { root: string; max?: number; timeoutMs?: number; globs?: string[]; excludes?: string[]; all?: boolean }) => Promise<NativeFileSearchResult>;
}

export interface NativeSearchClientLike {
  run(options: NativeSearchRunOptions): Promise<NativeSearchEnvelope>;
}

export function createNativeSearchClient(dependencies: NativeSearchClientDependencies = {}): NativeSearchClientLike {
  const contentSearch = dependencies.runContentSearch ?? runContentSearch;
  const fileSearch = dependencies.runFileSearch ?? runNativeFileSearch;

  return {
    async run(options: NativeSearchRunOptions): Promise<NativeSearchEnvelope> {
      if (options.command === "files") {
        const result = await fileSearch({
          root: options.root,
          ...(options.max !== undefined ? { max: options.max } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.glob === undefined ? {} : { globs: [options.glob] }),
          ...(options.exclude === undefined ? {} : { excludes: [options.exclude] }),
          ...(options.all === true ? { all: true } : {}),
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
          metrics: {
            ripgrepMetrics: buildRipgrepMetrics(result),
          },
        };
      }

      const result = await contentSearch({
        query: options.query ?? "",
        root: options.root,
        ...(options.regex === true ? { regex: true } : {}),
        ...(options.max !== undefined ? { max: options.max } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.all === true ? { all: true } : {}),
        ...(options.glob === undefined ? {} : { globs: [options.glob] }),
        ...(options.exclude === undefined ? {} : { excludes: [options.exclude] }),
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
        metrics: {
          ripgrepMetrics: buildRipgrepMetrics(result),
        },
      };
    },
  };
}

function buildRipgrepMetrics(result: ContentSearchResult | NativeFileSearchResult): RipgrepMetricsPerfAttributes | undefined {
  if (result.kind === "content") {
    return {
      searches: result.metrics?.searches,
      bytesSearched: result.metrics?.bytesSearched,
      bytesPrinted: result.metrics?.bytesPrinted,
      matchedLines: result.metrics?.matchedLines,
      matches: result.metrics?.matches,
    };
  }

  return result.metrics === undefined ? undefined : {
    searches: result.metrics?.searches,
  };
}
