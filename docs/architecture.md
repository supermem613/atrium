# Atrium Architecture

Atrium is a stdio MCP server that gives agents a structured path for single CLI and executable calls plus local search primitives. It is not a shell, not a scripting runtime, and not a curated registry of every tool Marcus Markiewicz uses. It exposes these MCP tools:

- `schema` discovers how a target executable wants to be called.
- `run` executes a target executable with an argument vector and returns a compact JSON result.
- `operation-wait` waits for a durable operation handle handed off by any Atrium tool.
- `read` reads UTF-8 text files with deterministic line-range clamping.
- `find-files`, `grep`, and `grep-code` search local files through first-class MCP primitives backed by Atrium's native bundled-ripgrep implementation.

PowerShell remains the right tool for ad-hoc scripting, variables, loops, pipelines, and interactive commands. Long-running single executable calls hand off a durable operation handle that the caller waits on with `operation-wait`.

## Process model

Copilot CLI starts Atrium from the user MCP configuration:

```powershell
npm link
copilot mcp add atrium -- atrium mcp-server
```

At session start, Copilot launches the linked `atrium mcp-server` command as a stdio MCP server. Atrium registers its tool schemas through `@modelcontextprotocol/sdk`, then waits for MCP calls.

The local debug commands use the same path:

```powershell
atrium mcp-schema reflux
atrium mcp-run node -- --version
```

Those commands start `dist\server.js` through a real MCP client, call the MCP tool, and print the tool response. They exist to debug the server path without opening a new Copilot session. `mcp-run` follows a returned auto/background handle inside that same debug MCP server process until the operation reaches a terminal state or the local debug request timeout expires.

## File value contract

Atrium uses one compact file indirection shape anywhere it reads or returns text values:

```ts
type FileValue = string | { file: string; bytes?: number };
```

Input semantics:

- A plain string is inline text.
- `{ "file": "C:\\path\\input.md" }` means read UTF-8 file contents and replace that JSON node with the contents.

Output semantics:

- Small stdout/stderr values are returned as inline strings.
- Large stdout/stderr values are returned as `{ "file": "C:\\path\\output.txt", "bytes": n }`.
- Small `read` content is returned as an inline string.
- Large `read` content is returned as `{ "file": "C:\\path\\content.txt", "bytes": n }`.
- Empty streams are omitted.
- The inline threshold is fixed at 8192 bytes. There is no caller-controlled output-size knob.

Initial input support covers `args[]` and `stdin`.

## `schema` flow

`atrium.schema` answers: "What does this target tool say about its own invocation surface?"

It deliberately does not use a curated Atrium-side schema cache. The target executable is the source of truth.

Flow:

1. Receive `{ tool: "<name-or-path>" }`.
2. Run the target tool through the same execution layer as `run`:

   ```text
   <tool> schema
   ```

3. If the command succeeds and stdout is parseable JSON, return:

   ```json
   {
     "ok": true,
     "tool": "node",
     "timingMs": 84,
     "source": "schema",
     "data": { "...": "target tool schema JSON" },
     "stdout": { "file": "...\\stdout.txt", "bytes": 2683 }
   }
   ```

4. If `<tool> schema` fails or does not return JSON, run:

   ```text
   <tool> --help
   ```

5. If help succeeds, return bounded inline help plus full output paths:

   ```json
   {
     "ok": true,
     "tool": "reflux",
     "timingMs": 52,
     "source": "help",
     "text": "Usage: reflux ...",
     "stdout": { "file": "...\\stdout.txt", "bytes": 978 }
   }
   ```

6. If neither path succeeds, return:

   ```json
   {
     "ok": false,
     "tool": "unknown-tool",
     "timingMs": 7,
     "source": "none",
     "error": {
       "code": "SpawnError",
       "message": "...",

     },
   }
   ```

### Why `schema` falls back to `--help`

Atrium's preferred ecosystem contract is that agent-facing CLIs expose a `schema` command. Existing tools do not all do that yet. Falling back to `--help` keeps Atrium useful for any executable on PATH without making Atrium own each tool's command catalog.

The fallback is intentionally bounded. Large help text is written to disk and only a preview is returned inline. This preserves the agent's context window.

## `run` flow

`atrium.run` answers: "Run this named executable with this exact argv."

Input shape:

```json
{
  "tool": "node",
  "args": ["--version"],
  "cwd": "C:\\Users\\marcusm",
  "stdin": { "file": "C:\\temp\\stdin.txt" }
}
```

`run` has one execution behavior. All target executable calls pass
through one in-memory execution queue before the child process is spawned,
including `run` and `schema` discovery probes. The default queue allows 4
concurrent child executions per Atrium MCP server process. Additional calls wait
in FIFO order for a slot. This limit is intentionally per-process, not
machine-wide; separate Copilot tabs can still have separate Atrium server
processes.

