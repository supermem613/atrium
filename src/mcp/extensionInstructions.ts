import {
  composeInstructions,
  createSurfaces,
  resolveSurfaceSelection,
  selectEnabledSurfaces,
  type SurfaceDeps,
} from "./surfaces.js";

// The extension composes the same advertised instructions the MCP server does.
// Only the static instruction fragments are read, so a stub search client and
// zero timings are sufficient. The tool objects createSurfaces builds are
// discarded here.
const instructionStubDeps: SurfaceDeps = {
  executionOptions: {},
  backgroundHandoffAfterMs: 0,
  waitTimeoutMs: 0,
  searchClient: { run: async () => ({ ok: false }) },
};

// Derives the enabled-surface selection from an mcpServers.atrium.args vector so
// the extension tailors its injected instructions to exactly the surfaces the
// server exposes. Returns undefined for the default all-surface server, which is
// how selectEnabledSurfaces expects "no explicit selection" to be expressed.
export function parseSurfaceSelectionFromArgs(args: unknown): string[] | undefined {
  if (!Array.isArray(args)) {
    return undefined;
  }
  const selection: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string") {
      continue;
    }
    if (arg === "--surface") {
      const value = args[index + 1];
      if (typeof value === "string") {
        selection.push(...splitSurfaces(value));
        index += 1;
      }
    } else if (arg.startsWith("--surface=")) {
      selection.push(...splitSurfaces(arg.slice("--surface=".length)));
    }
  }
  return selection.length > 0 ? selection : undefined;
}

function splitSurfaces(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Composes the advertised instructions for a surface selection. undefined yields
// the full default text. An invalid selection throws through
// selectEnabledSurfaces, which the caller turns into the default fallback so a
// misconfigured server never leaves the model with no Atrium guardrails.
export function composeInstructionsForSelection(selection: readonly string[] | undefined): string {
  return composeInstructions(selectEnabledSurfaces(createSurfaces(instructionStubDeps), selection));
}

// Builds the concise one-line summary of what Atrium exposes for a selection, so
// the session log states exactly which surfaces and verbs are on. Throws through
// resolveSurfaceSelection on an invalid selection, which the extension turns into
// the default summary alongside the default instructions fallback.
export function describeEnabledSurfaces(selection: readonly string[] | undefined): string {
  const resolved = resolveSurfaceSelection(selection);
  return `surfaces: ${resolved.surfaces.join(", ")} | verbs: ${resolved.toolNames.join(", ")}`;
}
