import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";
import {
  createInstructionHooks,
  describeEnabledSurfaces,
  isSearchSurfaceEnabled,
  parseSurfaceSelectionFromArgs,
} from "../dist/mcp/extensionInstructions.js";
import {
  evaluatePermissionRequest,
  evaluatePreToolUse,
} from "../dist/mcp/searchPolicy.js";

// Copilot CLI does not inject an MCP server's advertised `instructions` into
// model context. The proven always-on channel is an extension hook that returns
// `additionalContext`. The runtime injects the full guardrails at session start
// and re-sends them every 20th prompt. A bounded reminder carries the
// non-negotiable rules on the prompts in between. This extension exists solely
// to deliver Atrium's surface-tailored guardrails through that channel so the
// server is self-contained and no global instruction file has to carry them.

// This file lives outside the .github/extensions auto-discovery path on purpose.
// The install shim loads it as a user extension in every repo, so keeping it out
// of the project-discovery path means it is never loaded twice when the current
// working directory is the Atrium repo itself.

// Reads the same mcp-config.json entry the server is launched from, so changing
// the server's --surface selection re-tailors the injected instructions with no
// separate coordination.
async function readSurfaceSelection() {
  const configPath = path.join(os.homedir(), ".copilot", "mcp-config.json");
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  return parseSurfaceSelectionFromArgs(config?.mcpServers?.atrium?.args);
}

// A broken or missing config must never crash the session or leave the model
// with no Atrium guardrails, so fall back to the default all-surface text. The
// injected instructions and the logged summary share one effective selection so
// the log never disagrees with what was actually injected.
let selection;
try {
  selection = await readSurfaceSelection();
} catch {
  selection = undefined;
}

let instructionHooks;
let summary;
let searchEnabled;
try {
  instructionHooks = createInstructionHooks(selection);
  summary = describeEnabledSurfaces(selection);
  searchEnabled = isSearchSurfaceEnabled(selection);
} catch {
  instructionHooks = createInstructionHooks(undefined);
  summary = describeEnabledSurfaces(undefined);
  searchEnabled = isSearchSurfaceEnabled(undefined);
}

// Version comes from the repo package.json at runtime, matching how cli.ts and
// server.ts source it, so the logged version never drifts from the published one.
let version = "unknown";
try {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  version = pkg.version ?? version;
} catch {
  // Leave the default when the package manifest cannot be read.
}

const session = await joinSession({
  tools: [],
  onPermissionRequest: async (request) => evaluatePermissionRequest(request, searchEnabled),
  hooks: {
    ...instructionHooks,
    onPreToolUse: async (input) => evaluatePreToolUse(input, searchEnabled),
  },
});

await session.log(`Atrium active: v${version} | ${summary}`, { ephemeral: true });
