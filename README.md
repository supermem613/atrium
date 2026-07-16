# atrium

> Copilot CLI extension that supersedes built-in tool primitives with faster, more powerful versions out of the box.

Atrium is a Copilot CLI extension that supersedes the built-in tool primitives with faster, more powerful versions. Its MCP server exposes a small tool surface:

- `atrium.schema` — discover a tool's invocation shape by asking the tool itself.
- `atrium.run` — run a named CLI or executable with structured args and JSON results.
- `atrium.operation-wait` — wait for a durable operation by id, handed off by any Atrium tool.
- `atrium.read` — read a UTF-8 text file with deterministic line-range clamping.
- `atrium.find-files`, `atrium.grep`, `atrium.grep-code` — search files through first-class MCP primitives.

Large stdout/stderr and read content are written to temp files and returned as paths, so agents do not dump large text into the conversation context.

Atrium is for **single CLI/executable calls**. It is not a shell replacement and it does not execute arbitrary shell strings. Shell binaries (`pwsh`, `powershell`, `bash`, `cmd`, `sh`, `zsh`) are denied so agents keep structured args instead of falling back to shell command text.

## Why Atrium exists

Copilot CLI on Windows often wraps simple CLI calls in PowerShell. That adds process startup cost, quoting risk, noisy stdout/stderr, and retry loops. Atrium gives the agent a persistent MCP server that:

- runs the executable directly from structured args
- resolves Windows npm shims to their underlying Node entrypoint where possible
- supports `{ "file": "..." }` input values for UTF-8 file content in `args[]` and `stdin`
- returns stdout/stderr and read content with a fixed heuristic: empty omitted when applicable, 1-8192 bytes inline, larger output as `{ "file": "...", "bytes": n }`
- trims agent-facing results to the fields needed for routing: `ok`, `tool`, `timingMs`, stdout/stderr, and errors
- limits one MCP server process to 4 concurrent child executions and reports queue metrics in run results
- discovers tool schemas by trying `<tool> schema`, then falls back to `<tool> --help`
- keeps PowerShell available only for real scripting, control flow, pipelines, and interactive commands

Current benchmark signal on Marcus's Windows machine:

| Command | Direct executable median | PowerShell-wrapped median | Atrium MCP median |
| --- | ---: | ---: | ---: |
| `node --version` | 57.0 ms | 339.8 ms | 45.7 ms |

Interpretation: persistent Atrium MCP calls are effectively direct-spawn speed and materially faster than wrapping single CLI calls through PowerShell.

## Quick start

```bash
git clone https://github.com/<you>/atrium.git ~/repos/atrium
cd ~/repos/atrium
npm install
npm run build
npm link    # makes `atrium` available globally
```

Requires Node.js 22 or newer and a Rust toolchain (`cargo`) to compile the native search addon. Atrium's search tools run in-process through a native search engine, a napi-rs addon embedding ripgrep's crates. The addon is the only search engine, so search fails hard when no prebuilt addon is available. `npm run build` compiles the addon automatically on the first build (when it is missing) and then runs `tsc`. Run `atrium doctor` to confirm the in-process addon is active; it fails when the addon is absent.

## Commands

