import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";
import {
  composeInstructionsForSelection,
  parseSurfaceSelectionFromArgs,
} from "../../../dist/mcp/extensionInstructions.js";

// Copilot CLI does not inject an MCP server's advertised `instructions` into
// model context. The proven always-on channel is an extension hook that returns
// `additionalContext`, which the runtime injects at session start and on every
// user prompt. This extension exists solely to deliver Atrium's surface-tailored
// guardrails through that channel so the server is self-contained and no global
// instruction file has to carry them.

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
// with no Atrium guardrails, so fall back to the default all-surface text.
let instructions;
try {
  instructions = composeInstructionsForSelection(await readSurfaceSelection());
} catch {
  instructions = composeInstructionsForSelection(undefined);
}

const session = await joinSession({
  tools: [],
  hooks: {
    onSessionStart: async () => ({ additionalContext: instructions }),
    onUserPromptSubmitted: async () => ({ additionalContext: instructions }),
  },
});

await session.log("Atrium instructions extension active.", { ephemeral: true });
