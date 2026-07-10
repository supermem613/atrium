export interface SearchContentMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchFileMatch {
  path: string;
}

export interface SearchInvocationPerfAttributes {
  command: string;
  rootHash?: string;
  queryHash?: string;
  regex: boolean;
  max: number | null;
  globCount: number;
  typeCount: number;
}

export interface SearchNormalizationPerfAttributes {
  kind: "content" | "files";
  matchCount: number;
}

export interface XrayMetricsPerfAttributes {
  elapsedMs?: number;
  filesScanned?: number;
  matchesReturned?: number;
}

export interface SearchPerfMetadata {
  searchInvocation?: SearchInvocationPerfAttributes;
  normalization?: SearchNormalizationPerfAttributes;
  xrayMetrics?: XrayMetricsPerfAttributes;
}

export interface NormalizedContentResult {
  kind: "content";
  matches: SearchContentMatch[];
  warnings: string[];
  perf?: SearchPerfMetadata;
}

export interface NormalizedFilesResult {
  kind: "files";
  matches: SearchFileMatch[];
  warnings: string[];
  perf?: SearchPerfMetadata;
}

export type NormalizedSearchResult = NormalizedContentResult | NormalizedFilesResult;

export interface XrayEnvelopeMatch {
  path?: string;
  line?: number;
  text?: string;
}

export interface XrayEnvelopeSummary {
  matchCount?: number;
  fileCount?: number;
  truncated?: boolean;
  timedOut?: boolean;
}

export interface XrayEnvelope {
  ok: boolean;
  command?: string;
  data?: {
    matches?: XrayEnvelopeMatch[];
    summary?: XrayEnvelopeSummary;
    metrics?: unknown;
  };
  warnings?: string[];
  error?: string;
  hint?: string;
  metrics?: unknown;
}

export interface XrayRunOptions {
  command: "search" | "files";
  root: string;
  query?: string;
  regex?: boolean;
  glob?: string;
  exclude?: string;
  all?: boolean;
  max?: number;
  timeoutMs?: number;
}

export interface XraySearchClientLike {
  run(options: XrayRunOptions): Promise<XrayEnvelope>;
}
