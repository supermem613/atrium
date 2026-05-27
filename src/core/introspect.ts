import { runExecutable, RunExecutableResult } from "./runner.js";

export interface IntrospectToolResult {
  ok: boolean;
  tool: string;
  source: "schema" | "help" | "none";
  data?: unknown;
  text?: string;
  artifacts?: RunExecutableResult["artifacts"];
  error?: {
    code: string;
    message: string;
  };
}

const introspectionPreviewBytes = 12_000;
const introspectionTimeoutMs = 30_000;
const helpInlineBytes = 4_000;

export async function introspectTool(tool: string): Promise<IntrospectToolResult> {
  const schemaResult = await runExecutable({
    tool,
    args: ["schema"],
    timeoutMs: introspectionTimeoutMs,
    maxPreviewBytes: introspectionPreviewBytes,
  });

  if (schemaResult.ok && schemaResult.stdoutPreview !== undefined) {
    const parsed = tryParseJson(schemaResult.stdoutPreview);
    if (parsed.ok) {
      return {
        ok: true,
        tool,
        source: "schema",
        data: parsed.value,
        artifacts: schemaResult.artifacts,
      };
    }
  }

  const helpResult = await runExecutable({
    tool,
    args: ["--help"],
    timeoutMs: introspectionTimeoutMs,
    maxPreviewBytes: introspectionPreviewBytes,
  });

  if (helpResult.ok && helpResult.stdoutPreview !== undefined) {
    return {
      ok: true,
      tool,
      source: "help",
      text: trimHelp(helpResult.stdoutPreview),
      artifacts: helpResult.artifacts,
    };
  }

  return {
    ok: false,
    tool,
    source: "none",
    error: helpResult.error ?? schemaResult.error ?? {
      code: "IntrospectionFailed",
      message: "Tool did not return JSON from `schema` or help from `--help`.",
    },
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return {
      ok: true,
      value: JSON.parse(text),
    };
  } catch {
    return {
      ok: false,
    };
  }
}

function trimHelp(helpText: string): string {
  if (Buffer.byteLength(helpText, "utf8") <= helpInlineBytes) {
    return helpText;
  }

  return `${helpText.slice(0, helpInlineBytes)}\n[help truncated. Full output is in artifacts.stdoutPath]`;
}
