#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";
import {
  mcpFindFilesCommand,
  mcpGrepCodeCommand,
  mcpGrepCommand,
  mcpOperationWaitCommand,
  mcpReadCommand,
  mcpRunCommand,
  mcpSchemaCommand,
  type McpDebugOptions,
  type McpFindFilesOptions,
  type McpGrepCodeOptions,
  type McpGrepOptions,
  type McpReadOptions,
  type McpRunOptions,
} from "./commands/mcpDebug.js";
import { mcpConfigCommand } from "./commands/mcpConfig.js";
import { schemaCommand } from "./commands/schema.js";
import { startAtriumServer } from "./server.js";
import { updateCommand } from "./commands/update.js";

// Read version from package.json so it stays in sync with the published version.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("atrium")
  .description("Agent-friendly MCP wrapper for running CLIs and executables with structured JSON results.")
  .version(VERSION);

program
  .command("doctor")
  .description("Health check: verify environment and configuration")
  .option("--json", "Emit machine-readable JSON instead of human output")
  .action(doctorCommand);

program
  .command("schema [path...]")
  .description("Emit the machine-readable command catalog")
  .option("--summary", "Return only version, command count, and command paths")
  .action((pathArgs: string[] | undefined, opts: { summary?: boolean }) => schemaCommand(pathArgs ?? [], opts, VERSION));

program
  .command("mcp-config")
  .description("Emit MCP config JSON for registering Atrium with Copilot CLI")
  .action(mcpConfigCommand);

program
  .command("mcp-server")
  .description("Start the Atrium stdio MCP server")
  .action(startAtriumServer);

program
  .command("mcp-schema <tool>")
  .description("Debug Atrium MCP by calling the schema tool through a local MCP client")
  .option("--perf", "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses")
  .action((tool: string, options: McpDebugOptions) => mcpSchemaCommand(tool, options));

program
  .command("mcp-run <tool> [args...]")
  .description("Debug Atrium MCP by calling the run tool through a local MCP client")
  .option("--cwd <path>", "Working directory for the command")
  .option("--stdin <text>", "stdin content to pass to the command")
  .option("--stdin-file <path>", "Read stdin content from a UTF-8 file")
  .option("--request-timeout-ms <ms>", "MCP client request timeout in milliseconds. Debug command only")
  .option("--perf", "Emit a CLI-only perf report for the local debug run. Does not change MCP tool responses")
  .action((tool: string, args: string[] | undefined, options: McpRunOptions) => mcpRunCommand(tool, args, options));

program
  .command("mcp-operation-wait <operationId>")
  .description("Wait for a durable operation created by any Atrium MCP tool")
  .option("--perf", "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses")
  .action((operationId: string, options: McpDebugOptions) => mcpOperationWaitCommand(operationId, options));

program
  .command("mcp-read <path>")
  .description("Debug Atrium MCP by calling the read tool through a local MCP client")
  .option("--start-line <line>", "1-based line number to start the read window")
  .option("--end-line <line>", "1-based line number to end the read window")
  .option("--perf", "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses")
  .action((path: string, options: McpReadOptions) => mcpReadCommand(path, options));

program
  .command("mcp-find-files <root>")
  .description("Debug Atrium MCP by calling the find-files tool through a local MCP client")
  .option("--glob <pattern>", "Glob pattern to match files")
  .option("--max <count>", "Maximum number of matches to return")
  .option("--perf", "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses")
  .action((root: string, options: McpFindFilesOptions) => mcpFindFilesCommand(root, options));

program
  .command("mcp-grep <root>")
  .description("Debug Atrium MCP by calling the grep tool through a local MCP client")
  .option("--query <pattern>", "Query string to search for")
  .option("--max <count>", "Maximum number of matches to return")
  .option("--perf", "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses")
  .action((root: string, options: McpGrepOptions) => mcpGrepCommand(root, options));

program
  .command("mcp-grep-code <root>")
  .description("Debug Atrium MCP by calling the grep-code tool through a local MCP client")
  .option("--query <pattern>", "Query string to search for")
  .option("--max <count>", "Maximum number of matches to return")
  .option("--perf", "Emit a CLI-only perf report for the local debug call. Does not change MCP tool responses")
  .action((root: string, options: McpGrepCodeOptions) => mcpGrepCodeCommand(root, options));

program
  .command("update")
  .description("Self-update: git pull, npm install, and rebuild atrium")
  .option("--json", "Emit machine-readable JSON instead of human output")
  .action(updateCommand);

// Bare `atrium` (no args) prints version + full help. Matches the
// rotunda/kash/reflux convention. No version banner before sub-commands
// so machine-parseable output stays clean.
if (process.argv.slice(2).length === 0) {
  process.stdout.write(`atrium v${VERSION}\n\n`);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
