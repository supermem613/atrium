import {
  composeInstructions,
  createSurfaces,
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
