#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";
import { mcpOperationWaitCommand, mcpRunCommand, mcpSchemaCommand } from "./commands/mcpDebug.js";
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
  .action(mcpSchemaCommand);

program
  .command("mcp-run <tool> [args...]")
  .description("Debug Atrium MCP by calling the run tool through a local MCP client")
  .option("--cwd <path>", "Working directory for the command")
  .option("--stdin <text>", "stdin content to pass to the command")
  .option("--stdin-file <path>", "Read stdin content from a UTF-8 file")
  .option("--request-timeout-ms <ms>", "MCP client request timeout in milliseconds. Debug command only")
  .action(mcpRunCommand);

program
  .command("mcp-operation-wait <operationId>")
  .description("Wait for a durable operation created by any Atrium MCP tool")
  .action(mcpOperationWaitCommand);

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
