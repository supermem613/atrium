import { z } from "zod";
import { isAbsolute, join } from "node:path";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { introspectTool, type IntrospectToolResult } from "../core/introspect.js";
import { adoptBackgroundRun, waitForBackgroundRun, withLongRunningDefault } from "../core/backgroundRuns.js";
import { RunExecutableInput, RunExecutableResult, startExecutableRun } from "../core/runner.js";
import { ExecutionQueue } from "../core/executionQueue.js";
import { toolTextResult } from "./format.js";
import { SEARCH_POLICY_CONTEXT } from "./searchPolicy.js";
import { normalizeSearchResult } from "../core/search/normalize.js";
import { readTextFileSlice } from "../core/readFile.js";
import { lenientBool, lenientInt, scalarOrArray } from "./lenient.js";
import type { SearchClientLike } from "../core/search/types.js";

const defaultSearchTimeoutMs = 59_000;

export const fileMaxOptionDescription =
  "Native produced-result cap: maximum number of file paths to return. Truncation is reported.";

export const contentMaxOptionDescription =
  "Native produced-result cap: maximum number of matches to return. Truncation is reported.";

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
  inputSchema: z.ZodRawShape;
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

// Registers one tool with a bare object inputSchema. The inputSchema must stay a
// plain ZodRawShape and its fields must never be wrapped in an object-level effect
// such as a z.preprocess or .transform over the whole object. The
// @modelcontextprotocol/sdk advertises tool properties only for a bare ZodObject,
// so an object-level effect makes ListTools emit an empty schema while runtime
// parsing still passes, which hides the loss until a client inspects the schema.
// Apply leniency with the field-level codecs in ./lenient.js instead.
function defineTool<Args extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: Args },
  handler: ToolCallback<Args>,
): ToolRegistration {
  return {
    name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
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
    description: "Unrestricted content search across the filesystem, including hidden, gitignored, and vendor files. Pass query as one pattern string or an array of patterns to match any of. Set regex true to treat patterns as regular expressions. For ignore-aware code search prefer grep-code.",
  },
  "grep-code": {
    command: "search", all: false, kind: "content",
    title: "Grep code",
    description: "Ignore-aware content search that skips hidden, gitignored, and vendor files. Pass query as one pattern string or an array of patterns to match any of. Set regex true to treat patterns as regular expressions. Prefer this first for symbols, APIs, tests, command handlers, error strings, and docs related to code.",
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

interface PatternDefect {
  index: number;
  pattern: string;
  reason: string;
}

// Reports the first array element that no regex dialect can compile. Only
// structural defects are detected, because the native engine is Rust's regex
// crate and a JavaScript RegExp parser would reject valid Rust syntax such as
// the inline flags in (?i)alpha. Balanced delimiters and escapes are invalid
// everywhere, so this stays dialect-independent and never rejects a pattern the
// engine would have accepted.
function findPatternDefect(patterns: readonly string[]): PatternDefect | null {
  for (let index = 0; index < patterns.length; index += 1) {
    const reason = describeStructuralDefect(patterns[index]);
    if (reason !== null) {
      return { index, pattern: patterns[index], reason };
    }
  }
  return null;
}

// Extended mode makes # start a comment, so parentheses inside it are not group
// delimiters. This scanner cannot read flags, so a pattern that may enable
// extended mode is handed to the engine unchecked. That trades a wrong
// rejection for a slower correct error, the only safe direction for a guard.
const mayEnableExtendedMode = /\(\?[a-zA-Z-]*x/;

function describeStructuralDefect(pattern: string): string | null {
  if (mayEnableExtendedMode.test(pattern)) {
    return null;
  }

  let groupDepth = 0;
  let classOpen = false;
  let classContentStart = 0;

  for (let position = 0; position < pattern.length; position += 1) {
    const character = pattern[position];

    if (character === "\\") {
      if (position === pattern.length - 1) {
        return "trailing backslash escapes nothing";
      }
      position += 1;
      continue;
    }

    if (classOpen) {
      // Rust nests one class inside another, while other dialects read this [
      // as a literal. The two readings disagree about which ] closes the outer
      // class, so stop judging the pattern and let the engine decide.
      if (character === "[") {
        return null;
      }
      if (character === "]" && position >= classContentStart) {
        classOpen = false;
      }
      continue;
    }

    if (character === "[") {
      classOpen = true;
      classContentStart = pattern[position + 1] === "^" ? position + 2 : position + 1;
      // A ] in the leading position is a literal in permissive dialects, so it
      // must not be treated as the closing bracket.
      if (pattern[classContentStart] === "]") {
        classContentStart += 1;
      }
      continue;
    }

    if (character === "(") {
      groupDepth += 1;
      continue;
    }

    if (character === ")") {
      if (groupDepth === 0) {
        return "unmatched closing parenthesis";
      }
      groupDepth -= 1;
    }
  }

  if (classOpen) {
    return "unclosed character class";
  }
  if (groupDepth > 0) {
    return "unclosed group";
  }
  return null;
}

// Resolves the query union plus regex into one native-search query and whether
// native search runs in regex mode. A lone literal string stays a plain literal
// search so grep and grep-code keep their single-pattern behavior. An array of
// literal patterns is escaped and joined into one alternation. When regex is set,
// patterns are joined verbatim.
function resolveSearchQuery(
  query: string | string[],
  regex: boolean,
): { query: string; regex: boolean } {
  const patterns = Array.isArray(query) ? query : [query];
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

export interface AtriumVerbDescription {
  name: string;
  title: string;
  description: string;
  parameters: Array<{ name: string; required: boolean; description: string }>;
}

export interface AtriumVerbIntrospection {
  ok: true;
  tool: string;
  timingMs: number;
  source: "atrium";
  data: AtriumVerbDescription;
  // Set when a bare name also named an executable that failed to describe
  // itself. Callers see both readings instead of one being silently dropped.
  executableError?: { code: string; message: string };
}

// Names that address an Atrium verb rather than an executable on PATH. Both the
// hyphenated tool name the host advertises and the dotted server-qualified name
// used in handoff payloads resolve to the same verb.
const atriumVerbPrefixes = ["atrium-", "atrium."] as const;

let cachedVerbCatalog: Map<string, AtriumVerbDescription> | null = null;

// Built lazily from the same registry the server registers, so a verb can never
// describe itself differently from how it is exposed. The stub dependencies are
// never invoked because only registration metadata is read.
function atriumVerbCatalog(): Map<string, AtriumVerbDescription> {
  if (cachedVerbCatalog === null) {
    cachedVerbCatalog = new Map();
    for (const surface of createSurfaces({
      executionOptions: {},
      backgroundHandoffAfterMs: 0,
      waitTimeoutMs: 0,
      searchClient: { run: async () => ({ ok: false }) },
    })) {
      for (const tool of surface.tools) {
        cachedVerbCatalog.set(tool.name, {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          parameters: Object.entries(tool.inputSchema).map(([name, schema]) => ({
            name,
            required: !schema.isOptional(),
            description: schema.description ?? "",
          })),
        });
      }
    }
  }
  return cachedVerbCatalog;
}

function lookupNamespacedVerb(tool: string): AtriumVerbDescription | undefined {
  for (const prefix of atriumVerbPrefixes) {
    if (tool.startsWith(prefix)) {
      return atriumVerbCatalog().get(tool.slice(prefix.length));
    }
  }
  return undefined;
}

export interface DescribeToolDeps {
  introspect?: (tool: string, options: SurfaceDeps["executionOptions"]) => Promise<IntrospectToolResult>;
}

// Describes an Atrium verb or an external executable. A namespaced name is
// answered from the registry without spawning anything. A bare name is spawned
// first so a real binary is never shadowed by a verb that happens to share its
// name. When that spawn fails and a verb shares the name, the answer carries
// the verb and the executable's failure together. Deciding which of the two the
// caller meant would require reimplementing the platform's own executable
// lookup, and every approximation of it can hide a real binary, so nothing is
// discarded and the caller sees both readings.
export async function describeToolOrAtriumVerb(
  tool: string,
  executionOptions: SurfaceDeps["executionOptions"],
  deps: DescribeToolDeps = {},
): Promise<IntrospectToolResult | AtriumVerbIntrospection> {
  const introspect = deps.introspect ?? introspectTool;
  const startedAt = Date.now();
  const namespaced = lookupNamespacedVerb(tool);
  if (namespaced !== undefined) {
    return { ok: true, tool, timingMs: Date.now() - startedAt, source: "atrium", data: namespaced };
  }

  const introspected = await introspect(tool, executionOptions);
  if (introspected.ok) {
    return introspected;
  }

  const bare = atriumVerbCatalog().get(tool);
  if (bare !== undefined) {
    return {
      ok: true,
      tool,
      timingMs: Date.now() - startedAt,
      source: "atrium",
      data: bare,
      executableError: {
        code: introspected.error?.code ?? "IntrospectionFailed",
        message: `${introspected.error?.message ?? "Introspection failed."} This name also matches an Atrium verb, described above. Pass atrium-${tool} to address the verb unambiguously.`,
      },
    };
  }

  const verbNames = [...atriumVerbCatalog().keys()].map((name) => `atrium-${name}`).join(", ");
  return {
    ...introspected,
    error: {
      code: introspected.error?.code ?? "IntrospectionFailed",
      message: `${introspected.error?.message ?? "Introspection failed."} The tool field names an external executable on PATH or an executable path, not an Atrium verb. To describe an Atrium verb instead, pass its namespaced name: ${verbNames}.`,
    },
  };
}

function coreTools(deps: SurfaceDeps): ToolRegistration[] {
  return [
    defineTool(
      "schema",
      {
        title: "Describe a CLI invocation shape",
        description: "Discover a CLI invocation shape by running `<tool> schema` and parsing JSON. Falls back to `<tool> --help`. Also describes Atrium's own verbs when tool names one, such as atrium-grep or atrium.read. Prefer this over scraping help through powershell.",
        inputSchema: {
          tool: z.string().min(1).describe("Binary name or executable path to describe, or an Atrium verb such as atrium-grep, atrium-read, or atrium-run."),
        },
      },
      async ({ tool }) => toolTextResult(await describeToolOrAtriumVerb(tool, deps.executionOptions)),
    ),
    defineTool(
      "run",
      {
        title: "Run a CLI or executable",
        description: "Execute named CLIs with structured args and structured JSON returns. Returns the normal result when the command finishes inside the handoff window, otherwise returns a durable operationId and a prescriptive nextCheck instruction telling you to call operation-wait.",
        inputSchema: {
          tool: z.string().min(1).describe("Binary name on PATH or executable path. Shells such as pwsh, powershell, bash, cmd, sh, and zsh are denied."),
          args: scalarOrArray(z.union([z.string(), z.object({ file: z.string().min(1) })])).optional().describe("Argument vector. Accepts a single value coerced to exactly one argument, never shell-split, or an array of values. Use {file} to replace that argument with UTF-8 file contents. Do not pass a shell command string. Example: \"status\" or [\"status\"]."),
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
        description: "Wait briefly for a durable operation handed off by any Atrium tool. Returns the terminal result when complete. If still running, returns status continue with the same operationId and a nextCheck instruction to call operation-wait again.",
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
        description: "Read a UTF-8 text file with deterministic line-range clamping or byte-range paging. Successful reads always return ok, path, range, meta, content, and nextRead; nextRead is null when there is no continuation. Oversized line-mode results preserve the file-backed artifact in content and return a byte-mode nextRead against content.file with startByte 0, countBytes 8192, and snapshot. The read payload stays inline when it fits the output contract and otherwise uses Atrium's {file, bytes} value contract.",
        inputSchema: {
          path: z.string().min(1).describe("File path to read."),
          startLine: lenientInt({ positive: true }).optional().describe("First 1-based line to read. Accepts an integer or a numeric string. Defaults to 1."),
          endLine: lenientInt({ positive: true }).optional().describe("Last 1-based line to read. Accepts an integer or a numeric string. Mutually exclusive with count."),
          count: lenientInt({ positive: true }).optional().describe("Maximum number of lines to read. Accepts an integer or a numeric string. Mutually exclusive with endLine."),
          startByte: lenientInt({ nonnegative: true }).optional().describe("First byte offset to read for byte-mode paging. Accepts an integer or a numeric string."),
          countBytes: lenientInt({ positive: true }).optional().describe("Maximum number of bytes to read for byte-mode paging. Accepts an integer or a numeric string."),
          snapshot: z.string().optional().describe("Optional snapshot token for stale byte-page continuation rejection."),
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
          query: scalarOrArray(z.string().min(1), { nonEmpty: true }).describe("A search pattern, or an array of patterns to match any of. Accepts a single string or a non-empty array. A string matches literally; an array is combined into one alternation. Set regex true to treat patterns as regular expressions. Example: \"needle\" or [\"alpha\", \"beta\"]."),
          regex: lenientBool.optional().describe("Treat the patterns as regular expressions. Accepts a boolean or the strings \"true\"/\"false\". Defaults to false, which matches patterns literally."),
          path: z.string().min(1).optional().describe("Optional single file to restrict the search to. When set, only this file is searched instead of walking root."),
          glob: z.string().min(1).optional().describe("Optional glob to constrain the search by path or name."),
          exclude: z.string().min(1).optional().describe("Optional exclude pattern applied as a negated glob."),
          max: lenientInt({ positive: true }).optional().describe(`${contentMaxOptionDescription} Accepts an integer or a numeric string. Example: 5 or "5".`),
        },
      },
      async ({ root, query, regex, path, glob, exclude, max }) => {
        const patterns = Array.isArray(query) ? query : [query];
        // Elements are joined into one alternation, so the engine would report a
        // composite pattern the caller never wrote and name no element. Reject
        // first and say which element is at fault.
        if ((regex ?? false) && patterns.length > 1) {
          const defect = findPatternDefect(patterns);
          if (defect !== null) {
            return toolTextResult({
              ok: false,
              error: {
                code: "InvalidPatternElement",
                index: defect.index,
                pattern: defect.pattern,
                message: `Regex pattern at index ${defect.index} of ${patterns.length} is invalid: ${defect.reason}. Atrium joins array elements into one alternation, so the search engine would have reported a composite pattern you never wrote. Fix ${JSON.stringify(defect.pattern)}, or omit regex to match every element literally.`,
              },
            });
          }
        }
        const resolved = resolveSearchQuery(query, regex ?? false);
        const searchRoot = path === undefined ? root : (isAbsolute(path) ? path : join(root, path));
        return runContentSearch(spec, resolved.query, resolved.regex, searchRoot, glob, exclude, max);
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
        max: lenientInt({ positive: true }).optional().describe(`${fileMaxOptionDescription} Accepts an integer or a numeric string. Example: 5 or "5".`),
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
  "",
  "Availability and authority:",
  "- MCP exposure is the authority. When Atrium tools are exposed in the callable tool list, call them directly and do not rediscover them with tool search, extension reload, or auxiliary lookups.",
  "- Atrium tools may be deferred or absent from the initial callable set. Investigate availability only when an actual call is not callable or fails as unavailable. Never treat Atrium as a built-in tool.",
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
  "- The read tool takes a path plus optional startLine/endLine or count for line-mode reads, or startByte/countBytes with an optional snapshot for byte-mode paging. Line numbers are 1-based and positive.",
  "- A successful read returns ok, path, range, meta, content, and nextRead. nextRead is nullable: null means no continuation, otherwise it is the next request to issue.",
  "- If a line-mode selection is oversized, keep the materialized artifact in content and return nextRead targeting content.file with startByte 0, countBytes 8192, and snapshot. Callers follow the continuation in byte mode against the materialized artifact, reconstruct only from page content strings, and stop when nextRead is null.",
  "- Issue a nextRead continuation by passing its path, startByte, countBytes, and snapshot back to this read tool. There is no separate continuation tool, and nextRead does not name one.",
  "- The top-level path/range/meta continue to describe the original source. No input fields are added, and explicit byte-mode semantics remain unchanged.",
  "- Reads stay inline when the payload fits the output contract; otherwise the tool uses Atrium's {file, bytes} value contract.",
  "- Byte paging uses snapshot as a stale-page continuation guard, and the read rejects continuation after a mutation instead of silently returning stale bytes.",
  "",
  "Read safety:",
  "- Use the read tool only for exact paths that are known to exist or came from an owning tool's file-value output. Do not use a read as an existence probe.",
  "- Do not treat paths copied from old sessions, deleted worktrees, or guessed names as known to exist. Re-derive the current path first; use find-files to discover it, then read the exact match.",
  "- Exact path existence is not enough for policy-restricted content. Use the approved route for such content instead of reading it directly.",
  "- This read tool replaces the harness built-in view or file-reading tool. When such a built-in is disabled or unavailable, map every view or Get-Content style read to this read tool instead of retrying the built-in.",
].join("\n");

const searchInstructionFragment = [
  "Search primitives:",
  "- Content search verbs grep and grep-code use Atrium's in-process native search engine. find-files lists paths with Atrium's native file engine and never reads contents.",
  "- grep and grep-code take query as one pattern or an array of patterns to match any of. Set regex true to treat patterns as regular expressions. grep and find-files are unrestricted and include hidden, gitignored, and vendor files. grep-code is ignore-aware and skips hidden, gitignored, and vendor files.",
  "- Patterns match literally by default. Narrow with glob and exclude, and cap results with max. max is the native produced-result cap: the native search stops after producing max matches or paths, truncation is surfaced in warnings, and max does not bound files visited or work for sparse or zero-match searches. Results are structured JSON: file matches carry matches[].path, and content matches also carry matches[].line and matches[].text. Surface any normalization warnings.",
  "- These are first-class Atrium MCP tools. Use them for search instead of shelling out.",
  "",
  "Search safety:",
  "- Always pass a root. Use find-files for path or name discovery, grep-code for git-aware code content search, and grep for unrestricted content search.",
  "- Do not fall back to a separate shell search or a separate glob tool for discovery. These primitives replace shelling out to rg, grep, find, findstr, or Select-String.",
  "- On a timeout, retry narrower: a tighter glob, a more specific query, or a lower max. Lower max is only useful when enough results are already being produced to reach the cap; otherwise narrow the query, glob, or path instead. Never fall back to a raw shell search.",
  "",
  // Reuse the deny path's constant so the explicit blocked-tool to primitive
  // mapping reaches the model at load time, not only after a raw search is
  // denied. Sharing one source keeps the load-time and deny-time text from
  // drifting, and gating it inside this search fragment drops it whenever the
  // search surface is disabled.
  SEARCH_POLICY_CONTEXT,
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
