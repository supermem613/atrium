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

export type SmartPlanStrategy = "sequential" | "narrowed" | "fanout";
export type SmartPlanLaneName = "markdown" | "code" | "everything";

export interface SmartPlanLane {
  name: SmartPlanLaneName;
  args: string[];
}

export interface SmartPlan {
  strategy: SmartPlanStrategy;
  reason: string;
  lanes: SmartPlanLane[];
  fallbackOnZero: boolean;
  fixedString: boolean;
}

export interface SmartPlanOptions {
  query: string;
  regex?: boolean;
}

export interface ContentSearchRunMetrics {
  searches?: number;
  bytesSearched?: number;
  bytesPrinted?: number;
  matchedLines?: number;
  matches?: number;
}

export interface ContentSearchInvocation {
  args: string[];
  matches: SearchContentMatch[];
  warnings?: string[];
  timedOut?: boolean;
  truncated?: boolean;
  metrics?: ContentSearchRunMetrics;
}

export interface NativeFileSearchInvocation {
  paths: string[];
  warnings?: string[];
  timedOut?: boolean;
  truncated?: boolean;
}

export interface NativeFileSearchRunner {
  (args: string[], options: { cwd: string; timeoutMs: number; max: number }): Promise<NativeFileSearchInvocation>;
}

export interface NativeFileSearchOptions {
  root: string;
  max?: number;
  timeoutMs?: number;
  globs?: string[];
  excludes?: string[];
  all?: boolean;
  runner?: NativeFileSearchRunner;
}

export interface NativeFileSearchResult {
  kind: "files";
  matches: SearchFileMatch[];
  warnings: string[];
  perf?: SearchPerfMetadata;
}

export interface ContentSearchOptions {
  query: string;
  root: string;
  regex?: boolean;
  max?: number;
  timeoutMs?: number;
  excludes?: string[];
  runner?: ContentSearchRunner;
}

export type ContentSearchRunner = (args: string[], options: { cwd: string; timeoutMs: number; query: string; regex: boolean }) => Promise<ContentSearchInvocation>;

export interface ContentSearchResult {
  kind: "content";
  matches: SearchContentMatch[];
  warnings: string[];
  metrics?: ContentSearchRunMetrics;
  perf?: SearchPerfMetadata;
}
