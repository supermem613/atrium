import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  composeInstructionsForSelection,
  parseSurfaceSelectionFromArgs,
} from "../../src/mcp/extensionInstructions.js";

// Markers that are owned by a single surface fragment, so their presence proves
// that surface's guardrails were composed in and their absence proves tailoring
// dropped them. The preamble marker is always present regardless of selection.
const PREAMBLE_MARKER = "Hard rules, enforced by the server:";
const CORE_MARKER = "Tool selection and honesty:";
const READ_MARKER = "Read safety:";
const SEARCH_MARKER = "Search safety:";

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
