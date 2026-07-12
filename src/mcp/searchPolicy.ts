// Search-policy enforcement, ported from the standalone
// ~/.copilot/extensions/search-policy extension so the Atrium extension owns
// both advertising and enforcing the search primitives. The deny decisions are
// gated on the search surface by the caller. When that surface is disabled
// Atrium exposes no search primitives, so blocking raw search would leave the
// model with no way to search at all.

export const SEARCH_POLICY_CONTEXT = [
  "Search-policy is active.",
  "Do not call direct search commands or tools: rg, ripgrep, grep, git grep, xray, find, findstr, or Select-String.",
  "Use the Atrium MCP search primitives instead: atrium-find-files for path or name discovery, atrium-grep for a single content query, and atrium-grep-code for git-aware code search. Pass one query or a queries array.",
  "These Atrium primitives are deferred MCP tools. If atrium-find-files, atrium-grep, or atrium-grep-code is not in your immediately callable tool list, call the tool search tool first (for example with the pattern find-files|grep) to surface them, then call them. Do not abandon the search or read files blindly because a primitive looks unavailable.",
  "Always pass root and a query; narrow with glob, exclude, and max. Do not pass caller timeout knobs to search primitives.",
  "If a search times out, retry with a narrower glob, a more specific query, or a lower max.",
  "Do not fall back to raw search commands.",
].join(" ");

const RAW_SEARCH_TOOLS = new Set(["rg", "grep", "ripgrep"]);
const ATRIUM_ONLY_TOOLS = new Set(["xray", "find", "findstr"]);
const SHELL_SEARCH_PATTERN =
  /(?:^|[;&|()]\s*)(?:git\s+grep|rg|ripgrep|grep|find|findstr|xray|Select-String)(?:\s|$)/i;
const SHELL_SEARCH_TOKEN_PATTERN =
  /\b(?:git\s+grep|rg|ripgrep|grep|find|findstr|xray|Select-String)\b/i;

export interface ToolUseInput {
  toolName?: unknown;
  toolArgs?: unknown;
}

export interface PermissionRequestInput {
  kind?: unknown;
  fullCommandText?: unknown;
  toolName?: unknown;
  serverName?: unknown;
  args?: unknown;
}

export function repairMessage(attempt: string): string {
  const blocked = attempt
    ? `Search-policy blocked ${attempt}.`
    : "Search-policy blocked a raw search attempt.";
  return [blocked, SEARCH_POLICY_CONTEXT, "Retry using atrium-grep / atrium-find-files now."].join(" ");
}

function getBaseToolName(toolName: unknown): string {
  return String(toolName).toLowerCase().split(".").at(-1) ?? "";
}

