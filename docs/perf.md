# Atrium CLI perf workflow for MCP verbs

Use the Atrium CLI when you need a detailed trace for a single MCP verb. Future Copilot CLI sessions should rerun the target operation through the Atrium CLI with `--perf` instead of expecting a perf signal from normal MCP responses.

## Rule of thumb

- Normal MCP output stays token-light and returns the usual structured result.
- Detailed traces are CLI-only. The CLI `--perf` rerun emits the extra report alongside the regular response.
- Do not treat `--perf` as an MCP input or as a separate report-retrieval verb. It is a CLI-only investigation path that reruns the target operation once and prints a detailed report for that single operation.

## CLI workflow

1. Identify the exact MCP verb and arguments you want to investigate.
2. Rerun that operation through the Atrium CLI with `--perf`.
3. Read the CLI report for the single operation you just executed.
4. Use the benchmark harness only when you want an aggregate suite view across multiple verbs or operations.

### Report fields

The CLI `--perf` report preserves per-operation terminology and includes:

- `operationId`
- `startedAt` and `endedAt`
- `durationMs` and `elapsedMs`
- `concurrency`
- `cases[]` with `name`, `ok`, `elapsedMs`, and `timings`
- `totals.pass` and `totals.fail`
- `perOperation` with one entry for the operation you just reran

Treat this output as the detailed investigation report for one CLI rerun. It is not the benchmark harness's aggregate suite report.

## Benchmark usage

The benchmark harness owns the aggregate report used for benchmark suites. That report is the benchmark artifact for multi-verb or multi-operation comparisons and uses aggregate terminology such as `suite`, `cases`, `totals`, and `perOperation`.

Use the benchmark entrypoint when you want a suite-level comparison:

```bash
npm run benchmark -- --command node-version --iterations 15 --warmup 3
```

Interpret the benchmark output as a benchmark-owned aggregate report. Interpret the CLI `--perf` output as a CLI-owned per-operation report.

## All-verb evals

Use this exact command for the aggregate eval suite:

```bash
npm run benchmark -- --suite all-verbs
```

It runs serially against realistic temporary fixtures for all seven MCP verbs (`schema`, `run`, `operation-wait`, `read`, `find-files`, `grep`, and `grep-code`). The search cases exercise Atrium's native bundled-ripgrep-backed implementation for `find-files`, `grep`, and `grep-code`. Treat the resulting aggregate report as the measurement baseline for comparable before/after Speedify runs. Keep CLI `--perf` as the single-operation diagnostic path when you need a trace for one verb instead of the suite-level eval report.

## Examples

### `mcp-run`

```bash
atrium mcp-run node --perf -- --version
```

### `mcp-read`

```bash
atrium mcp-read /tmp/file.txt --perf
```

### `mcp-grep`

```bash
atrium mcp-grep /tmp --query alpha --max 5 --perf
```

Search reruns accept the same scope controls as their MCP verbs. Use `--queries`, `--regex`, `--glob`, and `--exclude` when those arguments shaped the original request. `mcp-find-files` also accepts `--exclude`.

Search traces separate the native operation into a timed `search` span and a timed `normalize` span. The `search` span includes `ripgrepMetrics`:

- `spawnCallMs`: synchronous time spent creating the child process.
- `spawnReadyMs`: time from the spawn call returning until Node reports the child as spawned.
- `childRunMs`: time from the spawned event until the child closes.
- `childTotalMs`: total time from starting the spawn call until the child closes.
- `parseMs`: time spent parsing ripgrep output after the child closes.

These clocks and lifecycle measurements are enabled only for CLI `--perf` reruns. Normal MCP search does not sample them.

### `mcp-operation-wait`

```bash
atrium mcp-operation-wait <operationId> --perf
```

## How to interpret the results

- If the normal MCP response is enough for routing, keep using it.
- If you need latency details, queue behavior, and a trace for one operation, rerun that operation through the Atrium CLI with `--perf`.
- If you need a shared benchmark view across verbs, read the benchmark-owned aggregate report and compare the per-operation cases inside it.

This workflow is the one future Copilot CLI sessions should follow when they need to investigate Atrium MCP verb performance without reading source.
