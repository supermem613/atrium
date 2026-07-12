import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { introspectTool } from "../core/introspect.js";
import { adoptBackgroundRun, waitForBackgroundRun, withLongRunningDefault } from "../core/backgroundRuns.js";
import { RunExecutableInput, RunExecutableResult, startExecutableRun } from "../core/runner.js";
import { ExecutionQueue } from "../core/executionQueue.js";
import { toolTextResult } from "./format.js";
import { normalizeSearchResult } from "../core/search/normalize.js";
import { readTextFileSlice } from "../core/readFile.js";
import type { SearchClientLike } from "../core/search/types.js";

const defaultSearchTimeoutMs = 59_000;

// Dependencies the surface tool handlers close over. Kept as an explicit object
// so the registry stays a pure function of its inputs with no environment reads.
export interface SurfaceDeps {
  executionOptions: { executionQueue?: ExecutionQueue | false };
  backgroundHandoffAfterMs: number;
  waitTimeoutMs: number;
  searchClient: SearchClientLike;
}

// A single MCP tool. register() erases the per-tool input-schema generic so
// heterogeneous tools can share one registry array while each handler stays
// type-checked at its definition site.
export interface ToolRegistration {
  name: string;
  title: string;
  description: string;
  register: (server: McpServer) => void;
}

// A coarse capability group: the single source of truth binding a set of tools
// to the instruction text that documents them. Composing the advertised
// instructions and choosing which tools to register both read from this model.
export interface Surface {
  name: SurfaceName;
  tools: ToolRegistration[];
  instructionFragment: string;
}

function defineTool<Args extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: Args },
  handler: ToolCallback<Args>,
): ToolRegistration {
  return {
    name,
    title: config.title,
    description: config.description,
    register: (server) => {
      server.registerTool(name, config, handler);
    },
  };
}

interface SearchVerbSpec {
  command: "search" | "files";
  all: boolean;
  kind: "content" | "files";
  title: string;
  description: string;
}

const contentVerbs: Record<"grep" | "grep-code", SearchVerbSpec> = {
  "grep": {
    command: "search", all: true, kind: "content",
    title: "Grep files",
    description: "Unrestricted content search across the filesystem, including hidden, gitignored, and vendor files. Pass a single literal query, or a queries array of one or more patterns. Set regex true to treat patterns as regular expressions. For ignore-aware code search prefer grep-code.",
  },
  "grep-code": {
    command: "search", all: false, kind: "content",
    title: "Grep code",
    description: "Ignore-aware content search that skips hidden, gitignored, and vendor files. Pass a single literal query, or a queries array of one or more patterns. Set regex true to treat patterns as regular expressions. Prefer this first for symbols, APIs, tests, command handlers, error strings, and docs related to code.",
  },
};

const findFilesVerb: SearchVerbSpec = {
  command: "files", all: true, kind: "files",
  title: "Find files",
  description: "List file paths under a root, filtered by glob and exclude. Path discovery only; it never reads file contents. Includes hidden, gitignored, and vendor files. The tool exposes glob but not a type option.",
};

