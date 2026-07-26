import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  composeInstructionsForSelection,
  describeEnabledSurfaces,
  parseSurfaceSelectionFromArgs,
} from "../../src/mcp/extensionInstructions.js";

// Namespace import so a missing export fails as an assertion rather than a
// module link error. That keeps the red gate behavioral.
import * as extensionInstructions from "../../src/mcp/extensionInstructions.js";

// Markers that are owned by a single surface fragment, so their presence proves
// that surface's guardrails were composed in and their absence proves tailoring
// dropped them. The preamble marker is always present regardless of selection.
const PREAMBLE_MARKER = "Hard rules, enforced by the server:";
const CORE_MARKER = "Tool selection and honesty:";
const READ_MARKER = "Read safety:";
const SEARCH_MARKER = "Search safety:";
const FULL_REINJECTION_INTERVAL = 20;
const REMINDER_MAX_CHARS = 800;
const REMINDER_IDENTITY_MARKER = "Atrium guardrails remain in effect";
const REMINDER_SHELL_MARKER = "Shells are denied";
const REMINDER_HANDOFF_MARKER = "operation-wait";
const REMINDER_SEARCH_MARKER = "atrium-grep-code";

describe("extension surface-selection parsing", () => {
  it("treats a missing args vector as the default all-surface server", () => {
    assert.equal(parseSurfaceSelectionFromArgs(undefined), undefined);
    assert.equal(parseSurfaceSelectionFromArgs(null), undefined);
    assert.equal(parseSurfaceSelectionFromArgs("mcp-server"), undefined);
  });

  it("treats a server launched without --surface as the default", () => {
    assert.equal(parseSurfaceSelectionFromArgs(["mcp-server"]), undefined);
  });

  it("collects a comma-separated --surface value", () => {
    assert.deepEqual(parseSurfaceSelectionFromArgs(["mcp-server", "--surface", "core,read"]), [
      "core",
      "read",
    ]);
  });

  it("accepts the --surface=value form and accumulates repeats", () => {
    assert.deepEqual(
      parseSurfaceSelectionFromArgs(["mcp-server", "--surface=core", "--surface", "read"]),
      ["core", "read"],
    );
  });

  it("trims whitespace and drops empty entries", () => {
    assert.deepEqual(parseSurfaceSelectionFromArgs(["--surface", " core , , search "]), [
      "core",
      "search",
    ]);
  });
});

describe("extension instruction tailoring", () => {
  it("composes every surface's guardrails for the default selection", () => {
    const text = composeInstructionsForSelection(undefined);
    assert.ok(text.includes(PREAMBLE_MARKER));
    assert.ok(text.includes(CORE_MARKER));
    assert.ok(text.includes(READ_MARKER));
    assert.ok(text.includes(SEARCH_MARKER));
  });

  it("drops read and search guardrails when only core is enabled", () => {
    const text = composeInstructionsForSelection(["core"]);
    assert.ok(text.includes(PREAMBLE_MARKER));
    assert.ok(text.includes(CORE_MARKER));
    assert.ok(!text.includes(READ_MARKER));
    assert.ok(!text.includes(SEARCH_MARKER));
    assert.ok(text.length < composeInstructionsForSelection(undefined).length);
  });

  it("keeps read but drops search guardrails for a core plus read selection", () => {
    const text = composeInstructionsForSelection(["core", "read"]);
    assert.ok(text.includes(READ_MARKER));
    assert.ok(!text.includes(SEARCH_MARKER));
  });
});

describe("extension active-surface summary", () => {
  it("lists every surface and verb for the default selection", () => {
    const summary = describeEnabledSurfaces(undefined);
    assert.equal(
      summary,
      "surfaces: core, read, search | verbs: schema, run, operation-wait, read, grep, grep-code, find-files",
    );
  });

  it("lists only the core verbs when only core is enabled", () => {
    const summary = describeEnabledSurfaces(["core"]);
    assert.equal(summary, "surfaces: core | verbs: schema, run, operation-wait");
  });

  it("reflects a core plus read selection without search verbs", () => {
    const summary = describeEnabledSurfaces(["core", "read"]);
    assert.equal(summary, "surfaces: core, read | verbs: schema, run, operation-wait, read");
  });
});

describe("extension hook injection contract", () => {
  it("injects the full instruction block on session start", async () => {
    assert.equal(typeof extensionInstructions.createInstructionHooks, "function");
    const hooks = extensionInstructions.createInstructionHooks(undefined);
    assert.deepEqual(await hooks.onSessionStart(), {
      additionalContext: composeInstructionsForSelection(undefined),
    });
  });

  it("injects a bounded reminder on the prompts between full re-sends", async () => {
    assert.equal(typeof extensionInstructions.createInstructionHooks, "function");
    const hooks = extensionInstructions.createInstructionHooks(undefined);
    const full = composeInstructionsForSelection(undefined);

    for (let prompt = 1; prompt < FULL_REINJECTION_INTERVAL; prompt += 1) {
      const { additionalContext } = await hooks.onUserPromptSubmitted();
      assert.ok(additionalContext.length <= REMINDER_MAX_CHARS);
      assert.ok(additionalContext.length < full.length);
      assert.ok(additionalContext.includes(REMINDER_IDENTITY_MARKER));
      assert.ok(additionalContext.includes(REMINDER_SHELL_MARKER));
      assert.ok(additionalContext.includes(REMINDER_HANDOFF_MARKER));
      assert.ok(additionalContext.includes(REMINDER_SEARCH_MARKER));
    }
  });

  it("re-sends the full instruction block on every 20th prompt", async () => {
    assert.equal(typeof extensionInstructions.createInstructionHooks, "function");
    const hooks = extensionInstructions.createInstructionHooks(undefined);
    const full = composeInstructionsForSelection(undefined);
    const seen = [];

    for (let prompt = 1; prompt <= FULL_REINJECTION_INTERVAL * 2; prompt += 1) {
      seen.push((await hooks.onUserPromptSubmitted()).additionalContext);
    }

    assert.equal(seen[FULL_REINJECTION_INTERVAL - 1], full);
    assert.equal(seen[FULL_REINJECTION_INTERVAL * 2 - 1], full);
    assert.equal(seen.filter((text) => text === full).length, 2);
  });

  it("tailors the reminder to the enabled surfaces", async () => {
    assert.equal(typeof extensionInstructions.createInstructionHooks, "function");
    const hooks = extensionInstructions.createInstructionHooks(["core", "read"]);
    const { additionalContext } = await hooks.onUserPromptSubmitted();

    assert.ok(additionalContext.includes("surfaces: core, read"));
    assert.ok(additionalContext.includes(REMINDER_SHELL_MARKER));
    assert.ok(additionalContext.length <= REMINDER_MAX_CHARS);
  });
});
