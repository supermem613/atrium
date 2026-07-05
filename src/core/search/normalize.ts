import type {
  NormalizedSearchResult,
  SearchContentMatch,
  SearchFileMatch,
  XrayEnvelope,
} from "./types.js";

export function normalizeXrayResult(envelope: XrayEnvelope, kind: "content" | "files"): NormalizedSearchResult {
  const warnings = [...(envelope.warnings ?? [])];
  const summary = envelope.data?.summary;
  if (summary?.truncated === true) {
    warnings.push("results truncated by max");
  }
  if (summary?.timedOut === true) {
    warnings.push("search timed out");
  }

  const rawMatches = envelope.data?.matches ?? [];

  if (kind === "content") {
    const matches: SearchContentMatch[] = [];
    for (const match of rawMatches) {
      if (typeof match.path === "string" && typeof match.line === "number" && typeof match.text === "string") {
        matches.push({ path: match.path, line: match.line, text: match.text });
      }
    }
    return { kind: "content", matches, warnings };
  }

  const matches: SearchFileMatch[] = [];
  for (const match of rawMatches) {
    if (typeof match.path === "string") {
      matches.push({ path: match.path });
    }
  }
  return { kind: "files", matches, warnings };
}
