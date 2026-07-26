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

// A full re-send every 20th prompt bounds the per-turn token cost while still letting the guardrails recover after the host compacts context.
export const FULL_REINJECTION_INTERVAL = 20;

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

// Reports whether the search surface is in the effective selection so the
// extension can gate its raw-search deny hooks on the same surface that
// advertises the search primitives. When search is disabled the primitives are
// gone, so blocking raw search would strand the model with no way to search.
export function isSearchSurfaceEnabled(selection: readonly string[] | undefined): boolean {
  return resolveSurfaceSelection(selection).surfaces.includes("search");
}

export interface InstructionHookResult {
  additionalContext: string;
}

// Composes the bounded reminder that restates only the rules that are
// expensive to get wrong. It is built from the same resolved surface
// selection as the full text so it can never advertise a surface the
// server does not expose.
export function composeReminderForSelection(selection: readonly string[] | undefined): string {
  const reminderParts = [
    "Atrium guardrails remain in effect.",
    "Shells are denied: call the target binary directly with an args vector, never a shell command string.",
    "A run or search that returns status running with an operationId is not a result: reissue operation-wait until terminal.",
  ];

  if (isSearchSurfaceEnabled(selection)) {
    reminderParts.push(
      "Use atrium-find-files, atrium-grep, and atrium-grep-code instead of rg, grep, find, findstr, or Select-String.",
    );
  }

  reminderParts.push(`Active ${describeEnabledSurfaces(selection)}.`);
  reminderParts.push(
    "The full contract was injected at session start; call the schema tool for exact invocation shapes.",
  );

  return reminderParts.join(" ");
}

// The original hook was added so the guardrails survive host context compaction. Deleting it would trade a token cost for silent policy loss.
// The bounded reminder keeps the non-negotiable rules present every turn and the periodic full re-send lets the complete contract recover after a compaction.
export function createInstructionHooks(selection: readonly string[] | undefined): {
  onSessionStart: () => Promise<InstructionHookResult>;
  onUserPromptSubmitted: () => Promise<InstructionHookResult>;
} {
  const fullInstructionText = composeInstructionsForSelection(selection);
  const reminder = composeReminderForSelection(selection);
  let promptCounter = 0;

  return {
    async onSessionStart(): Promise<InstructionHookResult> {
      return { additionalContext: fullInstructionText };
    },
    async onUserPromptSubmitted(): Promise<InstructionHookResult> {
      promptCounter += 1;
      if (promptCounter % FULL_REINJECTION_INTERVAL === 0) {
        return { additionalContext: fullInstructionText };
      }
      return { additionalContext: reminder };
    },
  };
}
