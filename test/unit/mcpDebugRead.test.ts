import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildReadArguments } from "../../src/commands/mcpDebug.js";

describe("mcp-read CLI argument builder", () => {
  it("maps mcp-read byte paging options into the read arguments object", () => {
    const args = buildReadArguments("/tmp/example.txt", {
      startByte: "7",
      countBytes: "11",
      snapshot: "abc123",
    });

    assert.deepEqual(args, {
      path: "/tmp/example.txt",
      startByte: 7,
      countBytes: 11,
      snapshot: "abc123",
    });
  });
});
