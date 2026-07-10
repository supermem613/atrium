import type {
  NormalizedSearchResult,
  NativeSearchEnvelope,
  SearchContentMatch,
  SearchFileMatch,
  SearchPerfMetadata,
  SearchInvocationPerfAttributes,
  XrayEnvelope,
} from "./types.js";

export function normalizeSearchResult(
  envelope: XrayEnvelope | NativeSearchEnvelope,
  kind: "content" | "files",
  searchInvocation?: SearchPerfMetadata["searchInvocation"],
): NormalizedSearchResult {
  const warnings = [...(envelope.warnings ?? [])];
  const summary = envelope.data?.summary;
  if (summary?.truncated === true) {
    warnings.push("results truncated by max");
  }
  if (summary?.timedOut === true) {
    warnings.push("search timed out");
  }

  const rawMatches = envelope.data?.matches ?? [];
  const metadata = buildSearchPerfMetadata(envelope, kind, searchInvocation);

  const shouldExposePerf = searchInvocation !== undefined;

  if (kind === "content") {
    const matches: SearchContentMatch[] = [];
    for (const match of rawMatches) {
      if (typeof match.path === "string" && typeof match.line === "number" && typeof match.text === "string") {
        matches.push({ path: isNativeSearchEnvelope(envelope) ? normalizeNativeSearchPath(match.path) : match.path, line: match.line, text: match.text });
      }
    }
    const normalized = {
      kind: "content" as const,
      matches,
      warnings,
      ...(shouldExposePerf ? { perf: metadata } : {}),
    };
    return normalized as NormalizedSearchResult;
  }

  const matches: SearchFileMatch[] = [];
  for (const match of rawMatches) {
    if (typeof match.path === "string") {
      matches.push({ path: isNativeSearchEnvelope(envelope) ? normalizeNativeSearchPath(match.path) : match.path });
    }
  }
  const normalized = {
    kind: "files" as const,
    matches,
    warnings,
    ...(shouldExposePerf ? { perf: metadata } : {}),
  };
  return normalized as NormalizedSearchResult;
}

export function normalizeXrayResult(envelope: XrayEnvelope, kind: "content" | "files", searchInvocation?: SearchPerfMetadata["searchInvocation"]): NormalizedSearchResult {
  return normalizeSearchResult(envelope, kind, searchInvocation);
}

export function buildNativeSearchInvocationPerfAttributes(options: {
  command: "search" | "files";
  root: string;
  query?: string;
  regex?: boolean;
  glob?: string;
  exclude?: string;
  max?: number;
}): SearchInvocationPerfAttributes {
  return {
    command: options.command,
    rootHash: options.root.length > 0 ? shortHash(options.root) : undefined,
    queryHash: options.query === undefined ? undefined : shortHash(options.query),
    regex: options.regex === true,
    max: options.max ?? null,
    globCount: options.glob === undefined ? 0 : 1,
    typeCount: 0,
  };
}

function buildSearchPerfMetadata(
  envelope: XrayEnvelope | NativeSearchEnvelope,
  kind: "content" | "files",
  searchInvocation?: SearchPerfMetadata["searchInvocation"],
): SearchPerfMetadata {
  const metricsValue = envelope.metrics ?? envelope.data?.metrics;
  const xrayMetrics = isXrayMetricsPayload(metricsValue)
    ? {
      elapsedMs: metricsValue.elapsedMs,
      filesScanned: metricsValue.filesScanned,
      matchesReturned: metricsValue.matchesReturned,
    }
    : undefined;

  const ripgrepMetrics = isRipgrepMetricsPayload(metricsValue)
    ? metricsValue.ripgrepMetrics
    : undefined;

  return {
    searchInvocation,
    normalization: { kind, matchCount: envelope.data?.matches?.length ?? 0 },
    ...(xrayMetrics === undefined ? {} : { xrayMetrics }),
    ...(ripgrepMetrics === undefined ? {} : { ripgrepMetrics }),
  };
}

function isXrayMetricsPayload(value: unknown): value is { elapsedMs?: number; filesScanned?: number; matchesReturned?: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { elapsedMs?: number; filesScanned?: number; matchesReturned?: number };
  return candidate.elapsedMs !== undefined || candidate.filesScanned !== undefined || candidate.matchesReturned !== undefined;
}

function isRipgrepMetricsPayload(value: unknown): value is { ripgrepMetrics?: SearchPerfMetadata["ripgrepMetrics"] } {
  return typeof value === "object" && value !== null && "ripgrepMetrics" in (value as Record<string, unknown>);
}

function isNativeSearchEnvelope(envelope: XrayEnvelope | NativeSearchEnvelope): envelope is NativeSearchEnvelope {
  return "kind" in envelope && typeof envelope.kind === "string";
}

export function normalizeNativeSearchPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.replace(/^(\.\/)+/u, "");
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) >>> 0;
  }
  return `h${hash.toString(16)}`;
}