```bash
atrium --help
atrium doctor          # health check (use --json for machine output)
atrium schema          # machine-readable command catalog
atrium schema --summary
atrium mcp-config      # MCP config JSON for Copilot CLI
atrium mcp-server      # stdio MCP server entrypoint
atrium mcp-server --surface core,read # enable a subset of surfaces (core is required)
atrium mcp-schema reflux # debug MCP schema through a local MCP client
atrium mcp-run node -- --version
atrium mcp-run node -- -e "setTimeout(() => console.log('done'), 90000)"
atrium mcp-operation-wait <operationId>
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

## Surfaces

Atrium's tools are grouped into surfaces: `core` (`schema`, `run`,
`operation-wait`), `read` (`read`), and `search` (`grep`, `grep-code`,
`find-files`). By default every surface is enabled.

Enable a subset with `atrium mcp-server --surface <names>`, a comma-separated
and repeatable list. `core` is always required. The instructions Atrium
advertises are composed from only the enabled surfaces and are sent once at the
MCP `initialize` handshake, so changing the enabled surfaces takes effect on the
next server start. The `atrium-mcp` entrypoint honors `--surface` identically.

Each surface also advertises its own behavioral guardrails, not just its tool contract. The `read` surface carries read-safety guidance and the `search` surface carries search-safety guidance, so disabling a surface removes both its tools and its guardrails from the advertised instructions. This keeps the advertised guidance fine-tuned to exactly the functionality Atrium exposes.

`atrium mcp-config --surface <names>` derives its output from the same
selection: with no `--surface` it emits today's `tools: ["*"]`; for a restricted
selection it emits the `--surface` launch argument and a `tools` allowlist
limited to the enabled surfaces' tools, so the client-side allowlist is always a
subset of what the server registers.

```bash
atrium mcp-config --surface core,read
```

## Always-on instructions extension

The MCP `instructions` composed above are advertised at the `initialize`
handshake, but some hosts (including Copilot CLI) do not inject that field into
model context. Atrium ships a companion Copilot CLI extension that composes the
same surface-tailored text and injects it as `additionalContext` on every turn
and at session start, so the guardrails reach the model reliably and survive
context compaction. When the `search` surface is enabled, that injected text
includes the explicit search-tool to primitive mapping, so the model learns to
reach for `atrium-grep`, `atrium-grep-code`, and `atrium-find-files` instead of
`rg`, `grep`, or `find` before it is ever denied.

Install it once:

```bash
node scripts/install-extension-shim.mjs
```

This writes a redirect shim into `~/.copilot/extensions/atrium/` that imports the
extension from this repo, so rebuilding the repo updates the injected
instructions with no reinstall. The extension reads the same `--surface`
selection from `mcp-config.json` as the server, so the injected guardrails always
match the surfaces the server exposes.

When the `search` surface is enabled the same extension also enforces the search
policy: it registers deny hooks that reject raw `rg`, `grep`, `git grep`, `find`,
`findstr`, `xray`, and `Select-String` use, shell commands that call those
binaries, and `atrium run` calls that spawn a raw search binary, steering the
model back to `atrium-find-files`, `atrium-grep`, and `atrium-grep-code`.
Enforcement is gated on the search surface, so a build without `search` exposes
no search verbs and blocks nothing. This replaces the former standalone
search-policy extension, which is no longer needed.

## Debug the MCP locally

The `mcp-*` commands call Atrium through a real local MCP client, matching the path Copilot CLI uses.

```bash
atrium mcp-schema node
atrium mcp-run node -- --version
atrium mcp-run node --stdin-file C:\temp\stdin.txt -- -e "process.stdin.pipe(process.stdout)"
atrium mcp-run node -- -e "setTimeout(() => console.log('done'), 90000)"
atrium mcp-operation-wait <operationId>
```

## Search MCP tools

Atrium's MCP server exposes `find-files`, `grep`, and `grep-code` as first-class MCP tools backed by Atrium's in-process native search engine, which embeds ripgrep's crates. The addon is the only search engine, and search fails hard when no prebuilt addon is available for the platform. `grep` and `grep-code` take a `root` plus a `query` that is one pattern or an array of patterns to match any of; set `regex` true to treat the patterns as regular expressions instead of literal text, and pass an optional `path` to restrict a content search to a single file. `find-files` accepts `root` plus `glob`, `exclude`, and `max`, exposes `glob` for path discovery, and does not expose a `type` option. There is no `find-code` tool; use `find-files` for path discovery.

`grep` and `find-files` are unrestricted: they include hidden, gitignored, and vendor files such as `node_modules`. `grep-code` is ignore-aware and skips hidden, gitignored, and vendor files. Prefer `grep-code` for symbols, APIs, tests, command handlers, error strings, and docs related to code. Use `grep` for broad filesystem content or generated and dependency artifacts.

```json
{
  "name": "grep",
  "arguments": {
    "root": "C:\\repo",
    "query": "TODO",
    "glob": "**/*.{ts,md}",
    "max": 20
  }
}
```

These are MCP tools, not standalone CLI subcommands. The `atrium schema` command remains the catalog for Atrium's CLI commands. See [Search primitives](docs/search-primitives.md) for complete request, result, and long-running handle shapes.

## Read MCP tool

`atrium.read` reads UTF-8 text files by 1-based line range. It clamps ranges instead of failing when the requested end goes past EOF, and the returned `range` plus `meta.totalLines` is the complete paging signal.

```json
{
  "ok": true,
  "path": "C:\\repo\\src\\server.ts",
  "timingMs": 2,
  "range": [2, 3],
  "meta": { "totalLines": 3, "bytes": 14 },
  "content": "two\nthree\n"
}
```

For large ranges, `content` uses the same file-value contract as command output:

```json
{
  "ok": true,
  "path": "C:\\repo\\large.txt",
  "timingMs": 6,
  "range": [1, 500],
  "meta": { "totalLines": 900, "bytes": 50000 },
  "content": { "file": "C:\\Users\\...\\content.txt", "bytes": 12000 }
}
```

Expected non-content outcomes return `ok:false` with `status` and `hint`, for example `not-found`, `unsupported`, or `invalid-args`. Successful reads do not include separate EOF or adjustment flags because `range` and `meta.totalLines` already carry that information. See [Read primitive](docs/read-primitive.md) for the complete contract.

MCP callers can use the same compact file-value contract for inputs and outputs:

```json
{
  "tool": "gh",
  "args": ["issue", "create", "--body", { "file": "C:\\temp\\body.md" }],
  "stdin": { "file": "C:\\temp\\stdin.txt" }
}
```

Small stdout/stderr and read content up to 8192 bytes are returned inline as strings. Larger output is returned as `{ "file": "...", "bytes": n }`.

`atrium.run` and the search MCP tools have one execution behavior. They return the normal result when the work completes inside the safe MCP window. If the work is still running near 45 seconds, Atrium returns a durable `operationId`, a `resultPath`, and a prescriptive `nextCheck` object. `nextCheck` names exactly what to call next: the `atrium.operation-wait` tool with that `operationId`. Call `atrium.operation-wait`, then repeat while it returns `status: "continue"`. Running and continue payloads may include bounded cumulative stdout, stderr, and a progress snapshot, while the terminal completed response still preserves the final complete result. Each progress update uses a monotonic revision, so a later `operation-wait` waits for completion, a newer progress revision, or the fixed request-safe window rather than spinning on the same snapshot. Terminal waits return `status: "completed"` or `status: "failed"` with the final `result` or `error`. Agents do not control operation or wait timeouts; Atrium uses fixed server-side deadlines and a request-safe wait window.

All target executable calls share one in-memory execution queue per Atrium MCP server process, including `atrium.run` and `atrium.schema` discovery probes. The default queue allows multiple concurrent child executions. Additional calls wait for a slot before spawning the child process. Background runs count against the queue until their child process completes, so background work cannot accumulate unbounded child processes. The queue is intentionally per-process, not machine-wide; separate Copilot tabs can still have separate Atrium server processes.

Run metrics include queue fields for dogfooding and tuning:

```json
{
  "metrics": {
    "queueLimit": 4,
    "queueWaitMs": 0,
    "queueDepthAtEnqueue": 0,
    "queueActiveAtEnqueue": 0,
    "queueActiveAtStart": 1
  }
}
```

The server and runner accept an `executionQueue` option for tests and local rollback. Passing `executionQueue: false` disables the limiter for that server instance.

The local `atrium mcp-run` debug command reissues `operation-wait` within the same debug MCP server process until the operation reaches a terminal state or its `--request-timeout-ms` budget expires. Use `atrium mcp-operation-wait` for handles created by a long-lived MCP server such as Copilot CLI.

For performance checks:

```bash
npm run benchmark -- --command node-version --iterations 15 --warmup 3
```

For the CLI-driven workflow for investigating a single MCP verb's performance, see [docs/perf.md](docs/perf.md).

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
npm run build               # build native addon if missing, then tsc -> dist/
npm run build:native        # force-rebuild the native search addon (cargo)
npm run lint                # type-check (src + test)
npm test                    # all tests
npm run test:unit           # unit only
npm run test:integration    # integration only
npm run benchmark           # compare direct, PowerShell-wrapped, and Atrium MCP calls
npm run clean               # remove dist/
```

