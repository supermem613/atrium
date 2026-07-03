# Search primitives

Atrium exposes `find-files`, `grep`, `multi-grep`, `grep-code`, and `multi-grep-code` as first-class MCP tools for local search. These are the public search surface. Atrium may route them through a resident internal engine, but callers should not call that engine directly.

These are MCP tools, not standalone CLI subcommands and not entries in `atrium schema`. The `schema` command documents Atrium's CLI commands. MCP clients discover these tools from the MCP tool list.

## Tool shapes

All five tools share the same input shape:

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

Required:

- `root`: the directory to search from.
- `query`: the file-name or content query.

Optional:

- `glob`: constrain searched paths.
- `exclude`: skip matching paths.
- `max`: cap returned matches.
- `timeoutMs`: bound the underlying request.

## Choosing a tool

| Goal | Preferred tool |
| --- | --- |
| Find paths and file names | `find-files` |
| Broad content search across the filesystem | `grep`, `multi-grep` |
| Code-oriented implementation investigation | `grep-code`, `multi-grep-code` |

Prefer `grep-code` and `multi-grep-code` for symbols, APIs, tests, command handlers, error strings, and docs related to code. Use `grep` and `multi-grep` for broad filesystem content or generated/dependency/odd artifacts. There is no `find-code` tool; use `find-files` for path discovery.

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

Normalization warnings are surfaced in `warnings`. Callers should show them instead of treating partial normalization as a clean result.

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

