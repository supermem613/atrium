import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFffResult } from "../../src/core/fff/normalize.js";

test("normalizes file-list output", () => {
  const result = normalizeFffResult({
    content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\n" }],
  });

  assert.deepEqual(result, {
    kind: "files",
    matches: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    warnings: [],
  });
});

test("normalizes grep/content output with path line text", () => {
  const result = normalizeFffResult({
    content: [{ type: "text", text: "src/a.ts:3:alpha\nsrc/b.ts:7:beta\n" }],
  });

  assert.deepEqual(result, {
    kind: "content",
    matches: [
      { path: "src/a.ts", line: 3, text: "alpha" },
      { path: "src/b.ts", line: 7, text: "beta" },
    ],
    warnings: [],
  });
});

test("passes through structured JSON", () => {
  const result = normalizeFffResult({
    structuredContent: {
      kind: "content",
      matches: [{ path: "src/c.ts", line: 4, text: "ok" }],
      warnings: [],
    },
  });

  assert.deepEqual(result, {
    kind: "content",
    matches: [{ path: "src/c.ts", line: 4, text: "ok" }],
    warnings: [],
  });
});

test("emits warnings for unparsed lines", () => {
  const result = normalizeFffResult({
    content: [{ type: "text", text: "src/a.ts:3:alpha\nnot-a-match\n" }],
  });

  assert.deepEqual(result, {
    kind: "content",
    matches: [{ path: "src/a.ts", line: 3, text: "alpha" }],
    warnings: [
      {
        line: 2,
        message: "Unable to parse result line",
        raw: "not-a-match",
      },
    ],
  });
});
