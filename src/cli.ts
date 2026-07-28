#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";
import type {
  McpDebugOptions,
  McpFindFilesOptions,
  McpGrepCodeOptions,
  McpGrepOptions,
  McpReadOptions,
  McpRunOptions,
} from "./commands/mcpDebug.js";
import { mcpConfigCommand } from "./commands/mcpConfig.js";
import { schemaCommand } from "./commands/schema.js";
import { contentMaxOptionDescription, fileMaxOptionDescription, parseSurfaceArg, surfaceOptionDescription } from "./mcp/surfaces.js";
import { updateCommand } from "./commands/update.js";

// The MCP SDK costs roughly 400ms to import. ./commands/mcpDebug.js and
// ./server.js are the only modules that pull it in, so importing them eagerly
// charged that cost to every invocation including `atrium --version`. Loading
// them inside the action handlers instead keeps the SDK off the startup path
// and recovers about 630ms per invocation. The type imports above are erased at
// compile time and cost nothing. Keep these loads dynamic.

// Read version from package.json so it stays in sync with the published version.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("atrium")
  .description("Copilot CLI extension that supersedes built-in tool primitives with faster, more powerful versions out of the box.")
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
  .option("--surface <names>", surfaceOptionDescription, parseSurfaceArg)
  .action((options: { surface?: string[] }) => mcpConfigCommand(options.surface));

program
  .command("mcp-server")
  .description("Start the Atrium stdio MCP server")
  .option("--surface <names>", surfaceOptionDescription, parseSurfaceArg)
  .action(async (options: { surface?: string[] }) => {
    const { startAtriumServer } = await import("./server.js");
    return startAtriumServer({ surfaces: options.surface });
  });

program
  .command("mcp-schema <tool>")
  .description("Investigate an MCP schema call locally; rerun with --perf for a CLI-only detailed trace")
  .option("--perf", "Emit a CLI-only detailed report for this single CLI rerun. Normal MCP responses stay token-light")
  .action(async (tool: string, options: McpDebugOptions) => {
    const { mcpSchemaCommand } = await import("./commands/mcpDebug.js");
    return mcpSchemaCommand(tool, options);
  });

program
  .command("mcp-run <tool> [args...]")
  .description("Investigate an MCP run call locally; rerun with --perf for a CLI-only detailed trace")
  .option("--cwd <path>", "Working directory for the command")
  .option("--stdin <text>", "stdin content to pass to the command")
  .option("--stdin-file <path>", "Read stdin content from a UTF-8 file")
  .option("--request-timeout-ms <ms>", "MCP client request timeout in milliseconds. Debug command only")
  .option("--perf", "Emit a CLI-only detailed report for this single CLI rerun. Normal MCP responses stay token-light")
  .action(async (tool: string, args: string[] | undefined, options: McpRunOptions) => {
    const { mcpRunCommand } = await import("./commands/mcpDebug.js");
    return mcpRunCommand(tool, args, options);
  });

program
  .command("mcp-operation-wait <operationId>")
  .description("Investigate a durable operation wait locally; rerun with --perf for a CLI-only detailed trace")
  .option("--perf", "Emit a CLI-only detailed report for this single CLI rerun. Normal MCP responses stay token-light")
  .action(async (operationId: string, options: McpDebugOptions) => {
    const { mcpOperationWaitCommand } = await import("./commands/mcpDebug.js");
    return mcpOperationWaitCommand(operationId, options);
  });

program
  .command("mcp-read <path>")
  .description("Investigate an MCP read call locally; rerun with --perf for a CLI-only detailed trace")
  .option("--start-line <line>", "1-based line number to start the read window")
  .option("--end-line <line>", "1-based line number to end the read window")
  .option("--start-byte <byte>", "Byte offset to start the read window")
  .option("--count-bytes <bytes>", "Maximum number of bytes to read")
  .option("--snapshot <token>", "Snapshot token for byte-page continuation rejection")
  .option("--perf", "Emit a CLI-only detailed report for this single CLI rerun. Normal MCP responses stay token-light")
  .action(async (path: string, options: McpReadOptions) => {
    const { mcpReadCommand } = await import("./commands/mcpDebug.js");
    return mcpReadCommand(path, options);
  });

program
  .command("mcp-find-files <root>")
  .description("Investigate an MCP find-files call locally with Atrium's native file discovery; rerun with --perf for a CLI-only detailed trace")
  .option("--glob <pattern>", "Glob pattern to match files")
  .option("--exclude <pattern>", "Glob pattern to exclude")
  .option("--max <count>", fileMaxOptionDescription)
  .option("--perf", "Emit a CLI-only detailed report for this single CLI rerun. Normal MCP responses stay token-light")
  .action(async (root: string, options: McpFindFilesOptions) => {
    const { mcpFindFilesCommand } = await import("./commands/mcpDebug.js");
    return mcpFindFilesCommand(root, options);
  });

program
  .command("mcp-grep <root>")
  .description("Investigate an MCP grep call locally with Atrium's in-process native search; rerun with --perf for a CLI-only detailed trace")
  .option("--query <patterns...>", "One or more query patterns to match")
  .option("--regex", "Treat query patterns as regular expressions")
  .option("--glob <pattern>", "Glob pattern to constrain the search")
  .option("--exclude <pattern>", "Glob pattern to exclude")
  .option("--max <count>", contentMaxOptionDescription)
  .option("--perf", "Emit a CLI-only detailed report for this single CLI rerun. Normal MCP responses stay token-light")
  .action(async (root: string, options: McpGrepOptions) => {
    const { mcpGrepCommand } = await import("./commands/mcpDebug.js");
    return mcpGrepCommand(root, options);
  });

program
  .command("mcp-grep-code <root>")
  .description("Investigate an MCP grep-code call locally with Atrium's native ignore-aware search; rerun with --perf for a CLI-only detailed trace")
  .option("--query <patterns...>", "One or more query patterns to match")
  .option("--regex", "Treat query patterns as regular expressions")
  .option("--glob <pattern>", "Glob pattern to constrain the search")
  .option("--exclude <pattern>", "Glob pattern to exclude")
  .option("--max <count>", contentMaxOptionDescription)
  .option("--perf", "Emit a CLI-only detailed report for this single CLI rerun. Normal MCP responses stay token-light")
  .action(async (root: string, options: McpGrepCodeOptions) => {
    const { mcpGrepCodeCommand } = await import("./commands/mcpDebug.js");
    return mcpGrepCodeCommand(root, options);
  });

program
  .command("update")
  .description("Self-update: pull with sd or git, npm install, and rebuild atrium")
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
