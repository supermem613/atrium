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

Or pass a `queries` array of one or more patterns. Atrium escapes each pattern and joins them into one alternation before running the native search:

```json
{
  "root": "C:\\repo",
  "queries": ["TODO", "FIXME", "HACK"],
  "glob": "**/*.{ts,md}",
  "exclude": "**/node_modules/**",
  "max": 20
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

`find-files` is path discovery only and takes the same shape **without** `query` or `queries`. It never reads file contents; it exposes `glob` for path discovery and does not expose a `type` option. Narrow the listing by `glob` and `exclude` instead:

```json
{
  "root": "C:\\repo",
  "glob": "**/*.test.ts",
  "exclude": "**/node_modules/**",
  "max": 100
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

Atrium applies a fixed internal search deadline. Callers cannot tune search timeouts.

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

`timingMs` is how long the whole search call took, in milliseconds. Warnings from the native search engine, including truncated and timed-out results, are surfaced in `warnings`. Callers should show them instead of treating a partial result as clean.

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
