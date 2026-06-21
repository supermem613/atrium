# atrium

> Agent-first MCP wrapper for running CLIs and executables with structured JSON results.

Atrium is an MCP server for agents. It exposes a tiny surface:

- `atrium.schema` — discover a tool's invocation shape by asking the tool itself.
- `atrium.run` — run a named CLI or executable with structured args and JSON results.
- `atrium.run-status` — inspect a durable background operation by id.
- `atrium.wait` — wait briefly on a durable operation handle without crossing the MCP request deadline.

Large stdout/stderr is written to temp files and returned as paths, so agents do not dump command output into the conversation context.

Atrium is for **single CLI/executable calls**. It is not a shell replacement and it does not execute arbitrary shell strings. Shell binaries (`pwsh`, `powershell`, `bash`, `cmd`, `sh`, `zsh`) are denied so agents keep structured args instead of falling back to shell command text.

## Why Atrium exists

Copilot CLI on Windows often wraps simple CLI calls in PowerShell. That adds process startup cost, quoting risk, noisy stdout/stderr, and retry loops. Atrium gives the agent a persistent MCP server that:

- runs the executable directly from structured args
- resolves Windows npm shims like `xray.cmd` to their underlying Node entrypoint where possible
- supports `{ "file": "..." }` input values for UTF-8 file content in `args[]` and `stdin`
- returns stdout/stderr with a fixed heuristic: empty omitted, 1-8192 bytes inline, larger output as `{ "file": "...", "bytes": n }`
- trims agent-facing results to the fields needed for routing: `ok`, `tool`, `timingMs`, stdout/stderr, and errors
- discovers tool schemas by trying `<tool> schema`, then falls back to `<tool> --help`
- keeps PowerShell available only for real scripting, control flow, pipelines, and interactive commands

Current benchmark signal on Marcus's Windows machine:

| Command | Direct executable median | PowerShell-wrapped median | Atrium MCP median |
| --- | ---: | ---: | ---: |
| `node --version` | 57.0 ms | 339.8 ms | 45.7 ms |
| `xray search tdd ...` | 602.8 ms | 998.9 ms | 600.4 ms |

Interpretation: persistent Atrium MCP calls are effectively direct-spawn speed and materially faster than wrapping single CLI calls through PowerShell. The `xray` case is the important one: Atrium adds no meaningful overhead once the real command dominates runtime.

## Quick start

```bash
git clone https://github.com/<you>/atrium.git ~/repos/atrium
cd ~/repos/atrium
npm install
npm run build
npm link    # makes `atrium` available globally
```

Requires Node.js 22 or newer.

## Commands

```bash
atrium --help
atrium doctor          # health check (use --json for machine output)
atrium schema          # machine-readable command catalog
atrium schema --summary
atrium mcp-config      # MCP config JSON for Copilot CLI
atrium mcp-server      # stdio MCP server entrypoint
atrium mcp-schema reflux # debug MCP schema through a local MCP client
atrium mcp-run node -- --version
atrium mcp-run node --execution-mode auto -- -e "setTimeout(() => console.log('done'), 90000)"
atrium mcp-run-status <runId>
atrium mcp-wait <operationId>
atrium update          # git pull, install dependencies, and rebuild
```

## Connect to Copilot CLI

Build first:

```bash
npm run build
```

Register globally:

```powershell
npm link
copilot mcp add atrium -- atrium mcp-server
```

Or inspect the JSON config Atrium emits:

```bash
atrium mcp-config
```

## Debug the MCP locally

The `mcp-*` commands call Atrium through a real local MCP client, matching the path Copilot CLI uses.

```bash
atrium mcp-schema reflux
atrium mcp-run node -- --version
atrium mcp-run node --stdin-file C:\temp\stdin.txt -- -e "process.stdin.pipe(process.stdout)"
atrium mcp-run xray -- search tdd --root C:\Users\marcusm\.copilot --glob skills/**
atrium mcp-run node --execution-mode auto -- -e "setTimeout(() => console.log('done'), 90000)"
atrium mcp-run-status <runId>
atrium mcp-wait <operationId>
```

MCP callers can use the same compact file-value contract for inputs and outputs:

```json
{
  "tool": "gh",
  "args": ["issue", "create", "--body", { "file": "C:\\temp\\body.md" }],
  "stdin": { "file": "C:\\temp\\stdin.txt" }
}
```

Small stdout/stderr up to 8192 bytes is returned inline as a string. Larger output is returned as `{ "file": "...", "bytes": n }`.

`atrium.run` defaults to `executionMode: "auto"`. Auto mode returns the normal result when the command completes inside the safe MCP window. If the command is still running near 45 seconds, Atrium returns a durable `operationId`/`runId`, a `resultPath`, and a `wait` instruction. Call `atrium.wait` with the `operationId`; it waits up to 45 seconds and returns either the terminal snapshot or `status: "continue"` with `mustReissueWait: true` and the same wait instruction so the caller can reissue it safely. Set `follow: true` on `atrium.wait` to keep re-waiting inside one MCP tool call; a single wait call is always clamped to the 45-second request-safe window even with a large `maxTotalWaitMs`, so it returns `status: "continue"` rather than outliving the client request deadline. Explicit `executionMode: "blocking"` still rejects `timeoutMs` values above 60000 with `BlockingTimeoutTooLarge`.

The local `atrium mcp-run` debug command follows returned handles within the same debug MCP server process until the operation reaches a terminal state or its `--request-timeout-ms` budget expires. Use `atrium mcp-wait` / `atrium mcp-run-status` for handles created by a long-lived MCP server such as Copilot CLI.

For performance checks:

```bash
npm run benchmark -- --command node-version --iterations 15 --warmup 3
npm run benchmark -- --command xray-small --iterations 8 --warmup 2
```

## Questions and tasks it can handle

- "What commands does atrium expose for agents?"
- "Is my local environment healthy enough to run atrium?"
- "Show me the exact schema or help text before I automate against this CLI."
- "Which commands are read-only and which ones mutate state?"

## Conventions

- **Lean deps.** Runtime deps stay small. Atrium adds `@modelcontextprotocol/sdk`
  because MCP hosting is the product surface.
- **Registry first.** `src/registry.ts` is the command source of truth for
  `schema`, docs, help examples, and generated skills.
- **`doctor` first.** Every CLI ships a `doctor` command that returns
  `CheckResult[]` (name, ok, detail, hint). Hints carry remediation text.
- **`schema` first.** Atrium asks target tools for a `schema` command first and
  falls back to `--help` only when the tool has no machine-readable schema.
- **`--json` everywhere.** Any command that produces output supports
  `--json` for machine-readable mode.
- **Semantic verbs.** Product/API CLIs expose stable intent-level commands
  instead of raw HTTP, raw exec, or request-template passthrough.
- **Shell denylist.** Atrium is default-open for executables, but denies shell
  binaries (`pwsh`, `powershell`, `bash`, `cmd`, `sh`, `zsh`) because shell-as-tool
  defeats the structured-args premise.
- **Plan → preview → confirm → apply** for any command that mutates state on
  disk or remote. Silent auto-apply is an anti-pattern.

## Development

```bash
npm run build               # lint + test type-check -> tsc -> dist/
npm run lint                # type-check (src + test)
npm test                    # all tests
npm run test:unit           # unit only
npm run test:integration    # integration only
npm run benchmark           # compare direct, PowerShell-wrapped, and Atrium MCP calls
npm run clean               # remove dist/
```

CI runs on Ubuntu + Windows via GitHub Actions (`.github/workflows/ci.yml`).

Architecture details: [docs/architecture.md](docs/architecture.md).

## Project structure

```
src/
  cli.ts              # Entry point — Commander.js program
  server.ts           # stdio MCP server entry point
  registry.ts         # Command catalog for schema/docs/skill parity
  core/               # executable runner, artifacts, schemas, denylist
  mcp/                # MCP result formatting
  commands/           # One file per CLI command
docs/
  architecture.md # Internal execution, schema discovery, and artifact flow
scripts/
  benchmark-atrium.mjs # Performance harness for direct vs PowerShell vs Atrium
test/
  run.mjs             # Cross-platform test runner (HOME-sandboxed)
  tsconfig.json       # Test type-check config
  unit/               # Unit tests (*.test.ts)
  integration/        # Integration tests (*.test.ts)
```

## License

MIT
