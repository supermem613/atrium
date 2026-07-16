# Read primitive

`atrium.read` reads UTF-8 text files through the MCP server without using Copilot CLI `view_range`.

## Input

```json
{
  "path": "C:\\repo\\src\\server.ts",
  "startLine": 2,
  "endLine": 99
}
```

`path` is required. `startLine` defaults to `1`. Provide either `endLine` or `count`, not both. When neither is provided, Atrium serves up to 120 lines. `startLine`, `endLine`, `count`, `startByte`, and `countBytes` each accept either an integer or a numeric string such as `"2"`.

### Byte paging inputs

Byte paging uses `startByte` and `countBytes` instead of line inputs. `startByte` and `countBytes` are 0-based half-open byte paging inputs: `startByte` is the first byte to return and `countBytes` is the number of bytes to return in the page, so the page covers bytes `[startByte, startByte + countBytes)`. `startByte`/`countBytes` are mutually exclusive with `startLine`, `endLine`, and `count`. `snapshot` is an optional opaque continuation token from a prior byte read. It protects against stale continuation by rejecting a request if the source has been mutated since the snapshot was created; that mutation rejection returns `ok: false`, `status: "mutation_rejected"`, and no stale content.

## Success

Successful reads return only the content contract:

```json
{
  "ok": true,
  "path": "C:\\repo\\sample.txt",
  "timingMs": 2,
  "range": [2, 3],
  "meta": {
    "totalLines": 3,
    "bytes": 14,
    "cache": {
      "hit": false,
      "reason": "miss"
    }
  },
  "content": "two\nthree\n"
}
```

`timingMs` is how long the whole read call took, in milliseconds. It measures Atrium-internal read work and does not include Copilot MCP transport, pre-tool hooks, post-tool hooks, model latency, or agent scheduling; that MCP and hook overhead is excluded. The per-phase breakdown (`statMs`, `readMs`, `sliceMs`, `materializeMs`, `contentBytes`) is not part of the default response. It is calculated and reported only on CLI `--perf` reruns, matching the search perf metadata gating.

For repeated unchanged-file reads, `meta.cache.hit` reports whether Atrium served the read from cache and `meta.cache.reason` explains why. On a cache hit for an unchanged file, `meta.cache.hit` is `true` and `meta.cache.reason` is `"same-file"`.

`range + meta.totalLines` is the paging signal. EOF is `range[1] === meta.totalLines`. More content exists when `range[1] < meta.totalLines`. If the requested range goes past EOF, Atrium returns the served range instead of failing.

Large content uses Atrium's existing file-value contract:

```json
{
  "ok": true,
  "path": "C:\\repo\\large.txt",
  "timingMs": 6,
  "range": [1, 500],
  "meta": { "totalLines": 900, "bytes": 50000 },
  "content": { "file": "C:\\Users\\marcusm\\AppData\\Local\\Temp\\atrium\\reads\\...\\content.txt", "bytes": 12000 }
}
```
The inline threshold is 8192 bytes. Larger served content is written as `{ "file": "...", "bytes": n }`.

### Byte paging success

Byte reads return the normal success shape plus `byteRange`, `meta.totalBytes`, `snapshot`, and `nextRead`. A response looks like this:

```json
{
  "ok": true,
  "path": "C:\\repo\\sample.txt",
  "range": [0, 4],
  "byteRange": [0, 4],
  "meta": {
    "totalBytes": 13,
    "cache": {
      "hit": false,
      "reason": "miss"
    }
  },
  "snapshot": "snap-001",
  "content": "Hell",
  "nextRead": {
    "startByte": 4,
    "countBytes": 4
  }
}
```

The inline guarantee is that byte pages are inline strings rather than file-backed values. `nextRead` is `null` at EOF; otherwise it is the next request to issue. Byte paging is UTF-8 safe: pages do not split codepoints, valid non-EOF pages make non-zero progress, and `startByte` must be on a codepoint boundary. The mutation rejection status is `mutation_rejected` and no stale content is returned.

A worked paging example follows `nextRead` until EOF. Start with `startByte: 0, countBytes: 4` and `content: "Hell"`, then continue with `startByte: 4, countBytes: 4` and `content: "o, w"`, then `startByte: 8, countBytes: 4` and `content: "orld"`, and finally `startByte: 12, countBytes: 4` with `content: "!"` and `nextRead: null`.

## Non-content outcomes

Expected failures return `ok:false` instead of throwing MCP tool errors:

```json
{
  "ok": false,
  "status": "not-found",
  "path": "C:\\repo\\missing.txt",
  "hint": "nearest existing ancestor: C:\\repo"
}
```

Statuses are `not-found`, `unsupported`, `invalid-args`, and `mutation_rejected`. `status` and `hint` are for non-content outcomes only.
