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

`path` is required. `startLine` defaults to `1`. Provide either `endLine` or `count`, not both. When neither is provided, Atrium serves up to 120 lines.

## Success

Successful reads return only the content contract:

```json
{
  "ok": true,
  "path": "C:\\repo\\sample.txt",
  "range": [2, 3],
  "meta": {
    "totalLines": 3,
    "bytes": 14,
    "timing": {
      "totalMs": 2,
      "statMs": 0,
      "readMs": 1,
      "sliceMs": 0,
      "materializeMs": 1,
      "contentBytes": 14
    },
    "cache": {
      "hit": false,
      "reason": "miss"
    }
  },
  "content": "two\nthree\n"
}
```

`meta.timing` captures the Atrium-internal read timing breakdown. `meta.timing.totalMs` is the total read time, `statMs` and `readMs` cover file stat and file reads, `sliceMs` covers the range slicing step, and `materializeMs` covers turning the read result into the response shape. `meta.timing.contentBytes` reports the number of bytes in the content payload returned to the caller. `meta.timing` measures Atrium-internal read work and does not include Copilot MCP transport, pre-tool hooks, post-tool hooks, model latency, or agent scheduling; that MCP and hook overhead is excluded from the timing measurements.

For repeated unchanged-file reads, `meta.cache.hit` reports whether Atrium served the read from cache and `meta.cache.reason` explains why. On a cache hit for an unchanged file, `meta.cache.hit` is `true` and `meta.cache.reason` is `"same-file"`.

`range + meta.totalLines` is the paging signal. EOF is `range[1] === meta.totalLines`. More content exists when `range[1] < meta.totalLines`. If the requested range goes past EOF, Atrium returns the served range instead of failing.

Large content uses Atrium's existing file-value contract:

```json
{
  "ok": true,
  "path": "C:\\repo\\large.txt",
  "range": [1, 500],
  "meta": { "totalLines": 900, "bytes": 50000 },
  "content": { "file": "C:\\Users\\marcusm\\AppData\\Local\\Temp\\atrium\\reads\\...\\content.txt", "bytes": 12000 }
}
```

The inline threshold is 8192 bytes. Larger served content is written as `{ "file": "...", "bytes": n }`.

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

Statuses are `not-found`, `unsupported`, and `invalid-args`. `status` and `hint` are for non-content outcomes only.
