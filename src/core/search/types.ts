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

export interface RipgrepMetricsPerfAttributes {
  searches?: number;
  bytesSearched?: number;
  bytesPrinted?: number;
  matchedLines?: number;
  matches?: number;
  spawnCallMs?: number;
  spawnReadyMs?: number;
  childRunMs?: number;
  childTotalMs?: number;
  parseMs?: number;
}

export interface SearchPerfMetadata {
  searchInvocation?: SearchInvocationPerfAttributes;
  normalization?: SearchNormalizationPerfAttributes;
  xrayMetrics?: XrayMetricsPerfAttributes;
  ripgrepMetrics?: RipgrepMetricsPerfAttributes;
}

export interface NormalizedContentResult {
  kind: "content";
  matches: SearchContentMatch[];
  warnings: string[];
  timingMs?: number;
  perf?: SearchPerfMetadata;
}

export interface NormalizedFilesResult {
  kind: "files";
  matches: SearchFileMatch[];
  warnings: string[];
  timingMs?: number;
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

export interface NativeSearchEnvelopeMatch {
  path?: string;
  line?: number;
  text?: string;
}

export interface NativeSearchEnvelopeSummary {
  matchCount?: number;
  fileCount?: number;
  truncated?: boolean;
  timedOut?: boolean;
}

export interface NativeSearchEnvelope {
  ok: boolean;
  command?: "search" | "files";
  kind?: "content" | "files";
  data?: {
    matches?: NativeSearchEnvelopeMatch[];
    summary?: NativeSearchEnvelopeSummary;
    metrics?: unknown;
  };
  warnings?: string[];
  error?: string;
  hint?: string;
  metrics?: {
    ripgrepMetrics?: RipgrepMetricsPerfAttributes;
  } | unknown;
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

export interface SearchClientLike {
  run(options: XrayRunOptions | NativeSearchRunOptions): Promise<XrayEnvelope | NativeSearchEnvelope>;
}

export interface NativeSearchRunOptions {
  command: "search" | "files";
  root: string;
  query?: string;
  regex?: boolean;
  glob?: string;
  exclude?: string;
  all?: boolean;
  max?: number;
  timeoutMs?: number;
  perf?: boolean;
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
  spawnCallMs?: number;
  spawnReadyMs?: number;
  childRunMs?: number;
  childTotalMs?: number;
  parseMs?: number;
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
  metrics?: ContentSearchRunMetrics;
}

export interface NativeFileSearchRunner {
  (args: string[], options: { cwd: string; timeoutMs: number; max: number; perf: boolean }): Promise<NativeFileSearchInvocation>;
}

export interface NativeFileSearchOptions {
  root: string;
  max?: number;
  timeoutMs?: number;
  globs?: string[];
  excludes?: string[];
  all?: boolean;
  perf?: boolean;
  runner?: NativeFileSearchRunner;
}

export interface NativeFileSearchResult {
  kind: "files";
  matches: SearchFileMatch[];
  warnings: string[];
  perf?: SearchPerfMetadata;
  metrics?: ContentSearchRunMetrics;
}

export interface ContentSearchOptions {
  query: string;
  root: string;
  regex?: boolean;
  max?: number;
  timeoutMs?: number;
  all?: boolean;
  globs?: string[];
  excludes?: string[];
  perf?: boolean;
  runner?: ContentSearchRunner;
}

export type ContentSearchRunner = (args: string[], options: { cwd: string; timeoutMs: number; query: string; regex: boolean; perf: boolean }) => Promise<ContentSearchInvocation>;

export interface ContentSearchResult {
  kind: "content";
  matches: SearchContentMatch[];
  warnings: string[];
  metrics?: ContentSearchRunMetrics;
  perf?: SearchPerfMetadata;
}