// Escapes regex metacharacters so a literal pattern matches itself when several
// literal patterns are combined into one native-search alternation.
function escapeRegExp(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolves query/queries/regex into one native-search query plus whether native
// search runs in regex mode. A lone literal query stays a plain literal search so
// grep and grep-code keep their prior single-pattern behavior. Multiple literal
// patterns are escaped and joined into an alternation. When regex is set,
// patterns are joined verbatim. Exactly one of query or queries must be present.
function resolveSearchQuery(
  toolName: string,
  query: string | undefined,
  queries: string[] | undefined,
  regex: boolean,
): { query: string; regex: boolean } {
  if ((query === undefined) === (queries === undefined)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for tool ${toolName}: provide exactly one of query or queries.`,
    );
  }
  const patterns = query !== undefined ? [query] : queries as string[];
  if (regex) {
    return { query: patterns.join("|"), regex: true };
  }
  if (patterns.length === 1) {
    return { query: patterns[0], regex: false };
  }
  return { query: patterns.map(escapeRegExp).join("|"), regex: true };
}

async function runWithHandoff(
  input: RunExecutableInput,
  backgroundHandoffAfterMs: number,
  executionOptions: { executionQueue?: ExecutionQueue | false } = {},
): Promise<RunExecutableResult | Awaited<ReturnType<typeof adoptBackgroundRun>>> {
  const running = await startExecutableRun(withLongRunningDefault(input), executionOptions);
  const result = await waitForResultOrTimeout(running.result, backgroundHandoffAfterMs);
  if (result !== undefined) {
    return result;
  }

  return adoptBackgroundRun(running);
}

async function runSearchWithHandoff(
  search: () => Promise<unknown>,
  backgroundHandoffAfterMs: number,
): Promise<unknown> {
  const startedAtMs = Date.now();
  const startedAt = new Date().toISOString();
  const timed = search().then((value) => withTimingMs(value, Date.now() - startedAtMs));
  const completed = await waitForResultOrTimeout(timed, backgroundHandoffAfterMs);
  if (completed !== undefined) {
    return completed;
  }

  return adoptBackgroundRun({ startedAt, result: timed.then((value) => stripPerfMetadata(value)) });
}

// Records the wall-clock duration of the call as a top-level timingMs, matching
// the run surface. Non-object results are returned unchanged.
function withTimingMs<T>(value: T, timingMs: number): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  return { ...(value as Record<string, unknown>), timingMs } as T;
}

async function waitForResultOrTimeout<T>(result: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("timed-out");
  const winner = await Promise.race([
    result,
    new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }

  return winner === timedOut ? undefined : winner;
}

function stripPerfMetadata<T>(value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "perf")) {
    return value;
  }

  const { perf, ...rest } = record;
  void perf;
  return rest as T;
}

function coreTools(deps: SurfaceDeps): ToolRegistration[] {
  return [
    defineTool(
      "schema",
      {
        title: "Describe a CLI invocation shape",
        description: "Discover a CLI invocation shape by running `<tool> schema` and parsing JSON. Falls back to `<tool> --help`. Prefer this over scraping help through powershell.",
        inputSchema: {
          tool: z.string().min(1).describe("Binary name or executable path to describe."),
        },
      },
      async ({ tool }) => toolTextResult(await introspectTool(tool, deps.executionOptions)),
    ),
    defineTool(
      "run",
      {
        title: "Run a CLI or executable",
        description: "Execute named CLIs with structured args and structured JSON returns. Returns the normal result when the command finishes inside the handoff window, otherwise returns a durable operationId and a prescriptive nextCheck instruction telling you to call operation-wait. The child process uses Atrium's fixed server-side execution deadline; callers cannot tune it.",
        inputSchema: {
          tool: z.string().min(1).describe("Binary name on PATH or executable path. Shells such as pwsh, powershell, bash, cmd, sh, and zsh are denied."),
          args: z.array(z.union([z.string(), z.object({ file: z.string().min(1) })])).optional().describe("Argument vector. Use {file} to replace that argument with UTF-8 file contents. Do not pass a shell command string."),
          cwd: z.string().optional().describe("Working directory for the process."),
          stdin: z.union([z.string(), z.object({ file: z.string().min(1) })]).optional().describe("Optional stdin content. Use {file} to read UTF-8 stdin content from a file."),
        },
      },
      async (input) => toolTextResult(await runWithHandoff(input, deps.backgroundHandoffAfterMs, deps.executionOptions)),
    ),
    defineTool(
      "operation-wait",
      {
        title: "Wait for a durable operation",
        description: "Wait briefly for a durable operation handed off by any Atrium tool. Returns the terminal result when complete. If still running after Atrium's fixed request-safe wait window, returns status continue with the same operationId and a nextCheck instruction to call operation-wait again. This does not cancel, shorten, or tune the underlying operation.",
        inputSchema: {
          operationId: z.string().min(1).describe("Durable operationId returned by an Atrium tool handoff."),
        },
      },
      async ({ operationId }) => toolTextResult(await waitForBackgroundRun(operationId, { requestSafeWaitMs: deps.waitTimeoutMs })),
    ),
  ];
}

function readTools(): ToolRegistration[] {
  return [
    defineTool(
      "read",
      {
        title: "Read text file range",
        description: "Read a UTF-8 text file with deterministic line-range clamping. Successful reads return ok, path, range, meta, and content. Large content uses Atrium's {file, bytes} value contract.",
        inputSchema: {
          path: z.string().min(1).describe("File path to read."),
          startLine: z.number().int().positive().optional().describe("First 1-based line to read. Defaults to 1."),
          endLine: z.number().int().positive().optional().describe("Last 1-based line to read. Mutually exclusive with count."),
          count: z.number().int().positive().optional().describe("Maximum number of lines to read. Mutually exclusive with endLine."),
        },
      },
      async (input) => toolTextResult(await readTextFileSlice(input)),
    ),
  ];
}

function searchTools(deps: SurfaceDeps): ToolRegistration[] {
  const runContentSearch = async (spec: SearchVerbSpec, query: string, regex: boolean, root: string, glob?: string, exclude?: string, max?: number) =>
    toolTextResult(await runSearchWithHandoff(
      () => deps.searchClient.run({
        command: spec.command,
        root,
        query,
        ...(regex ? { regex: true } : {}),
        ...(spec.all ? { all: true } : {}),
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
        timeoutMs: defaultSearchTimeoutMs,
      }).then((envelope) => normalizeSearchResult(envelope, spec.kind)),
      deps.backgroundHandoffAfterMs,
    ));

  const tools: ToolRegistration[] = [];
  for (const [toolName, spec] of Object.entries(contentVerbs)) {
    tools.push(defineTool(
      toolName,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: {
          root: z.string().min(1).describe("Root path to search from."),
          query: z.string().min(1).optional().describe("A single search pattern. Provide either query or queries, not both."),
          queries: z.array(z.string().min(1)).min(1).optional().describe("One or more patterns to match any of. Atrium combines them into one alternation. Provide either query or queries, not both."),
          regex: z.boolean().optional().describe("Treat the patterns as regular expressions. Defaults to false, which matches patterns literally."),
          glob: z.string().min(1).optional().describe("Optional glob to constrain the search by path or name."),
          exclude: z.string().min(1).optional().describe("Optional exclude pattern applied as a negated glob."),
          max: z.number().int().positive().optional().describe("Optional maximum number of results to return."),
        },
      },
      async ({ root, query, queries, regex, glob, exclude, max }) => {
        const resolved = resolveSearchQuery(toolName, query, queries, regex ?? false);
        return runContentSearch(spec, resolved.query, resolved.regex, root, glob, exclude, max);
      },
    ));
  }

  tools.push(defineTool(
    "find-files",
    {
      title: findFilesVerb.title,
      description: findFilesVerb.description,
      inputSchema: {
        root: z.string().min(1).describe("Root path to list files from."),
        glob: z.string().min(1).optional().describe("Optional glob to constrain the listing by path or name."),
        exclude: z.string().min(1).optional().describe("Optional exclude pattern applied as a negated glob."),
        max: z.number().int().positive().optional().describe("Optional maximum number of files to return."),
      },
    },
    async ({ root, glob, exclude, max }) => toolTextResult(await runSearchWithHandoff(
      () => deps.searchClient.run({
        command: "files",
        root,
        all: true,
        ...(glob !== undefined ? { glob } : {}),
        ...(exclude !== undefined ? { exclude } : {}),
        ...(max !== undefined ? { max } : {}),
        timeoutMs: defaultSearchTimeoutMs,
      }).then((envelope) => normalizeSearchResult(envelope, "files")),
      deps.backgroundHandoffAfterMs,
    )),
  ));

  return tools;
}

// Always-on cross-cutting contract advertised regardless of enabled surfaces.
// Kept separate from surface fragments so the identity and hard rules never
// disappear when a capability group is disabled.
const instructionPreamble = [
  "Atrium runs named CLIs and executables with structured JSON results. It is not a shell.",
  "",
  "Hard rules, enforced by the server:",
  "1. Shells are denied. Do not pass pwsh, powershell, bash, cmd, sh, or zsh as tool. Call the target binary directly with an args vector. Never pass a single shell command string.",
  "2. There is one execution behavior. Every run and search starts, waits briefly, then returns the result if it finished, otherwise returns a durable operationId. A handoff is not an error.",
].join("\n");

const coreInstructionFragment = [
  "Handoff contract:",
  "- When a tool returns status running with an operationId, it also returns a nextCheck object naming exactly what to call next: the operation-wait tool with that operationId.",
  "- Repeat operation-wait while it returns status continue. Never report success from a still-running handle.",
  "",
  "Value contract:",
  "- A plain string argument or stdin is used literally.",
  "- An object {file: path} is replaced with the UTF-8 contents of that file.",
  "- A tool result is itself either an inline value or an object {file, bytes}; read that file to get the full content when it is too large to inline.",
  "- Use the schema tool to discover a CLI invocation shape instead of scraping help through a shell.",
  "",
  "Tool selection and honesty:",
  "- Prefer this server for running named CLIs and binaries over a separate shell tool. Use a raw shell only for ad-hoc scripting, control flow, pipes, or interactive processes.",
  "- When these tools are exposed, call them directly and never claim a call happened without an actual tool result. Never invent a tool or verb name.",
  "- An object {file: path} used as stdin must point at a file that already exists on disk. Write generated content to disk first, or pass it inline.",
  "- Do not post-process a file-backed tool result through a separate shell. Read it with the read tool, or rerun the producing command with narrower output.",
].join("\n");

// Read-tool contract migrated from the caller's global guidance so the model
// learns the line-range and end-of-file semantics from the server instead of
// external instructions. Empty until this surface is enabled.
const readInstructionFragment = [
  "Read contract:",
  "- The read tool takes a path plus an optional startLine and either endLine or count. Line numbers are 1-based and positive.",
  "- A successful read returns ok, path, range, meta, and content. Treat the returned range together with meta.totalLines as authoritative for end-of-file and clamping instead of guessing bounds.",
  "",
  "Read safety:",
  "- Use the read tool only for exact paths that are known to exist or came from an owning tool's file-value output. Do not use a read as an existence probe.",
  "- Do not treat paths copied from old sessions, deleted worktrees, or guessed names as known to exist. Re-derive the current path first; use find-files to discover it, then read the exact match.",
  "- Exact path existence is not enough for policy-restricted content. Use the approved route for such content instead of reading it directly.",
].join("\n");

const searchInstructionFragment = [
  "Search primitives:",
  "- Content search verbs grep and grep-code use Atrium's native search implementation backed by bundled-ripgrep. find-files lists paths with Atrium's native file engine and never reads contents.",
  "- grep and grep-code take a single literal query or a queries array of one or more patterns to match any of several patterns. Set regex true to treat patterns as regular expressions. grep and find-files are unrestricted and include hidden, gitignored, and vendor files. grep-code is ignore-aware and skips hidden, gitignored, and vendor files.",
  "- Patterns match literally by default. Narrow with glob and exclude, and cap results with max. Results are structured JSON: file matches carry matches[].path, and content matches also carry matches[].line and matches[].text. Surface any normalization warnings.",
  "- These are first-class Atrium MCP tools. Use them for search instead of shelling out.",
].join("\n");

// Ordered so instruction composition reproduces the historical layout: core
// (handoff + value contract) before search (search primitives). read carries no
// advertised text yet; its fragment is filled by the tool-contract enrichment.
export const surfaceOrder = ["core", "read", "search"] as const;
export type SurfaceName = typeof surfaceOrder[number];

// Surfaces that are mandatory. Disabling them is rejected because the handoff
// contract and operation-wait live in core and every other surface depends on it.
export const requiredSurfaces: readonly SurfaceName[] = ["core"];

export function createSurfaces(deps: SurfaceDeps): Surface[] {
  return [
    { name: "core", tools: coreTools(deps), instructionFragment: coreInstructionFragment },
    { name: "read", tools: readTools(), instructionFragment: readInstructionFragment },
    { name: "search", tools: searchTools(deps), instructionFragment: searchInstructionFragment },
  ];
}

// Static tool-name catalog derived from the registry so the CLI tool allowlist
// can never drift from the tools the server actually registers. The stub search
// client is never invoked because tool names are independent of runtime
// dependencies. Only the registration metadata is read here.
const surfaceToolNameCatalog: Record<SurfaceName, readonly string[]> = (() => {
  const catalog = {} as Record<SurfaceName, readonly string[]>;
  for (const surface of createSurfaces({
    executionOptions: {},
    backgroundHandoffAfterMs: 0,
    waitTimeoutMs: 0,
    searchClient: { run: async () => ({ ok: false }) },
  })) {
    catalog[surface.name] = surface.tools.map((tool) => tool.name);
  }
  return catalog;
})();

export interface ResolvedSurfaceSelection {
  surfaces: SurfaceName[];
  toolNames: string[];
  isDefault: boolean;
}

// Single validator and deriver shared by server registration and mcp-config
// generation so both paths agree on which surfaces and tools a selection maps
// to. undefined means the default all-surface server. Registry order is
// preserved so instructions and the tool allowlist stay stable. Unknown names
// and dropping a required surface both throw with an actionable message.
export function resolveSurfaceSelection(selection?: readonly string[]): ResolvedSurfaceSelection {
  const all = [...surfaceOrder];
  if (selection === undefined) {
    return {
      surfaces: all,
      toolNames: all.flatMap((name) => [...surfaceToolNameCatalog[name]]),
      isDefault: true,
    };
  }

  const knownSet = new Set<string>(all);
  for (const name of selection) {
    if (!knownSet.has(name)) {
      throw new Error(`Unknown Atrium surface "${name}". Known surfaces: ${all.join(", ")}.`);
    }
  }
  for (const required of requiredSurfaces) {
    if (!selection.includes(required)) {
      throw new Error(`Atrium surface "${required}" is required and cannot be disabled.`);
    }
  }

  const surfaces = all.filter((name) => selection.includes(name));
  return {
    surfaces,
    toolNames: surfaces.flatMap((name) => [...surfaceToolNameCatalog[name]]),
    isDefault: surfaces.length === all.length,
  };
}

// Shared --surface option description so the CLI, the atrium-mcp entrypoint, and
// the command registry advertise identical text and cannot drift.
export const surfaceOptionDescription =
  "Comma-separated Atrium surfaces to enable (core is required). Repeatable. Defaults to all surfaces.";

// Commander option parser for --surface. Accepts comma-separated lists and
// accumulates across repeated flags. Whitespace is trimmed and empty entries
// are dropped so "core, read" and repeated "--surface core --surface read"
// both resolve to the same selection.
export function parseSurfaceArg(value: string, previous: string[] = []): string[] {
  const additions = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...previous, ...additions];
}

// Filters the registry down to a caller's surface selection. undefined keeps
// every surface so the default server is unchanged. Validation and ordering are
// delegated to resolveSurfaceSelection so the server and mcp-config never
// disagree on what a selection means.
export function selectEnabledSurfaces(all: Surface[], selection?: readonly string[]): Surface[] {
  const { surfaces } = resolveSurfaceSelection(selection);
  const chosen = new Set<string>(surfaces);
  return all.filter((surface) => chosen.has(surface.name));
}

// Composes advertised instructions as the always-on preamble followed by the
// non-empty fragments of the enabled surfaces, joined by blank lines. Pure
// function of the enabled set; no I/O, no environment reads.
export function composeInstructions(surfaces: Surface[]): string {
  const fragments = surfaces
    .map((surface) => surface.instructionFragment)
    .filter((fragment) => fragment.length > 0);
  return [instructionPreamble, ...fragments].join("\n\n");
}

export const instructionPreambleText = instructionPreamble;
