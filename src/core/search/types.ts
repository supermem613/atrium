export interface SearchContentMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchFileMatch {
  path: string;
}

export interface NormalizedContentResult {
  kind: "content";
  matches: SearchContentMatch[];
  warnings: string[];
}

export interface NormalizedFilesResult {
  kind: "files";
  matches: SearchFileMatch[];
  warnings: string[];
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
