import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { IntrospectToolResult } from "../../src/core/introspect.js";

// Namespace import so a missing export fails as an assertion rather than a
// module link error. That keeps the red gate behavioral.
import * as surfaces from "../../src/mcp/surfaces.js";

function describeWith(tool: string, introspection: IntrospectToolResult, introspected: string[]) {
  assert.equal(typeof surfaces.describeToolOrAtriumVerb, "function", "surfaces must export describeToolOrAtriumVerb");
  return surfaces.describeToolOrAtriumVerb(tool, {}, {
    introspect: async (requested: string) => {
      introspected.push(requested);
      return introspection;
    },
  });
}

const spawnFailedWithEnoent: IntrospectToolResult = {
  ok: false,
  tool: "read",
  timingMs: 1,
  source: "none",
  error: { code: "SpawnError", message: "spawn read ENOENT" },
};

const executableRefusedIntrospection: IntrospectToolResult = {
  ok: false,
  tool: "read",
  timingMs: 1,
  source: "none",
  error: { code: "NonZeroExit", message: "Process exited with code 2." },
};

const executableDescribedItself: IntrospectToolResult = {
  ok: true,
  tool: "read",
  timingMs: 1,
  source: "help",
  text: "usage: read [options]",
};

describe("schema verb precedence", () => {
  it("answers a namespaced verb from the registry without spawning anything", async () => {
    const introspected: string[] = [];
    const described = await describeWith("atrium-read", spawnFailedWithEnoent, introspected);

    assert.deepEqual(introspected, [], "a namespaced verb must not spawn an executable");
    assert.equal(described.source, "atrium");
  });

  it("prefers a real executable over the Atrium verb that shares its name", async () => {
    const introspected: string[] = [];
    const described = await describeWith("read", executableDescribedItself, introspected);

    assert.deepEqual(introspected, ["read"]);
    assert.equal(described.source, "help");
  });

  // A spawn failure never proves which of the two the caller meant, so the
  // answer carries both rather than guessing. Nothing is hidden either way.
  it("reports the Atrium verb and the executable's failure together when a bare name fails to introspect", async () => {
    const introspected: string[] = [];
    const described = await describeWith("read", executableRefusedIntrospection, introspected);

    assert.deepEqual(introspected, ["read"]);
    assert.equal(described.source, "atrium");
    assert.equal(described.data?.name, "read", "the Atrium verb must still be described");
    assert.equal(described.executableError?.code, "NonZeroExit", "the executable's own failure must survive");
    assert.match(String(described.executableError?.message), /Process exited with code 2/u);
  });

  it("reports the Atrium verb and the spawn failure together when no such executable exists", async () => {
    const introspected: string[] = [];
    const described = await describeWith("read", spawnFailedWithEnoent, introspected);

    assert.equal(described.source, "atrium");
    assert.equal(described.data?.name, "read");
    assert.equal(described.executableError?.code, "SpawnError");
  });

  it("names the Atrium verbs when neither an executable nor a verb matches", async () => {
    const introspected: string[] = [];
    const described = await describeWith("definitely-not-a-verb", spawnFailedWithEnoent, introspected);

    assert.equal(described.ok, false);
    assert.match(String((described as IntrospectToolResult).error?.message), /atrium-read/u);
  });
});
