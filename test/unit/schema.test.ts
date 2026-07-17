import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildSchema } from "../../src/registry.js";
import { contentMaxOptionDescription, fileMaxOptionDescription } from "../../src/mcp/surfaces.js";

describe("schema", () => {
  it("lists the baseline commands", () => {
    const schema = buildSchema("0.5.0") as { commands: Array<{ path: string[] }> };
    assert.deepEqual(schema.commands.map((command) => command.path), [
      ["doctor"],
      ["schema"],
      ["mcp-config"],
      ["mcp-server"],
      ["mcp-schema"],
      ["mcp-run"],
      ["mcp-operation-wait"],
      ["mcp-read"],
      ["mcp-find-files"],
      ["mcp-grep"],
      ["mcp-grep-code"],
      ["update"],
    ]);
  });

  it("supports prefix filtering and summary output", () => {
    const schema = buildSchema("0.5.0", ["doctor"], true) as { commandCount: number; commandPaths: string[][] };
    assert.equal(schema.commandCount, 1);
    assert.deepEqual(schema.commandPaths, [["doctor"]]);
  });

  it("documents the native produced-result cap for max summaries", () => {
    const schema = buildSchema("0.5.0") as {
      commands: Array<{
        path: string[];
        input: { flags: Array<{ name: string; summary: string }> };
      }>;
    };

    const expectations = [
      { path: ["mcp-find-files"], expectedTerm: "file path", expectedSummary: fileMaxOptionDescription },
      { path: ["mcp-grep"], expectedTerm: "match", expectedSummary: contentMaxOptionDescription },
      { path: ["mcp-grep-code"], expectedTerm: "match", expectedSummary: contentMaxOptionDescription },
    ];

    for (const { path, expectedTerm, expectedSummary } of expectations) {
      const command = schema.commands.find((candidate) => candidate.path.join(".") === path.join("."));
      if (!command) {
        throw new Error(`expected command ${path.join(".")}`);
      }
      const maxFlag = command.input.flags.find((flag) => flag.name === "--max");
      if (!maxFlag) {
        throw new Error(`expected --max flag for ${path.join(".")}`);
      }
      assert.equal(maxFlag.summary, expectedSummary);
      assert.match(maxFlag.summary, /native produced-result cap/i);
      assert.match(maxFlag.summary, /truncation/i);
      assert.match(maxFlag.summary, new RegExp(expectedTerm, "i"));
    }
  });
});
