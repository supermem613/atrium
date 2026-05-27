import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildSchema } from "../../src/registry.js";

describe("schema", () => {
  it("lists the baseline commands", () => {
    const schema = buildSchema("0.1.0") as { commands: Array<{ path: string[] }> };
    assert.deepEqual(schema.commands.map((command) => command.path), [
      ["doctor"],
      ["schema"],
      ["mcp-config"],
      ["mcp-schema"],
      ["mcp-run"],
      ["update"],
    ]);
  });

  it("supports prefix filtering and summary output", () => {
    const schema = buildSchema("0.1.0", ["doctor"], true) as { commandCount: number; commandPaths: string[][] };
    assert.equal(schema.commandCount, 1);
    assert.deepEqual(schema.commandPaths, [["doctor"]]);
  });
});
