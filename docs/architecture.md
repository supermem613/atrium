# Atrium Architecture

Atrium is a stdio MCP server that gives agents a structured path for single CLI and executable calls. It is not a shell, not a scripting runtime, and not a curated registry of every tool Marcus Markiewicz uses. It exposes two MCP tools:

- `schema` discovers how a target executable wants to be called.
- `run` executes a target executable with an argument vector and returns a compact JSON result.

PowerShell remains the right tool for ad-hoc scripting, variables, loops, pipelines, interactive commands, and long-running processes.

## Process model

Copilot CLI starts Atrium from the user MCP configuration:

```powershell
copilot mcp add atrium node C:\Users\marcusm\repos\atrium\dist\server.js
```

At session start, Copilot launches `dist\server.js` as a stdio MCP server. Atrium registers its tool schemas through `@modelcontextprotocol/sdk`, then waits for MCP calls.

The local debug commands use the same path:

```powershell
atrium mcp-schema reflux
atrium mcp-run node -- --version
```

Those commands start `dist\server.js` through a real MCP client, call the MCP tool, and print the tool response. They exist to debug the server path without opening a new Copilot session.

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
     "artifacts": {
       "stdoutPath": "...\\stdout.txt",
       "stdoutBytes": 2683
     },
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
     "artifacts": {
       "stdoutPath": "...\\stdout.txt",
       "stdoutBytes": 978
     },
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
  "stdin": "optional input",
  "timeoutMs": 120000,
  "maxPreviewBytes": 0
}
```

Flow:

1. Validate `tool` is non-empty.
2. Reject shell tools:

   ```text
   pwsh, powershell, bash, cmd, sh, zsh
   ```

   These are denied because shell-as-tool collapses structured args back into shell command text.

3. Try to spawn the tool directly.
4. On Windows bare-name `ENOENT`, resolve with `where.exe`.
5. Cache the resolved path for the server process lifetime.
6. If the resolved target is an npm `.cmd` shim, try to read the shim and execute the underlying JavaScript entrypoint through `process.execPath`. This avoids the slower and noisier `shell: true` path when possible.
7. Capture stdout and stderr as buffers.
8. Write full stdout and stderr to a temp artifact directory:

   ```text
   %TEMP%\atrium\runs\<uuid>\stdout.txt
   %TEMP%\atrium\runs\<uuid>\stderr.txt
   ```

9. Return a compact result:

   ```json
   {
     "ok": true,
     "tool": "xray",
     "timingMs": 781,
     "artifacts": {
       "stdoutPath": "...\\stdout.txt",
       "stdoutBytes": 737
     },
     "warnings": []
   }
   ```

Atrium intentionally does not return debug-only fields such as resolved executable path, argv echo, cwd echo, signal, exit code, stdout preview, stderr preview, warnings, or hints by default. Those cost tokens and do not help the agent decide the next step. Callers can opt into previews with `maxPreviewBytes` when they need inline output.

## Output and artifact policy

Atrium always captures stdout and stderr for a run. Non-empty streams are written to artifact files. Empty streams are omitted entirely, so zero-byte stderr does not produce a file, path, or byte-count field. Inline previews are omitted by default and only included when `maxPreviewBytes` is greater than zero.

This is the main context-saving contract:

- The agent sees whether output exists from byte counts.
- The agent can read the full artifact only if needed.
- Large command output does not automatically flood the conversation.

## Performance model

Copilot keeps MCP servers alive for the session. Atrium therefore pays the MCP server startup cost once per session, not once per command.

Measured on Marcus's Windows machine:

| Command | Direct executable median | PowerShell-wrapped median | Atrium MCP median |
| --- | ---: | ---: | ---: |
| `node --version` | 57.0 ms | 339.8 ms | 45.7 ms |
| `xray search tdd ...` | 602.8 ms | 998.9 ms | 600.4 ms |

The important comparison is Atrium MCP vs PowerShell-wrapped. Atrium is effectively direct-spawn speed while avoiding PowerShell startup and quoting overhead.

Run the benchmark with:

```powershell
npm run benchmark -- --command node-version --iterations 15 --warmup 3
npm run benchmark -- --command xray-small --iterations 8 --warmup 2
```

## Source map

| File | Responsibility |
| --- | --- |
| `src\server.ts` | MCP server registration for `schema` and `run`. |
| `src\core\introspect.ts` | Implements `<tool> schema` then `<tool> --help` discovery. |
| `src\core\runner.ts` | Process spawning, shell denylist, Windows resolution, npm shim handling, timeout, stdout/stderr capture. |
| `src\core\artifacts.ts` | Writes full stdout/stderr artifacts under the temp directory. |
| `src\commands\mcpDebug.ts` | Local debug CLI commands that call Atrium through an MCP client. |
| `scripts\benchmark-atrium.mjs` | Performance harness comparing direct, PowerShell-wrapped, and Atrium MCP calls. |

## Non-goals

- No arbitrary shell command strings.
- No general scripting language.
- No curated command catalog inside Atrium.
- No attempt to hide or remove PowerShell. PowerShell remains for tasks that actually need shell semantics.