`run` starts the process once and waits inside the safe MCP request window.
If the process finishes before the handoff threshold, Atrium returns the normal
compact result. If the process is still running near 45 seconds, Atrium adopts it
into the durable operation store and returns an `operationId`, a `resultPath`, and
a prescriptive `nextCheck` object. The adopted operation keeps its queue slot
until the child process result settles.

`nextCheck` names exactly what the caller does next: the `operation-wait` tool
with that `operationId`. The handle exposes no timeout or wait knob, so callers
cannot imply a cancel or abort the server does not support. Atrium keeps fixed
server-side execution deadlines instead of caller-tuned operation timeouts.

```json
{
  "ok": true,
  "status": "running",
  "operationId": "atrium-...",
  "resultPath": "C:\\...\\result.json",
  "startedAt": "2026-...Z",
  "nextCheck": { "tool": "atrium.operation-wait", "arguments": { "operationId": "atrium-..." }, "callInMs": 0 },
  "message": "Still running. Call atrium.operation-wait with this operationId. Repeat until status is completed or failed."
}
```

`operation-wait` waits inside a request-safe window for a durable operation handed
off by any Atrium tool. If the operation is still running after that window, it
returns `status: "continue"`, `mustReissueWait: true`, and the same prescriptive
`nextCheck` handle. Running and continue payloads may include bounded cumulative
stdout, stderr, and a progress snapshot, while the terminal completed response
still preserves the final complete result. Each progress update carries a
monotonic revision, so a later `operation-wait` waits for completion, a newer
progress revision, or the fixed request-safe window rather than spinning on the
same snapshot. Once terminal it returns the snapshot with `status:
"completed"` or `status: "failed"`, `completedAt`, and the `result` or `error`.
It recovers from the persisted snapshot at `resultPath` when the handle is no
longer in server memory.

The local `atrium mcp-run` debug command exposes `--request-timeout-ms` because it
owns its MCP client. That option is only for local debugging. It reissues
`operation-wait` within its own process until the operation is terminal or the
budget expires. Long-lived agent hosts call `operation-wait` whenever they receive
a running or continue handle.

```json
{
  "tool": "gh",
  "args": ["issue", "create", "--body", { "file": "C:\\temp\\body.md" }]
}
```

Flow:

1. Validate `tool` is non-empty.
2. Reject shell tools:

   ```text
   pwsh, powershell, bash, cmd, sh, zsh
   ```

   These are denied because shell-as-tool collapses structured args back into shell command text.