function isAtriumRunToolName(toolName: unknown): boolean {
  const normalized = String(toolName).toLowerCase();
  return normalized === "atrium.run"
    || normalized.endsWith(".atrium.run")
    || getBaseToolName(normalized) === "atrium-run";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringProperty(value: unknown, propertyName: string): string {
  if (!isObject(value)) {
    return "";
  }
  const property = value[propertyName];
  return typeof property === "string" ? property : "";
}

function backtick(value: unknown): string {
  return `\`${String(value).replaceAll("`", "")}\``;
}

function findBlockedSearchToken(command: unknown): string {
  const match = String(command ?? "").match(SHELL_SEARCH_TOKEN_PATTERN);
  return match ? match[0].replace(/\s+/g, " ") : "";
}

function isDirectlyBlockedTool(toolName: unknown): boolean {
  const base = getBaseToolName(toolName);
  return RAW_SEARCH_TOOLS.has(base) || ATRIUM_ONLY_TOOLS.has(base);
}

function isBlockedAtriumRawSearch(input: ToolUseInput): boolean {
  if (!isAtriumRunToolName(input.toolName)) {
    return false;
  }
  const tool = getStringProperty(input.toolArgs, "tool");
  return RAW_SEARCH_TOOLS.has(tool.toLowerCase());
}

function isBlockedShellSearch(input: ToolUseInput): boolean {
  const toolName = getBaseToolName(input.toolName);
  if (toolName !== "powershell" && toolName !== "bash") {
    return false;
  }
  const command = getStringProperty(input.toolArgs, "command");
  return SHELL_SEARCH_PATTERN.test(command);
}

export function isBlockedShellPermission(request: PermissionRequestInput): boolean {
  if (request.kind !== "shell") {
    return false;
  }
  return SHELL_SEARCH_PATTERN.test(String(request.fullCommandText ?? ""));
}

export function isBlockedMcpPermission(request: PermissionRequestInput): boolean {
  if (request.kind !== "mcp") {
    return false;
  }
  if (isDirectlyBlockedTool(request.toolName)) {
    return true;
  }
  if (request.serverName !== "atrium") {
    return false;
  }
  const tool = getStringProperty(request.args, "tool");
  return RAW_SEARCH_TOOLS.has(tool.toLowerCase());
}

export function isBlockedSearch(input: ToolUseInput): boolean {
  if (isDirectlyBlockedTool(input.toolName)) {
    return true;
  }
  if (isBlockedAtriumRawSearch(input)) {
    return true;
  }
  return isBlockedShellSearch(input);
}

export function describeBlockedInput(input: ToolUseInput): string {
  if (isDirectlyBlockedTool(input.toolName)) {
    return `direct ${backtick(input.toolName)} tool use`;
  }
  if (isBlockedAtriumRawSearch(input)) {
    return `Atrium raw ${backtick(getStringProperty(input.toolArgs, "tool"))} tool use`;
  }
  if (isBlockedShellSearch(input)) {
    const token = findBlockedSearchToken(getStringProperty(input.toolArgs, "command"));
    const toolName = getBaseToolName(input.toolName);
    return `${backtick(toolName)} command${token ? ` containing ${backtick(token)}` : ""}`;
  }
  return "";
}

export function describeBlockedPermission(request: PermissionRequestInput): string {
  if (request.kind === "shell") {
    const token = findBlockedSearchToken(request.fullCommandText);
    return `shell command${token ? ` containing ${backtick(token)}` : ""}`;
  }
  if (request.kind !== "mcp") {
    return "";
  }
  if (isDirectlyBlockedTool(request.toolName)) {
    return `direct MCP ${backtick(request.toolName)} tool use`;
  }
  if (request.serverName === "atrium") {
    const tool = getStringProperty(request.args, "tool");
    if (RAW_SEARCH_TOOLS.has(tool.toLowerCase())) {
      return `Atrium raw ${backtick(tool)} tool use`;
    }
  }
  return "";
}

export interface PreToolUseDenyDecision {
  permissionDecision: "deny";
  permissionDecisionReason: string;
  additionalContext: string;
}

// Surface-gated pre-tool-use decision. Returns undefined when the search surface
// is disabled so a stripped-down Atrium never blocks a search it cannot itself
// perform.
export function evaluatePreToolUse(
  input: ToolUseInput,
  searchEnabled: boolean,
): PreToolUseDenyDecision | undefined {
  if (!searchEnabled) {
    return undefined;
  }
  if (!isBlockedSearch(input)) {
    return undefined;
  }
  return {
    permissionDecision: "deny",
    permissionDecisionReason: repairMessage(describeBlockedInput(input)),
    additionalContext: SEARCH_POLICY_CONTEXT,
  };
}

export type PermissionEvaluation = { kind: "no-result" } | { kind: "reject"; feedback: string };

// Surface-gated permission decision mirroring evaluatePreToolUse.
export function evaluatePermissionRequest(
  request: PermissionRequestInput,
  searchEnabled: boolean,
): PermissionEvaluation {
  if (!searchEnabled) {
    return { kind: "no-result" };
  }
  if (!isBlockedShellPermission(request) && !isBlockedMcpPermission(request)) {
    return { kind: "no-result" };
  }
  return { kind: "reject", feedback: repairMessage(describeBlockedPermission(request)) };
}
