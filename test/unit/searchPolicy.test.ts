import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  SEARCH_POLICY_CONTEXT,
  repairMessage,
  isBlockedSearch,
  describeBlockedInput,
  evaluatePreToolUse,
  evaluatePermissionRequest,
} from "../../src/mcp/searchPolicy.js";

describe("search-policy blocking predicates", () => {
  it("names the three current Atrium search primitives in the guidance", () => {
    for (const primitive of ["atrium-find-files", "atrium-grep", "atrium-grep-code"]) {
      assert.ok(SEARCH_POLICY_CONTEXT.includes(primitive), `expected guidance to name ${primitive}`);
    }
  });

  it("tells the agent to surface deferred Atrium tools via the tool search tool", () => {
    assert.match(SEARCH_POLICY_CONTEXT, /tool search/i);
    assert.match(SEARCH_POLICY_CONTEXT, /deferred/i);
  });

  it("carries the surfacing instruction in the repair message for a blocked grep", () => {
    const message = repairMessage(describeBlockedInput({ toolName: "grep", toolArgs: {} }));
    assert.match(message, /Search-policy blocked direct `grep` tool use\./);
    assert.match(message, /tool search/i);
    assert.ok(message.includes("atrium-grep-code"));
  });

  it("still blocks a direct grep tool and allows a non-search tool", () => {
    assert.equal(isBlockedSearch({ toolName: "grep", toolArgs: {} }), true);
    assert.equal(isBlockedSearch({ toolName: "view", toolArgs: {} }), false);
  });
});

describe("surface-gated search-policy decisions", () => {
  it("denies a blocked search when the search surface is enabled", () => {
    const decision = evaluatePreToolUse({ toolName: "grep", toolArgs: {} }, true);
    assert.ok(decision);
    assert.equal(decision.permissionDecision, "deny");
    assert.match(decision.permissionDecisionReason, /direct `grep` tool use/);
    assert.match(decision.permissionDecisionReason, /tool search/i);
  });

  it("is inert on a blocked search when the search surface is disabled", () => {
    assert.equal(evaluatePreToolUse({ toolName: "grep", toolArgs: {} }, false), undefined);
  });

  it("allows a non-search tool even when the search surface is enabled", () => {
    assert.equal(evaluatePreToolUse({ toolName: "view", toolArgs: {} }, true), undefined);
  });

  it("rejects a blocked shell search permission when the search surface is enabled", () => {
    const result = evaluatePermissionRequest({ kind: "shell", fullCommandText: "rg foo" }, true);
    assert.equal(result.kind, "reject");
    assert.match(result.feedback, /tool search/i);
  });

  it("returns no-result for a blocked shell search when the search surface is disabled", () => {
    const result = evaluatePermissionRequest({ kind: "shell", fullCommandText: "rg foo" }, false);
    assert.equal(result.kind, "no-result");
  });

  it("returns no-result for an unblocked permission when the search surface is enabled", () => {
    const result = evaluatePermissionRequest({ kind: "shell", fullCommandText: "node x.js" }, true);
    assert.equal(result.kind, "no-result");
  });
});