3. Acquire a slot from the in-memory execution queue unless that server was explicitly constructed with `executionQueue: false`.
4. Try to spawn the tool directly.
5. On Windows bare-name `ENOENT`, resolve with `where.exe`.
6. Cache the resolved path for the server process lifetime.
7. If the resolved target is an npm `.cmd` shim, try to read the shim and execute the underlying JavaScript entrypoint through `process.execPath`. This avoids the slower and noisier `shell: true` path when possible.
8. Capture stdout and stderr as buffers.
9. Release the execution queue slot in a `finally` path after the child process settles.
10. Materialize each non-empty output stream:

   - Omit empty streams.
   - Inline streams up to 8192 bytes.
   - Write larger streams under `%TEMP%\atrium\runs\<uuid>\` and return `{ "file": "...", "bytes": n }`.

11. Return a compact result with execution metrics:

   ```json
   {
     "ok": true,
     "tool": "node",
     "timingMs": 781,
     "metrics": {
       "queueLimit": 4,
       "queueWaitMs": 0,
       "queueDepthAtEnqueue": 0,
       "queueActiveAtEnqueue": 0,
       "queueActiveAtStart": 1
     },
     "stdout": { "file": "...\\stdout.txt", "bytes": 737 }
   }
   ```

Atrium intentionally does not return debug-only fields such as resolved executable path, argv echo, cwd echo, stdout preview, stderr preview, warnings, or hints by default. Queue metrics are included because they are needed to dogfood and tune the execution limiter.

## Output and artifact policy

Atrium always captures stdout and stderr for a run. Empty streams are omitted entirely, so zero-byte stderr does not produce a field. Small streams and small `read` content are complete inline strings. Large streams and large `read` content are `{ "file": "...", "bytes": n }` references.

This is the main context-saving contract:

- The agent can use small outputs directly.
- The agent can read large file-backed output only if needed.
- Large command output and large read content do not automatically flood the conversation.

## Performance model

Copilot keeps MCP servers alive for the session. Atrium therefore pays the MCP server startup cost once per session, not once per command.

Measured on Marcus's Windows machine:

| Command | Direct executable median | PowerShell-wrapped median | Atrium MCP median |
| --- | ---: | ---: | ---: |
| `node --version` | 57.0 ms | 339.8 ms | 45.7 ms |

The important comparison is Atrium MCP vs PowerShell-wrapped. Atrium is effectively direct-spawn speed while avoiding PowerShell startup and quoting overhead.

The execution queue adds no child-process work when fewer than 4 commands are active in the same MCP server process. Under contention, calls wait for a slot and their `metrics.queueWaitMs` / `metrics.queueDepthAtEnqueue` fields show the added latency.

Run the benchmark with:

```powershell
npm run benchmark -- --command node-version --iterations 15 --warmup 3
```

## Surface registry and advertised instructions

Atrium groups its tools into three surfaces: `core` (`schema`, `run`,
`operation-wait`), `read` (`read`), and `search` (`grep`, `grep-code`,
`find-files`). The registry in `src\mcp\surfaces.ts` is the single source of
truth for each surface: it owns the tool registrations, the per-surface
instruction fragment, and the surface's tool names.

The instructions advertised to the client are composed as an always-on preamble
followed by the non-empty instruction fragments of the enabled surfaces, in
registry order. These instructions are advertised once, during the MCP
`initialize` handshake. There is no live toggle: re-flighting a surface is a
configuration change plus a session restart.

Each surface's instruction fragment advertises surface-tailored guardrails
alongside its tool contract: `core` carries tool-selection and output-handling
guardrails, `read` carries read-safety guardrails, and `search` carries
search-safety guardrails. Because instructions are composed from only the
enabled surfaces, disabling a surface removes its guardrails as well as its
tools, so the advertised guidance stays fine-tuned to the exposed
functionality.

`core` is required and cannot be disabled, because the handoff contract and
`operation-wait` live there and every other surface depends on it.
`resolveSurfaceSelection` validates a requested selection (rejecting unknown
names and any selection that drops `core`) and derives both the enabled
surfaces and their tool-name allowlist.

`atrium mcp-server --surface <names>` starts the server with a subset of
surfaces enabled, and the `atrium-mcp` entrypoint honors the same flag.
`atrium mcp-config --surface <names>` derives both the launch `args` and the
`tools` allowlist from that same selector, so the client-side allowlist is
always a subset of the tools the server actually registers. The default (no
`--surface`) keeps every surface enabled and emits today's `tools: ["*"]`
configuration unchanged.

### Delivering instructions to the model

Advertising the composed instructions at the MCP `initialize` handshake is
necessary but not sufficient: some hosts, including Copilot CLI, do not inject an
MCP server's `instructions` field into model context. Atrium therefore ships a
companion Copilot CLI extension in `extension\atrium.mjs` that composes the
exact same surface-tailored text and injects it as `additionalContext` from the
`onSessionStart` and `onUserPromptSubmitted` hooks, so the guardrails reach the
model at cold start and on every turn, surviving context compaction.

The extension reads the same `mcpServers.atrium.args` selection from
`mcp-config.json` that launches the server, so changing `--surface` re-tailors
the injected instructions with no separate coordination. The selection parsing
and composition are the pure functions in `src\mcp\extensionInstructions.ts`,
which reuse the surface registry so the injected text can never drift from what
the server advertises. Install the extension with
`node scripts\install-extension-shim.mjs`, which writes a redirect shim into
`~\.copilot\extensions\atrium\` that imports the extension entry from this repo.
The entry lives at `extension\atrium.mjs`, outside the `.github\extensions`
project auto-discovery path, so the shim loads it exactly once as a user
extension even when the working directory is the Atrium repo itself.

## Source map

| File | Responsibility |
| --- | --- |
| `src\server.ts` | Composes advertised instructions and registers the enabled surfaces' tools from the surface registry. |
| `src\mcp\surfaces.ts` | Surface registry: the single source of truth for tool registration, per-surface instruction fragments, the surface selector, and the tool-name allowlist. |
| `src\mcp\extensionInstructions.ts` | Pure `--surface` selection parsing and instruction composition shared with the Copilot CLI extension, reusing the surface registry. |
| `extension\atrium.mjs` | Copilot CLI extension entry that injects the composed instructions as `additionalContext` every turn, since the host does not inject the MCP `instructions` field. Kept outside `.github\extensions` so it loads only once as a user extension. |
| `scripts\install-extension-shim.mjs` | Installs the extension by writing a redirect shim into the personal Copilot extensions directory. |
| `src\core\executionQueue.ts` | In-memory max-concurrency limiter for child process starts. |
| `src\core\introspect.ts` | Implements `<tool> schema` then `<tool> --help` discovery. |
| `src\core\runner.ts` | Process spawning, shell denylist, Windows resolution, npm shim handling, timeout, stdout/stderr capture. |
| `src\core\artifacts.ts` | Materializes output buffers as inline strings or `{file, bytes}` values. |
| `src\core\readFile.ts` | Implements `read` text-file range clamping and non-content outcomes. |
| `src\commands\mcpDebug.ts` | Local debug CLI commands that call Atrium through an MCP client. |
| `scripts\benchmark-atrium.mjs` | Performance harness comparing direct, PowerShell-wrapped, and Atrium MCP calls. |

## Non-goals

- No arbitrary shell command strings.
- No general scripting language.
- No curated command catalog inside Atrium.
- No attempt to hide or remove PowerShell. PowerShell remains for tasks that actually need shell semantics.
