import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { SearchContentMatch } from "./types.js";

export interface NativeContentTypeDef {
  name: string;
  glob: string;
}

export interface NativeContentSearchOptions {
  root: string;
  query: string;
  regex?: boolean;
  all?: boolean;
  globs?: string[];
  excludes?: string[];
  typeDefs?: NativeContentTypeDef[];
  typeSelect?: string[];
  typeNegate?: string[];
  max?: number;
  timeoutMs?: number;
  perf?: boolean;
}

export interface NativeFilesSearchOptions {
  root: string;
  all?: boolean;
  globs?: string[];
  excludes?: string[];
  max?: number;
  timeoutMs?: number;
  perf?: boolean;
  rootIsFile?: boolean;
  rootName?: string;
}

export interface NativeSearchMetrics {
  searches?: number;
  childRunMs?: number;
}

export interface NativeContentResult {
  matches: SearchContentMatch[];
  truncated: boolean;
  timedOut: boolean;
  metrics?: NativeSearchMetrics;
}

export interface NativeFilesResult {
  paths: string[];
  truncated: boolean;
  timedOut: boolean;
  metrics?: NativeSearchMetrics;
}

export interface NativeSearchAddon {
  searchContent(options: NativeContentSearchOptions): Promise<NativeContentResult>;
  searchFiles(options: NativeFilesSearchOptions): Promise<NativeFilesResult>;
}

type RequireLike = (id: string) => unknown;

const nativeRequire = createRequire(import.meta.url);

// The crate lives at <repoRoot>/crates/atrium-search. Both the tsx source
// path (src/core/search) and the compiled path (dist/core/search) sit three
// directories below the repo root, so this relative resolve is stable in
// dev, test, and packaged runs.
function defaultAddonDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "crates", "atrium-search");
}

// napi's `--platform` build names each binary with its target triple so
// per-platform prebuilts can coexist. Resolve the candidates for the current
// host and try each until one loads.
function candidateBinaryNames(): string[] {
  const { platform, arch } = process;
  if (platform === "win32") {
    if (arch === "x64") {
      return ["index.win32-x64-msvc.node"];
    }
    if (arch === "arm64") {
      return ["index.win32-arm64-msvc.node"];
    }
    if (arch === "ia32") {
      return ["index.win32-ia32-msvc.node"];
    }
  }
  if (platform === "darwin") {
    if (arch === "arm64") {
      return ["index.darwin-arm64.node"];
    }
    if (arch === "x64") {
      return ["index.darwin-x64.node"];
    }
  }
  if (platform === "linux") {
    if (arch === "x64") {
      return ["index.linux-x64-gnu.node", "index.linux-x64-musl.node"];
    }
    if (arch === "arm64") {
      return ["index.linux-arm64-gnu.node", "index.linux-arm64-musl.node"];
    }
    if (arch === "arm") {
      return ["index.linux-arm-gnueabihf.node"];
    }
  }
  return [];
}

function isNativeSearchAddon(value: unknown): value is NativeSearchAddon {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NativeSearchAddon).searchContent === "function" &&
    typeof (value as NativeSearchAddon).searchFiles === "function"
  );
}

export interface LoadNativeSearchAddonDeps {
  requireFn?: RequireLike;
  addonDir?: string;
  candidates?: string[];
}

export function loadNativeSearchAddonWith(deps: LoadNativeSearchAddonDeps = {}): NativeSearchAddon | null {
  const requireFn = deps.requireFn ?? ((id: string) => nativeRequire(id));
  const addonDir = deps.addonDir ?? defaultAddonDir();
  const candidates = deps.candidates ?? candidateBinaryNames();

  for (const name of candidates) {
    try {
      const loaded = requireFn(resolve(addonDir, name));
      if (isNativeSearchAddon(loaded)) {
        return loaded;
      }
    } catch {
      // Missing or unloadable prebuilt for this candidate; try the next, then
      // fall back to null so callers can spawn bundled ripgrep instead.
    }
  }
  return null;
}

let cached: NativeSearchAddon | null | undefined;

export function loadNativeSearchAddon(): NativeSearchAddon | null {
  if (cached === undefined) {
    cached = loadNativeSearchAddonWith();
  }
  return cached;
}
