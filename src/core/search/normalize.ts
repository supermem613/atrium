import type {
  NormalizedSearchResult,
  SearchContentMatch,
  SearchFileMatch,
  SearchPerfMetadata,
  XrayEnvelope,
} from "./types.js";

export function normalizeXrayResult(envelope: XrayEnvelope, kind: "content" | "files", searchInvocation?: SearchPerfMetadata["searchInvocation"]): NormalizedSearchResult {
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

  if (kind === "content") {
    const matches: SearchContentMatch[] = [];
    for (const match of rawMatches) {
      if (typeof match.path === "string" && typeof match.line === "number" && typeof match.text === "string") {
        matches.push({ path: match.path, line: match.line, text: match.text });
      }
    }
    const normalized = { kind: "content" as const, matches, warnings };
    Object.defineProperty(normalized, "perf", {
      value: metadata,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return normalized as NormalizedSearchResult;
  }

  const matches: SearchFileMatch[] = [];
  for (const match of rawMatches) {
    if (typeof match.path === "string") {
      matches.push({ path: match.path });
    }
  }
  const normalized = { kind: "files" as const, matches, warnings };
  Object.defineProperty(normalized, "perf", {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return normalized as NormalizedSearchResult;
}

function buildSearchPerfMetadata(envelope: XrayEnvelope, kind: "content" | "files", searchInvocation?: SearchPerfMetadata["searchInvocation"]): SearchPerfMetadata {
  const metricsValue = envelope.metrics ?? envelope.data?.metrics;
  const xrayMetrics = isXrayMetricsPayload(metricsValue)
    ? {
      elapsedMs: metricsValue.elapsedMs,
      filesScanned: metricsValue.filesScanned,
      matchesReturned: metricsValue.matchesReturned,
    }
    : undefined;

  return {
    searchInvocation,
    normalization: { kind, matchCount: envelope.data?.matches?.length ?? 0 },
    ...(xrayMetrics === undefined ? {} : { xrayMetrics }),
  };
}

function isXrayMetricsPayload(value: unknown): value is { elapsedMs?: number; filesScanned?: number; matchesReturned?: number } {
  return typeof value === "object" && value !== null;
}
