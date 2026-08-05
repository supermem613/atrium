import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createAtriumServer, parseServerArgv } from "../../src/server.js";
import type { SearchClientLike } from "../../src/core/search/types.js";

describe("atrium-mcp entrypoint argument parsing", () => {
  it("rejects repository exclusions when an injected search client owns configuration", () => {
    const searchClient: SearchClientLike = {
      async run() {
        return { ok: true };
      },
    };

    assert.throws(
      () => createAtriumServer({
        searchClient,
        searchRepositoryExcludes: ["**/.git/**", "**/.sd/**"],
      }),
      /injected search client/u,
    );
  });

  it("parses --surface into a server selection", () => {
    assert.deepEqual(parseServerArgv(["node", "server.js", "--surface", "core,read"]), {
      surfaces: ["core", "read"],
    });
  });

  it("accumulates repeated --surface flags", () => {
    assert.deepEqual(
      parseServerArgv(["node", "server.js", "--surface", "core", "--surface", "read"]),
      { surfaces: ["core", "read"] },
    );
  });

  it("parses repeated search default excludes", () => {
    assert.deepEqual(
      parseServerArgv([
        "node",
        "server.js",
        "--search-repository-exclude",
        "**/.git/**",
        "--search-repository-exclude",
        "**/{.sd,generated}/**",
      ]),
      {
        surfaces: undefined,
        searchRepositoryExcludes: ["**/.git/**", "**/{.sd,generated}/**"],
      },
    );
  });

  it("rejects an empty search repository exclude", () => {
    assert.throws(
      () => parseServerArgv(["node", "server.js", "--search-repository-exclude", ""]),
      /non-empty pattern/u,
    );
  });

  it("leaves the selection undefined when --surface is absent", () => {
    assert.deepEqual(parseServerArgv(["node", "server.js"]), { surfaces: undefined });
  });
});
