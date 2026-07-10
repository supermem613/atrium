export type CommandEffect = "read" | "write" | "network" | "local";

export type FlagType = "boolean" | "string" | "number";

export interface FlagSpec {
  name: string;
  type: FlagType;
  summary: string;
  default?: boolean | string | number;
}

export interface CommandSpec {
  path: string[];
  summary: string;
  effect: CommandEffect;
  input: {
    positionals: string[];
    flags: FlagSpec[];
  };
  output: {
    documented: boolean;
    schema?: string;
  };
  examples: string[];
}

export const commandSpecs: CommandSpec[] = [
  {
    path: ["doctor"],
    summary: "Verify environment and configuration.",
    effect: "read",
    input: {
      positionals: [],
      flags: [
        {
          name: "--json",
          type: "boolean",
          summary: "Emit machine-readable JSON instead of human output.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "HealthCheckResult[]",
    },
    examples: ["doctor --json"],
  },
  {
    path: ["schema"],
    summary: "Emit the machine-readable command catalog.",
    effect: "read",
    input: {
      positionals: ["path"],
      flags: [
        {
          name: "--summary",
          type: "boolean",
          summary: "Return only version, command count, and command paths.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "CommandCatalog",
    },
    examples: ["schema", "schema doctor --summary"],
  },
  {
    path: ["mcp-config"],
    summary: "Emit MCP config JSON for registering linked Atrium with Copilot CLI.",
    effect: "read",
    input: {
      positionals: [],
      flags: [],
    },
    output: {
      documented: true,
      schema: "McpConfig",
    },
    examples: ["mcp-config"],
  },
  {
    path: ["mcp-server"],
    summary: "Start the Atrium stdio MCP server.",
    effect: "local",
    input: {
      positionals: [],
      flags: [],
    },
    output: {
      documented: false,
      schema: "MCP stdio transport",
    },
    examples: ["mcp-server"],
  },
  {
    path: ["mcp-schema"],
    summary: "Call Atrium's MCP schema tool through a local MCP client.",
    effect: "read",
    input: {
      positionals: ["tool"],
      flags: [
        {
          name: "--perf",
          type: "boolean",
          summary: "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumMcpSchemaResult",
    },
    examples: ["mcp-schema node", "mcp-schema node --perf"],
  },
  {
    path: ["mcp-run"],
    summary: "Call Atrium's MCP run tool through a local MCP client.",
    effect: "local",
    input: {
      positionals: ["tool", "args"],
      flags: [
        {
          name: "--cwd",
          type: "string",
          summary: "Working directory for the command.",
        },
        {
          name: "--stdin",
          type: "string",
          summary: "stdin content to pass to the command.",
        },
        {
          name: "--stdin-file",
          type: "string",
          summary: "Read stdin content from a UTF-8 file.",
        },
        {
          name: "--perf",
          type: "boolean",
          summary: "Emit a CLI-only perf report for the local debug run. Does not change MCP tool responses.",
        },
        {
          name: "--request-timeout-ms",
          type: "number",
          summary: "MCP client request timeout in milliseconds for the local debug client.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumRunResultV2",
    },
    examples: ["mcp-run node -- --version", "mcp-run node -- -e \"setTimeout(() => console.log('done'), 90000)\""],
  },
  {
    path: ["mcp-operation-wait"],
    summary: "Wait for a durable MCP operation by operation id.",
    effect: "read",
    input: {
      positionals: ["operationId"],
      flags: [
        {
          name: "--perf",
          type: "boolean",
          summary: "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumOperationWaitResult",
    },
    examples: ["mcp-operation-wait atrium-mabc1234-00000000-0000-0000-0000-000000000000", "mcp-operation-wait atrium-mabc1234-00000000-0000-0000-0000-000000000000 --perf"],
  },
  {
    path: ["mcp-read"],
    summary: "Call Atrium's MCP read tool through a local MCP client.",
    effect: "read",
    input: {
      positionals: ["path"],
      flags: [
        {
          name: "--start-line",
          type: "number",
          summary: "1-based line number to start the read window.",
        },
        {
          name: "--end-line",
          type: "number",
          summary: "1-based line number to end the read window.",
        },
        {
          name: "--perf",
          type: "boolean",
          summary: "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumReadResult",
    },
    examples: ["mcp-read /tmp/file.txt --start-line 2 --end-line 3", "mcp-read /tmp/file.txt --perf"],
  },
  {
    path: ["mcp-find-files"],
    summary: "Call Atrium's MCP find-files tool through a local MCP client.",
    effect: "read",
    input: {
      positionals: ["root"],
      flags: [
        {
          name: "--glob",
          type: "string",
          summary: "Glob pattern to match files.",
        },
        {
          name: "--max",
          type: "number",
          summary: "Maximum number of matches to return.",
        },
        {
          name: "--perf",
          type: "boolean",
          summary: "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumFindFilesResult",
    },
    examples: ["mcp-find-files /tmp --glob \"**/*.txt\" --max 5", "mcp-find-files /tmp --perf"],
  },
  {
    path: ["mcp-grep"],
    summary: "Call Atrium's MCP grep tool through a local MCP client.",
    effect: "read",
    input: {
      positionals: ["root"],
      flags: [
        {
          name: "--query",
          type: "string",
          summary: "Query string to search for.",
        },
        {
          name: "--max",
          type: "number",
          summary: "Maximum number of matches to return.",
        },
        {
          name: "--perf",
          type: "boolean",
          summary: "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumGrepResult",
    },
    examples: ["mcp-grep /tmp --query alpha --max 5", "mcp-grep /tmp --perf"],
  },
  {
    path: ["mcp-grep-code"],
    summary: "Call Atrium's MCP grep-code tool through a local MCP client.",
    effect: "read",
    input: {
      positionals: ["root"],
      flags: [
        {
          name: "--query",
          type: "string",
          summary: "Query string to search for.",
        },
        {
          name: "--max",
          type: "number",
          summary: "Maximum number of matches to return.",
        },
        {
          name: "--perf",
          type: "boolean",
          summary: "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumGrepCodeResult",
    },
    examples: ["mcp-grep-code /tmp --query alpha --max 5", "mcp-grep-code /tmp --perf"],
  },
  {
    path: ["update"],
    summary: "Self-update this atrium checkout with git pull, npm install, and rebuild.",
    effect: "write",
    input: {
      positionals: [],
      flags: [
        {
          name: "--json",
          type: "boolean",
          summary: "Emit machine-readable JSON instead of human output.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "UpdateResult",
    },
    examples: ["update --json"],
  },
];

function pathMatchesPrefix(path: string[], prefix: string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

export function buildSchema(cliVersion: string, pathPrefix: string[] = [], summary = false) {
  const commands = commandSpecs.filter((command) => pathMatchesPrefix(command.path, pathPrefix));
  if (summary) {
    return {
      schemaVersion: 1,
      cliVersion,
      commandCount: commands.length,
      commandPaths: commands.map((command) => command.path),
    };
  }

  return {
    schemaVersion: 1,
    cliVersion,
    envelope: {
      stdout: "JSON only for non-interactive commands when --json or schema is used",
      stderr: "progress, diagnostics, and human narration",
      successEnvelope: ["ok", "command", "data", "warnings"],
      errorEnvelope: ["ok", "command", "error", "hint"],
    },
    globalFlags: [
      {
        name: "--help",
        type: "boolean",
        summary: "Show command help.",
      },
      {
        name: "--version",
        type: "boolean",
        summary: "Show CLI version.",
      },
    ],
    commands,
    errorCodes: [],
    exitCodes: [
      {
        code: 0,
        meaning: "Success.",
      },
      {
        code: 1,
        meaning: "Command failed.",
      },
    ],
  };
}