CI runs on Ubuntu + Windows via GitHub Actions (`.github/workflows/ci.yml`),
caching the Rust build with `Swatinem/rust-cache` and pinning `actions/checkout`
and `actions/setup-node` at v5.

The test runner (`test/run.mjs`) runs each test file in its own child process,
one file at a time. Serial execution keeps the timing-sensitive perf and
background-run tests stable on the 4-core Windows CI runners, where running
files in parallel oversubscribed the CPU and made them flake. Each child gets a
sandboxed `HOME` so tests cannot read your real `~/.atrium/` state; set
`ATRIUM_TEST_REAL_HOME=1` to opt out. Per-test time budgets live in
[`test/perf-budgets.json`](test/perf-budgets.json) (`defaultTestMs`,
`slowThresholdMs`, and per-test `maxMs` overrides matched by `file` and
`nameIncludes`); a test that exceeds its budget fails the run. Every run writes a
machine-readable report to `test-results/atrium-tests.json`; CI uploads
`test-results/` on failure and emits inline `::error` annotations for failing
tests.

Architecture details: [docs/architecture.md](docs/architecture.md).

## Project structure

```
src/
  cli.ts              # Entry point — Commander.js program
  server.ts           # stdio MCP server entry point
  registry.ts         # Command catalog for schema/docs/skill parity
  core/               # executable runner, queue, artifacts, denylist, in-process search
  mcp/                # MCP result formatting
  commands/           # One file per CLI command
crates/
  atrium-search/      # Rust napi-rs native search addon (embeds ripgrep crates)
docs/
  architecture.md # Internal execution, schema discovery, and artifact flow
  read-primitive.md # MCP read contract and range behavior
  search-primitives.md # MCP search contract and result shapes
scripts/
  benchmark-atrium.mjs # Performance harness for direct vs PowerShell vs Atrium
test/
  run.mjs             # Cross-platform parallel test runner (HOME-sandboxed)
  perf-budgets.json   # Per-test time budgets enforced by the runner
  tsconfig.json       # Test type-check config
  unit/               # Unit tests (*.test.ts)
  integration/        # Integration tests (*.test.ts)
```

## License

MIT
