# Search primitives

Atrium exposes `find-files`, `grep`, and `grep-code` as first-class MCP tools for local search. These are the public search surface. Atrium runs them in-process through a native search engine, a napi-rs Rust addon that embeds ripgrep's crates. The addon is the only search engine. When a prebuilt addon is not available for the current platform, search fails hard. `atrium doctor` reports whether the in-process addon is active and fails when it is absent.

These are MCP tools, not standalone CLI subcommands and not entries in `atrium schema`. The `schema` command documents Atrium's CLI commands. MCP clients discover these tools from the MCP tool list.

## Tool shapes

The two content verbs (`grep`, `grep-code`) share one input shape. Pass a single `query`:

```json
{
  "root": "C:\\repo",
  "query": "TODO",
  "glob": "**/*.{ts,md}",
  "exclude": "**/node_modules/**",
  "max": 20
}
```

Or pass `query` as an array of one or more patterns to match any of. Atrium escapes each pattern and joins them into one alternation before running the native search:

```json
{
  "root": "C:\\repo",
  "query": ["TODO", "FIXME", "HACK"],
  "glob": "**/*.{ts,md}",
  "exclude": "**/node_modules/**",
  "max": 20
}
```

Patterns match literally by default. Set `regex` to `true` to treat them as regular expressions instead, in which case Atrium joins them verbatim with `|`:

```json
{
  "root": "C:\\repo",
  "query": ["foo\\d+", "bar.*baz"],
  "regex": true
}
```

To restrict a content search to a single file, pass `path`:

```json
{
  "root": "C:\\repo",
  "query": "TODO",
  "path": "C:\\repo\\src\\server.ts"
}
```

`path` may be absolute or relative. A relative `path` is resolved under `root`, so `path: "src\\server.ts"` with `root: "C:\\repo"` searches `C:\repo\src\server.ts`. An absolute `path` is used as-is.

`find-files` is path discovery only and takes the same shape **without** `query`. It never reads file contents; it exposes `glob` for path discovery and does not expose a `type` option. Narrow the listing by `glob` and `exclude` instead:

```json
{
  "root": "C:\\repo",
  "glob": "**/*.test.ts",
  "exclude": "**/node_modules/**",
  "max": 100
}
```

Required:

- `query` for the content verbs `grep` and `grep-code`. It is one pattern, or an array of one or more patterns that Atrium combines into an alternation such as `foo|bar|baz`.
- `root` for `find-files`. For `grep` and `grep-code`, `root` is required unless `path` is an absolute file.

Optional:

- `regex`: treat the patterns as regular expressions. Defaults to `false`, which matches patterns literally. Accepts a boolean or the strings `"true"`/`"false"`.
- `path`: restrict a `grep` or `grep-code` content search to a single file. An absolute `path` may be used without `root`. A relative `path` is resolved under `root`.
- `root` for `grep` and `grep-code` when the search is a directory walk or a relative `path`.
- `glob`: constrain searched paths.
- `exclude`: skip matching paths, applied as a negated glob.
- `max`: native produced-result cap. The native search stops after producing `max` matches or paths, and truncation is surfaced in warnings. It does not bound files visited or work for sparse or zero-match searches. Lower `max` is only useful when enough results are already being produced to reach the cap; otherwise narrow the query, glob, or path. Accepts an integer or a numeric string such as `"20"`.

## Choosing a tool

| Goal | Preferred tool | Scope |
| --- | --- | --- |
| Find paths and file names | `find-files` | unrestricted |
| Broad content search across the filesystem | `grep` | unrestricted |
| Code-oriented implementation investigation | `grep-code` | ignore-aware content search across nonignored files |

`grep` and `find-files` are **unrestricted**: they include hidden, gitignored, and vendor files such as `node_modules`. `grep-code` is **ignore-aware** and skips hidden, gitignored, and vendor files. Prefer `grep-code` for symbols, APIs, tests, command handlers, error strings, and docs related to code. Use `grep` for broad filesystem content or generated and dependency artifacts. There is no `find-code` tool; use `find-files` for path discovery.

## Result shapes

`find-files` returns file matches:

```json
{
  "kind": "files",
  "matches": [
    { "path": "src/server.ts" }
  ],
  "warnings": [],
  "timingMs": 12
}
```

`grep` and `grep-code` return content matches:

```json
{
  "kind": "content",
  "matches": [
    { "path": "src/server.ts", "line": 42, "text": "const value = true;" }
  ],
  "warnings": [],
  "timingMs": 12
}
```

`timingMs` is how long the whole search call took, in milliseconds. Warnings from the native search engine, including truncation and timeouts, are surfaced in `warnings`. A search that hits `max` is truncated by the native produced-result cap, so a result can be partial even when the search completed. Callers should show these warnings instead of treating a partial result as clean.

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
    "tool": "atrium.operation-wait",
    "arguments": {
      "operationId": "atrium-..."
    },
    "callInMs": 0
  },
  "message": "Still running. Call atrium.operation-wait with this operationId. Repeat until status is completed or failed."
}
```

The `nextCheck` object is prescriptive. Call `atrium.operation-wait` with the returned `operationId`, and repeat while it returns `status: "continue"`. The handle exposes no timeout or wait knob.

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
    "warnings": [],
    "timingMs": 47
  }
}
```

Never report search success from a still-running handle. Inspect the terminal `operation-wait` result first.
