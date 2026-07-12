import { readFile } from "node:fs/promises";
import { FileRef } from "./artifacts.js";
import { runExecutable, RunExecutableResult, StartExecutableRunOptions } from "./runner.js";

export interface IntrospectToolResult {
  ok: boolean;
  tool: string;
  timingMs: number;
  source: "schema" | "help" | "none";
  data?: unknown;
  text?: string;
  stdout?: RunExecutableResult["stdout"];
  stderr?: RunExecutableResult["stderr"];
  error?: {
    code: string;
    message: string;
  };
}

const introspectionTimeoutMs = 30_000;
const helpInlineBytes = 4_000;

export async function introspectTool(tool: string, options: StartExecutableRunOptions = {}): Promise<IntrospectToolResult> {
  const startedAt = Date.now();
  const schemaResult = await runExecutable({
    tool,
    args: ["schema"],
    timeoutMs: introspectionTimeoutMs,
  }, options);

  const schemaText = await readOutputText(schemaResult.stdout);
  if (schemaResult.ok && schemaText !== undefined) {
    const parsed = tryParseJson(schemaText);
    if (parsed.ok) {
      return {
        ok: true,
        tool,
        timingMs: Date.now() - startedAt,
        source: "schema",
        data: parsed.value,
        stdout: schemaResult.stdout,
        stderr: schemaResult.stderr,
      };
    }
  }

  const helpResult = await runExecutable({
    tool,
    args: ["--help"],
    timeoutMs: introspectionTimeoutMs,
  }, options);

  const helpText = await readOutputText(helpResult.stdout);
  if (helpResult.ok && helpText !== undefined) {
    return {
      ok: true,
      tool,
      timingMs: Date.now() - startedAt,
      source: "help",
      text: trimHelp(helpText),
      stdout: helpResult.stdout,
      stderr: helpResult.stderr,
    };
  }

  return {
    ok: false,
    tool,
    timingMs: Date.now() - startedAt,
    source: "none",
    error: helpResult.error ?? schemaResult.error ?? {
      code: "IntrospectionFailed",
      message: "Tool did not return JSON from `schema` or help from `--help`.",
    },
  };
}

async function readOutputText(output: RunExecutableResult["stdout"]): Promise<string | undefined> {
  if (output === undefined) {
    return undefined;
  }

  if (typeof output === "string") {
    return output;
  }

  return readFile((output as FileRef).file, "utf8");
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

  return `${helpText.slice(0, helpInlineBytes)}\n[help truncated. Full output is in stdout.file]`;
}
