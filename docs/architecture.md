# Atrium Architecture

Atrium is a stdio MCP server that gives agents a structured path for single CLI and executable calls. It is not a shell, not a scripting runtime, and not a curated registry of every tool Marcus Markiewicz uses. It exposes four MCP tools:

- `schema` discovers how a target executable wants to be called.
- `run` executes a target executable with an argument vector and returns a compact JSON result.
- `run-status` inspects a durable operation handle.
- `wait` blocks briefly on a durable operation handle and returns `continue` before the MCP request deadline.

PowerShell remains the right tool for ad-hoc scripting, variables, loops, pipelines, and interactive commands. Long-running single executable calls should use Atrium auto/background operation handles.

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
     "tool": "xray",
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
  "tool": "xray",
  "args": ["search", "tdd", "--root", "C:\\Users\\marcusm\\.copilot"],
  "cwd": "C:\\Users\\marcusm",
  "stdin": { "file": "C:\\temp\\stdin.txt" },
  "timeoutMs": 60000
}
```

`run` defaults to `executionMode: "auto"`. All target executable calls pass
through one in-memory execution queue before the child process is spawned,
including `run` and `schema` discovery probes. The default queue allows 4
concurrent child executions per Atrium MCP server process. Additional calls wait
in FIFO order for a slot. This limit is intentionally per-process, not
machine-wide; separate Copilot tabs can still have separate Atrium server
processes.

Auto mode starts the process once and waits inside the safe MCP request window.
If the process finishes before the handoff threshold, Atrium returns the normal
compact result. If the process is still running near 45 seconds, Atrium adopts it
into the durable background operation store and returns an `operationId`/`runId`,
`resultPath`, and a `wait` instruction. Background mode also uses the same queue
and holds its slot until the child process result settles.

Explicit blocking calls are still capped at `timeoutMs <= 60000` because MCP
clients usually enforce a 60s request deadline. Longer explicit blocking
requests fail fast with a structured `BlockingTimeoutTooLarge` envelope instead
of letting the client surface raw `-32001 Request timed out`.

`wait` is a bounded long-poll. It waits up to 45000 ms for an `operationId`. If
the operation reaches a terminal state, `wait` returns the same snapshot shape as
`run-status`. If it is still running, `wait` returns `status: "continue"` with
`mustReissueWait: true`, the same `operationId`, and a fresh wait instruction.
Callers can reissue `wait` without ever holding one MCP request past the client
deadline.

`wait` also supports `follow: true`. Follow mode repeats those bounded waits
inside one MCP tool call until the operation reaches a terminal status. A single
wait call is always clamped to the 45000 ms request-safe window, so even a large
`maxTotalWaitMs` cannot make one request outlive the MCP client deadline and fail
with `-32001`. If the operation is still running when the window closes, Atrium
returns `status: "continue"` with `mustReissueWait: true` so the caller does not
confuse a still-running operation with completion and reissues `wait` to continue.

The local `atrium mcp-run` debug command also exposes `--request-timeout-ms`
because it owns its MCP client. That option is only for local debugging.
Long-lived agent hosts should use auto mode, then call `wait` again when they
receive `status: "continue"`.

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
     "tool": "xray",
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

Atrium always captures stdout and stderr for a run. Empty streams are omitted entirely, so zero-byte stderr does not produce a field. Small streams are complete inline strings. Large streams are `{ "file": "...", "bytes": n }` references.

This is the main context-saving contract:

- The agent can use small outputs directly.
- The agent can read large file-backed output only if needed.
- Large command output does not automatically flood the conversation.

## Performance model

Copilot keeps MCP servers alive for the session. Atrium therefore pays the MCP server startup cost once per session, not once per command.

Measured on Marcus's Windows machine:

| Command | Direct executable median | PowerShell-wrapped median | Atrium MCP median |
| --- | ---: | ---: | ---: |
| `node --version` | 57.0 ms | 339.8 ms | 45.7 ms |
| `xray search tdd ...` | 602.8 ms | 998.9 ms | 600.4 ms |

The important comparison is Atrium MCP vs PowerShell-wrapped. Atrium is effectively direct-spawn speed while avoiding PowerShell startup and quoting overhead.

The execution queue adds no child-process work when fewer than 4 commands are active in the same MCP server process. Under contention, calls wait for a slot and their `metrics.queueWaitMs` / `metrics.queueDepthAtEnqueue` fields show the added latency.

Run the benchmark with:

```powershell
npm run benchmark -- --command node-version --iterations 15 --warmup 3
npm run benchmark -- --command xray-small --iterations 8 --warmup 2
```

## Source map

| File | Responsibility |
| --- | --- |
| `src\server.ts` | MCP server registration for `schema`, `run`, `run-status`, and `wait`. |
| `src\core\executionQueue.ts` | In-memory max-concurrency limiter for child process starts. |
| `src\core\introspect.ts` | Implements `<tool> schema` then `<tool> --help` discovery. |
| `src\core\runner.ts` | Process spawning, shell denylist, Windows resolution, npm shim handling, timeout, stdout/stderr capture. |
| `src\core\artifacts.ts` | Materializes stdout/stderr as inline strings or `{file, bytes}` values. |
| `src\commands\mcpDebug.ts` | Local debug CLI commands that call Atrium through an MCP client. |
| `scripts\benchmark-atrium.mjs` | Performance harness comparing direct, PowerShell-wrapped, and Atrium MCP calls. |

## Non-goals

- No arbitrary shell command strings.
- No general scripting language.
- No curated command catalog inside Atrium.
- No attempt to hide or remove PowerShell. PowerShell remains for tasks that actually need shell semantics.
