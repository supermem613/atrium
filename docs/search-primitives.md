# Search primitives

Atrium exposes `find-files`, `grep`, and `grep-code` as first-class MCP tools for local search. These are the public search surface. Atrium routes them to [xray](https://github.com/supermem613/xray) (bundled ripgrep): the content verbs run `xray search` and `find-files` runs `xray files`. xray must be on `PATH`. Callers should not invoke xray directly; use these MCP tools.

These are MCP tools, not standalone CLI subcommands and not entries in `atrium schema`. The `schema` command documents Atrium's CLI commands. MCP clients discover these tools from the MCP tool list.

## Tool shapes

The two content verbs (`grep`, `grep-code`) share one input shape. Pass a single `query`:

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

Or pass a `queries` array to match any of several patterns. Atrium escapes each pattern and joins them into one alternation before running xray:

```json
{
  "root": "C:\\repo",
  "queries": ["TODO", "FIXME", "HACK"],
  "glob": "**/*.{ts,md}",
  "exclude": "**/node_modules/**",
  "max": 20,
  "timeoutMs": 30000
}
```

Provide exactly one of `query` or `queries`; sending both or neither is rejected. Patterns match literally by default. Set `regex` to `true` to treat them as regular expressions instead, in which case Atrium joins them verbatim with `|`:

```json
{
  "root": "C:\\repo",
  "queries": ["foo\\d+", "bar.*baz"],
  "regex": true
}
```

`find-files` is path discovery only and takes the same shape **without** `query` or `queries`. It never reads file contents; narrow the listing by `glob` and `exclude` instead:

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
- exactly one of `query` or `queries` for the content verbs `grep` and `grep-code`. `query` is a single pattern; `queries` is an array of one or more patterns that Atrium combines into an alternation such as `foo|bar|baz`.

Optional:

- `regex`: treat the patterns as regular expressions. Defaults to `false`, which matches patterns literally.
- `glob`: constrain searched paths.
- `exclude`: skip matching paths, applied as a negated glob.
- `max`: cap returned results.
- `timeoutMs`: bound the underlying request.

## Choosing a tool

| Goal | Preferred tool | Scope |
| --- | --- | --- |
| Find paths and file names | `find-files` | unrestricted |
| Broad content search across the filesystem | `grep` | unrestricted |
| Code-oriented implementation investigation | `grep-code` | git-aware, code only |

`grep` and `find-files` are **unrestricted**: they include hidden, gitignored, and vendor files such as `node_modules`. `grep-code` is **git-aware** and skips hidden, gitignored, and vendor files. Prefer `grep-code` for symbols, APIs, tests, command handlers, error strings, and docs related to code. Use `grep` for broad filesystem content or generated and dependency artifacts. There is no `find-code` tool; use `find-files` for path discovery.

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

`grep` and `grep-code` return content matches:

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

Search primitives use the same single execution behavior as `run`.

If a search finishes inside the safe MCP request window, the tool returns the normal search result directly.

If a search is still running near the handoff threshold, the tool returns a durable handle:

```json
{
  "ok": true,
  "status": "running",
  "operationId": "atrium-...",
  "resultPath": "C:\\Users\\...\\result.json",
  "startedAt": "2026-...Z",
  "nextCheck": {
    "tool": "atrium.operation-status",
    "arguments": {
      "operationId": "atrium-..."
    },
    "callInMs": 60000
  },
  "message": "Still running. Call atrium.operation-status with this operationId in ~60000 ms. Repeat until status is completed or failed."
}
```

The `nextCheck` object is prescriptive. Wait `callInMs` milliseconds, then call `atrium.operation-status` with the returned `operationId`, and repeat until it returns `status: "completed"` or `status: "failed"`. The handle exposes no timeout or wait knob, and there is no separate `wait` tool.

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

Never report search success from a still-running handle. Inspect the terminal `operation-status` result first.

