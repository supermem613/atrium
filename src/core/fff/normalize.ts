export interface FffFileMatch {
  path: string;
}

export interface FffContentMatch {
  path: string;
  line: number;
  text: string;
}

export interface FffNormalizationWarning {
  line: number;
  message: string;
  raw: string;
}

export interface FffFileListResult {
  kind: "files";
  matches: FffFileMatch[];
  warnings: FffNormalizationWarning[];
}

export interface FffContentResult {
  kind: "content";
  matches: FffContentMatch[];
  warnings: FffNormalizationWarning[];
}

export type FffNormalizedResult = FffFileListResult | FffContentResult;

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLineNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function normalizeWarnings(value: unknown): FffNormalizationWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((warning, index) => {
    if (typeof warning === "string") {
      return [{ line: index + 1, message: warning, raw: warning }];
    }
    if (isRecord(warning)) {
      const raw = typeof warning.raw === "string" ? warning.raw : "";
      const message =
        typeof warning.message === "string" ? warning.message : "Unable to parse result line";
      const line = normalizeLineNumber(warning.line) ?? index + 1;
      return [{ line, message, raw }];
    }
    return [];
  });
}

function looksLikeContentLine(line: string): boolean {
  return /^(?<path>.+):(?<line>\d+):(?<text>.*)$/.test(line);
}

function looksLikePathLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (looksLikeContentLine(trimmed)) {
    return false;
  }
  return /[\\/]/.test(trimmed) || trimmed.startsWith(".") || /\.[A-Za-z0-9]+$/.test(trimmed);
}

function parseLineToMatch(line: string): FffContentMatch | FffFileMatch | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const contentMatch = trimmed.match(/^(?<path>.+):(?<line>\d+):(?<text>.*)$/);
  if (contentMatch?.groups) {
    return {
      path: contentMatch.groups.path,
      line: Number(contentMatch.groups.line),
      text: contentMatch.groups.text,
    };
  }
  if (looksLikePathLine(trimmed)) {
    return { path: trimmed };
  }
  return undefined;
}

function normalizeTextResult(text: string): FffNormalizedResult {
  const lines = text.split(/\r?\n/);
  const contentMatches: FffContentMatch[] = [];
  const fileMatches: FffFileMatch[] = [];
  const warnings: FffNormalizationWarning[] = [];
  let sawContent = false;
  let sawFile = false;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const match = parseLineToMatch(trimmed);
    if (match && "line" in match && "text" in match) {
      sawContent = true;
      contentMatches.push(match);
      return;
    }
    if (match) {
      sawFile = true;
      fileMatches.push(match);
      return;
    }
    warnings.push({
      line: index + 1,
      message: "Unable to parse result line",
      raw: trimmed,
    });
  });

  if (sawContent) {
    return { kind: "content", matches: contentMatches, warnings };
  }
  if (sawFile) {
    return { kind: "files", matches: fileMatches, warnings };
  }
  return { kind: "files", matches: fileMatches, warnings };
}

function collectTextContent(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (isRecord(item)) {
        if (typeof item.text === "string") {
          return [item.text];
        }
        if (typeof item.value === "string") {
          return [item.value];
        }
      }
      return [];
    });
  }
  if (isRecord(value)) {
    const pieces: string[] = [];
    if (typeof value.text === "string") {
      pieces.push(value.text);
    }
    if (typeof value.value === "string") {
      pieces.push(value.value);
    }
    if (Array.isArray(value.content)) {
      pieces.push(...collectTextContent(value.content));
    }
    return pieces;
  }
  return [];
}

function normalizeStructuredContent(value: unknown): FffNormalizedResult {
  if (typeof value === "string") {
    return normalizeTextResult(value);
  }
  if (Array.isArray(value)) {
    return normalizeTextResult(value.join("\n"));
  }
  if (!isRecord(value)) {
    return { kind: "files", matches: [], warnings: [] };
  }

  const warnings = normalizeWarnings(value.warnings);
  const kind = typeof value.kind === "string" ? value.kind.toLowerCase() : undefined;

  if (Array.isArray(value.matches)) {
    const contentMatches = value.matches.flatMap((match) => {
      if (!isRecord(match)) {
        return [];
      }
      const path = typeof match.path === "string" ? match.path : undefined;
      const line = normalizeLineNumber(match.line);
      const text = typeof match.text === "string" ? match.text : undefined;
      if (path && line !== undefined && text !== undefined) {
        return [{ path, line, text }];
      }
      return [];
    });

    if (contentMatches.length > 0 || kind === "content" || kind === "grep" || kind === "search") {
      return {
        kind: "content",
        matches: contentMatches,
        warnings,
      };
    }

    const fileMatches = value.matches.flatMap((match) => {
      if (typeof match === "string") {
        return [{ path: match }];
      }
      if (isRecord(match) && typeof match.path === "string") {
        return [{ path: match.path }];
      }
      return [];
    });

    return { kind: "files", matches: fileMatches, warnings };
  }

  if (Array.isArray(value.files)) {
    const fileMatches = value.files.flatMap((match) => {
      if (typeof match === "string") {
        return [{ path: match }];
      }
      if (isRecord(match) && typeof match.path === "string") {
        return [{ path: match.path }];
      }
      return [];
    });

    return { kind: "files", matches: fileMatches, warnings };
  }

  if (Array.isArray(value.items)) {
    const fileMatches = value.items.flatMap((match) => {
      if (typeof match === "string") {
        return [{ path: match }];
      }
      if (isRecord(match) && typeof match.path === "string") {
        return [{ path: match.path }];
      }
      return [];
    });

    return { kind: "files", matches: fileMatches, warnings };
  }

  if (typeof value.text === "string") {
    return normalizeTextResult(value.text);
  }

  return { kind: "files", matches: [], warnings };
}

export function normalizeFffResult(payload: unknown): FffNormalizedResult {
  if (isRecord(payload)) {
    if (payload.structuredContent !== undefined) {
      return normalizeStructuredContent(payload.structuredContent);
    }

    const textFragments = collectTextContent(payload.content);
    if (textFragments.length > 0) {
      return normalizeTextResult(textFragments.join("\n"));
    }

    if (typeof payload.text === "string") {
      return normalizeTextResult(payload.text);
    }

    if (typeof payload.value === "string") {
      return normalizeTextResult(payload.value);
    }

    if (Array.isArray(payload.matches) || Array.isArray(payload.files) || Array.isArray(payload.items)) {
      return normalizeStructuredContent(payload);
    }
  }

  if (typeof payload === "string") {
    return normalizeTextResult(payload);
  }

  return { kind: "files", matches: [], warnings: [] };
}
