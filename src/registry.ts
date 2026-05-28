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
      flags: [],
    },
    output: {
      documented: true,
      schema: "AtriumMcpSchemaResult",
    },
    examples: ["mcp-schema xray"],
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
          name: "--timeout-ms",
          type: "number",
          summary: "Execution timeout in milliseconds.",
        },
      ],
    },
    output: {
      documented: true,
      schema: "AtriumRunResultV2",
    },
    examples: ["mcp-run node -- --version", "mcp-run xray -- search tdd --root C:\\Users\\marcusm\\.copilot --glob skills/**"],
  },
  {
    path: ["mcp-run-status"],
    summary: "Inspect a background MCP run by run id.",
    effect: "read",
    input: {
      positionals: ["runId"],
      flags: [],
    },
    output: {
      documented: true,
      schema: "AtriumBackgroundRunSnapshot",
    },
    examples: ["mcp-run-status 00000000-0000-0000-0000-000000000000"],
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
