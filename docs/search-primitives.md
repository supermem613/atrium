# Search primitives

Atrium exposes `find-files`, `grep`, `multi-grep`, `grep-code`, and `multi-grep-code` as first-class MCP tools for local search. These are the public search surface. Atrium routes them to [xray](https://github.com/supermem613/xray) (bundled ripgrep): the content verbs run `xray search` and `find-files` runs `xray files`. xray must be on `PATH`. Callers should not invoke xray directly; use these MCP tools.

These are MCP tools, not standalone CLI subcommands and not entries in `atrium schema`. The `schema` command documents Atrium's CLI commands. MCP clients discover these tools from the MCP tool list.

## Tool shapes

The four content verbs (`grep`, `grep-code`, `multi-grep`, `multi-grep-code`) share one input shape:

```json
{
  "root": "C:\\repo",
  "query": "TODO",
  "glob": "**/*.{ts,md}",
  "exclude": "**/node_modules/**",
  "max": 20,
  "timeoutMs": 30000
}
```

`find-files` is path discovery only and takes the same shape **without** `query`. It never reads file contents; narrow the listing by `glob` and `exclude` instead:

```json
{
  "root": "C:\\repo",
  "glob": "**/*.test.ts",
  "exclude": "**/node_modules/**",
  "max": 100,
  "timeoutMs": 30000
}
```

Required:

- `root`: the directory to search from.
- `query`: the content query (content verbs only). `multi-grep` and `multi-grep-code` take a regex alternation such as `foo|bar|baz`.

Optional:

- `glob`: constrain searched paths.
- `exclude`: skip matching paths, applied as a negated glob.
- `max`: cap returned results.
- `timeoutMs`: bound the underlying request.

## Choosing a tool

| Goal | Preferred tool | Scope |
| --- | --- | --- |
| Find paths and file names | `find-files` | unrestricted |
| Broad content search across the filesystem | `grep`, `multi-grep` | unrestricted |
| Code-oriented implementation investigation | `grep-code`, `multi-grep-code` | git-aware, code only |

`grep`, `multi-grep`, and `find-files` are **unrestricted**: they include hidden, gitignored, and vendor files such as `node_modules`. `grep-code` and `multi-grep-code` are **git-aware** and skip hidden, gitignored, and vendor files. Prefer `grep-code` and `multi-grep-code` for symbols, APIs, tests, command handlers, error strings, and docs related to code. Use `grep` and `multi-grep` for broad filesystem content or generated and dependency artifacts. There is no `find-code` tool; use `find-files` for path discovery.

## Result shapes

`find-files` returns file matches:

```json
{
  "kind": "files",
  "matches": [
    { "path": "src/server.ts" }
  ],
  "warnings": []
}
```

`grep`, `multi-grep`, `grep-code`, and `multi-grep-code` return content matches:

```json
{
  "kind": "content",
  "matches": [
    { "path": "src/server.ts", "line": 42, "text": "const value = true;" }
  ],
  "warnings": []
}
```

Warnings from xray, including truncated and timed-out results, are surfaced in `warnings`. Callers should show them instead of treating a partial result as clean.

## Long-running contract

Search primitives use the same smart Atrium operation contract as `run`.

If a search finishes inside the safe MCP request window, the tool returns the normal search result directly.

If a search is still running near the handoff threshold, the tool returns a durable handle:

```json
{
  "ok": true,
  "status": "running",
  "operationId": "atrium-...",
  "runId": "atrium-...",
  "resultPath": "C:\\Users\\...\\result.json",
  "wait": {
    "tool": "atrium.wait",
    "arguments": {
      "operationId": "atrium-...",
      "follow": false
    },
    "maxWaitMs": 45000
  }
}
```

Call `atrium.wait` with the returned `operationId` until it returns `status: "completed"` or `status: "failed"`. If `wait` returns `status: "continue"` with `mustReissueWait: true`, call `wait` again with the same `operationId`.

Completed search operations put the search result in `result`:

```json
{
  "ok": true,
  "status": "completed",
  "operationId": "atrium-...",
  "result": {
    "kind": "files",
    "matches": [
      { "path": "package.json" }
    ],
    "warnings": []
  }
}
```

Never report search success from a still-running handle. Inspect the terminal `wait` result first.

