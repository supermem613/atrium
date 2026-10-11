import assert from "node:assert/strict";
import { test } from "node:test";
import { deserializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { FrameEnvelope, type FrameResult } from "../../src/mcp/frameEnvelope.js";

function collectFrames(maxFrameBytes: number, chunks: Uint8Array[]): FrameResult[] {
  const frames: FrameResult[] = [];
  const envelope = new FrameEnvelope({
    maxFrameBytes,
    onFrame: (frame) => {
      frames.push(frame); 
    },
  });
  for (const chunk of chunks) {
    envelope.push(chunk);
  }
  return frames;
}

function request(id: string | number, extra: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "test",
    params: { padding: extra },
    id,
  });
}

function oversizedRequest(id: string | number, extra = "x".repeat(256)): string {
  return `${request(id, extra)}\n`;
}

test("frames before the budget are accepted at L-1 and L, while L+1 is rejected by id", () => {
  const exact = request(11, "x".repeat(32));
  const frames: FrameResult[] = [];
  const envelope = new FrameEnvelope({
    maxFrameBytes: Buffer.byteLength(exact),
    onFrame: (frame) => {
      frames.push(frame); 
    },
  });

  envelope.push(Buffer.from(`${request(10, "x".repeat(31))}\n${exact}\n${request(12, "x".repeat(33))}\n`));

  assert.equal(frames[0]?.kind, "message");
  assert.equal(frames[1]?.kind, "message");
  assert.deepEqual(frames[2], {
    kind: "oversized",
    code: "FrameTooLarge",
    diagnostic: `JSON-RPC frame exceeded the ${Buffer.byteLength(exact)}-byte stdio frame budget`,
    requestId: 12,
  });
});

test("LF framing survives one-byte, random, and CRLF chunk boundaries", () => {
  const first = `${request(1, "a")}\r\n`;
  const second = `${request(2, "b")}\n`;
  const input = Buffer.from(first + second);
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < input.length; index += 1) {
    chunks.push(input.subarray(index, index + 1));
  }
  const frames = collectFrames(1024, chunks);

  assert.deepEqual(frames.map((frame) => frame.kind), ["message", "message"]);
  assert.deepEqual(
    frames.map((frame) => frame.kind === "message" && "id" in frame.message ? frame.message.id : undefined),
    [1, 2],
  );
});

test("coalesced valid frames are framed before aggregate accounting", () => {
  const one = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
  const two = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 2 });
  assert.ok(Buffer.byteLength(one) < 64);
  assert.ok(Buffer.byteLength(two) < 64);
  assert.ok(Buffer.byteLength(`${one}\n${two}`) > 64);

  const frames = collectFrames(64, [Buffer.from(`${one}\n${two}\n`)]);
  assert.deepEqual(
    frames.map((frame) => frame.kind === "message" && "id" in frame.message ? frame.message.id : undefined),
    [1, 2],
  );
});

test("every split point and deterministic mixed-size chunks preserve frame recovery", () => {
  const input = Buffer.from(
    `${oversizedRequest("late-😀")}${request(2, "small")}\r\n${oversizedRequest(3)}`,
  );
  const expected = ["late-😀", 2, 3];
  const ids = (frames: FrameResult[]) => frames.map((frame) =>
    frame.kind === "oversized" ? frame.requestId : frame.kind === "message" && "id" in frame.message ? frame.message.id : undefined);
  for (let split = 1; split < input.length; split += 1) {
    assert.deepEqual(ids(collectFrames(128, [input.subarray(0, split), input.subarray(split)])), expected);
  }
  let state = 1;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < input.length;) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const end = Math.min(input.length, offset + 1 + state % 128);
    chunks.push(input.subarray(offset, end));
    offset = end;
  }
  assert.deepEqual(ids(collectFrames(128, chunks)), expected);
});

test("late root ids recover after oversized params and use last-wins escaped metadata", () => {
  const frame = [
    '{"jsonrpc":"2.0","method":"test","id":1,',
    `"params":{"nested":{"id":999},"stdin":"${"x".repeat(256)}"},`,
    String.raw`"\u0069d":"escaped\"id"}`,
    "\n",
  ].join("");
  const frames = collectFrames(128, [Buffer.from(frame)]);

  assert.deepEqual(frames[0], {
    kind: "oversized",
    code: "FrameTooLarge",
    diagnostic: "JSON-RPC frame exceeded the 128-byte stdio frame budget",
    requestId: "escaped\"id",
  });
});

test("numeric ids preserve zero, negative, and exponent values", () => {
  const ids = [0, -7, 1.25e2];
  const frames = collectFrames(32, [Buffer.from(ids.map((id) => oversizedRequest(id)).join(""))]);

  assert.deepEqual(
    frames.map((frame) => frame.kind === "oversized" ? frame.requestId : undefined),
    ids,
  );
});

test("oversized recovery preserves escaped surrogate pairs and lone surrogate ids", () => {
  for (const id of [String.raw`"\ud83d\ude00"`, String.raw`"\ud800"`, String.raw`"a\udc00b"`]) {
    const json = `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":${id}}`;
    const frames = collectFrames(64, Array.from(Buffer.from(`${json}\n`), (byte) => Uint8Array.of(byte)));
    assert.equal(frames[0]?.kind === "oversized" ? frames[0].requestId : undefined, JSON.parse(id));
  }
});

test("metadata depth exceeding an admitted frame stays bounded and a later frame recovers", () => {
  const frames: FrameResult[] = [];
  const envelope = new FrameEnvelope({ maxFrameBytes: 64, onFrame: (frame) => {
    frames.push(frame); 
  } });
  envelope.push(Buffer.from(`{"jsonrpc":"2.0","method":"test","params":${"[".repeat(512)}0${"]".repeat(512)},"id":9}\n`));
  envelope.push(Buffer.from('{"jsonrpc":"2.0","method":"ping","id":10}\n'));
  assert.deepEqual(frames.map((frame) => frame.kind), ["oversized", "message"]);
  assert.ok(envelope.stats.peakStructuralDepth <= 32);
  assert.equal(frames[1]?.kind === "message" && "id" in frames[1].message ? frames[1].message.id : undefined, 10);
});

test("oversized metadata follows the SDK envelope schema across streamed JSON fixtures", () => {
  const fixtures = [
    {
      name: "late integer id after a large method",
      json: `{"jsonrpc":"2.0","method":"${"m".repeat(256)}","params":{"padding":"${"x".repeat(256)}"},"id":17}`,
    },
    {
      name: "escaped root id key and split UTF-8 string id",
      json: `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"\\u0069d":"a😀\\"b"}`,
    },
    {
      name: "escaped jsonrpc key",
      json: `{"\\u006asonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":18}`,
    },
    {
      name: "last duplicate id wins",
      json: `{"jsonrpc":"2.0","method":"test","id":"discard-${"x".repeat(96)}","params":{"padding":"${"x".repeat(256)}"},"id":23}`,
    },
    {
      name: "large integral numeric id follows the SDK number schema",
      json: `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":9007199254740992}`,
    },
    {
      name: "fractional numeric ids are not SDK request ids",
      json: `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":1.5}`,
    },
    {
      name: "last duplicate fractional id invalidates an earlier integer id",
      json: `{"jsonrpc":"2.0","method":"test","id":24,"params":{"padding":"${"x".repeat(256)}"},"id":2.5}`,
    },
    {
      name: "last duplicate non-string method invalidates an earlier method",
      json: `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":25,"method":null}`,
    },
    {
      name: "malformed numeric id is not recoverable",
      json: `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":01}`,
    },
    {
      name: "malformed escape is not recoverable",
      json: `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}\\x"},"id":26}`,
    },
    {
      name: "malformed trailing comma is not recoverable",
      json: `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}",},"id":27}`,
    },
    {
      name: "non-JSON whitespace is not a valid request envelope",
      json: `{"jsonrpc":\u00a0"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":28}`,
    },
    {
      name: "a leading BOM is not a valid JSON request",
      json: `\ufeff{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}"},"id":29}`,
    },
  ] as const;

  for (const fixture of fixtures) {
    let expectedId: string | number | undefined;
    try {
      JSON.parse(fixture.json);
      const parsed = deserializeMessage(fixture.json);
      expectedId = "method" in parsed && "id" in parsed ? parsed.id : undefined;
    } catch {
      expectedId = undefined;
    }

    const bytes = Buffer.from(`${fixture.json}\n`);
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const frames = collectFrames(64, chunks);
    assert.equal(frames.length, 1, fixture.name);
    assert.equal(frames[0]?.kind, "oversized", fixture.name);
    if (frames[0]?.kind === "oversized") {
      assert.equal(frames[0].requestId, expectedId, fixture.name);
    }
  }
});

test("notifications and responses are diagnosed without synthetic replies", () => {
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "test", params: { padding: "x".repeat(256) } });
  const response = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { padding: "x".repeat(256) } });
  const frames = collectFrames(64, [Buffer.from(`${notification}\n${response}\n`)]);

  assert.equal(frames.length, 2);
  assert.equal(frames.every((frame) => frame.kind === "oversized" && frame.requestId === undefined), true);
});

test("oversized array parameters recover while malformed trailing commas do not", () => {
  const valid = JSON.stringify({
    jsonrpc: "2.0",
    method: "test",
    params: [{ padding: "x".repeat(256) }, 1, true],
    id: 21,
  });
  const malformed = `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}",},"id":22}`;
  const frames = collectFrames(64, [Buffer.from(`${valid}\n${malformed}\n`)]);

  assert.deepEqual(frames.map((frame) => frame.kind === "oversized" ? frame.requestId : undefined), [21, undefined]);
  assert.equal(frames[1]?.kind, "oversized");
  if (frames[1]?.kind === "oversized") {
    assert.match(frames[1].diagnostic, /Parser cannot parse input/);
  }
});

test("malformed, truncated, blank, null, array, and wrong-envelope frames remain diagnosable", () => {
  const frames = collectFrames(1024, [
    Buffer.from("\nnull\n[]\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"),
  ]);
  assert.equal(frames.length, 4);
  assert.deepEqual(frames.map((frame) => frame.kind), ["malformed", "malformed", "malformed", "message"]);

  const truncated: FrameResult[] = [];
  const envelope = new FrameEnvelope({ onFrame: (frame) => {
    truncated.push(frame); 
  } });
  envelope.push(Buffer.from("{\"jsonrpc\":\"2.0\",\"method\":\"test\",\"id\":1"));
  envelope.end();
  assert.equal(truncated[0]?.kind, "malformed");
});

test("UTF-8 splits and invalid bytes follow the SDK replacement policy", () => {
  const valid = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "test", params: { value: "😀" }, id: 1 })}\n`);
  const split = valid.indexOf(Buffer.from("😀"));
  const frames = collectFrames(1024, [
    valid.subarray(0, split + 1),
    valid.subarray(split + 1),
  ]);
  assert.equal(frames[0]?.kind, "message");

  const invalid = Buffer.from("{\"jsonrpc\":\"2.0\",\"method\":\"test\",\"params\":{\"value\":\"");
  const suffix = Buffer.from("\"},\"id\":2}\n");
  const invalidFrames = collectFrames(1024, [Buffer.concat([invalid, Buffer.from([0xff]), suffix])]);
  assert.equal(invalidFrames[0]?.kind, "message");
  if (invalidFrames[0]?.kind === "message") {
    const params = "params" in invalidFrames[0].message
      ? invalidFrames[0].message.params as { value?: string }
      : undefined;
    assert.equal(params?.value, "�");
  }
});

test("retained frame, metadata, and structural counters stay within the selected budget", () => {
  const envelope = new FrameEnvelope({ maxFrameBytes: 64, onFrame: () => {} });
  assert.equal(envelope.stats.currentRetainedBytes, 0);
  assert.equal(envelope.stats.currentMetadataBytes, 0);
  envelope.push(Buffer.from(oversizedRequest(1, "x".repeat(4096))));
  const stats = envelope.stats;

  assert.ok(stats.peakRetainedBytes <= 64);
  assert.ok(stats.peakMetadataBytes <= 2 * 64 + Buffer.byteLength("2.0", "utf16le"));
  assert.ok(stats.peakStructuralDepth <= 32);
});

test("metadata counters measure retained values and release overwritten ids", () => {
  const discardedId = "i".repeat(700);
  const frames: FrameResult[] = [];
  const envelope = new FrameEnvelope({
    maxFrameBytes: 1024,
    onFrame: (frame) => {
      frames.push(frame); 
    },
  });

  test("recovery ids reserve enough wire space for the error response", () => {
    const limit = 10 * 1024 * 1024;
    const id = "i".repeat(limit - 1);
    const frames = collectFrames(limit, [Buffer.from(`${request(id, "x")}\n${request(2, "small")}\n`)]);
    assert.deepEqual(frames.map((frame) => frame.kind), ["oversized", "message"]);
    assert.equal(frames[0]?.kind === "oversized" ? frames[0].requestId : undefined, undefined);
    assert.equal(frames[1]?.kind === "message" && "id" in frames[1].message ? frames[1].message.id : undefined, 2);
  });
  const frame = `{"jsonrpc":"2.0","method":"${"m".repeat(2048)}","id":"${discardedId}","params":{"padding":"${"x".repeat(2048)}"},"id":7}`;

  envelope.push(Buffer.from(frame));
  assert.equal(envelope.stats.currentRetainedBytes, 0);
  assert.equal(envelope.stats.currentMetadataBytes, Buffer.byteLength("2.0", "utf16le") + Buffer.byteLength("7", "utf16le"));
  assert.equal(envelope.stats.peakMetadataBytes, Buffer.byteLength("2.0", "utf16le") + Buffer.byteLength(discardedId, "utf16le"));

  envelope.push(Buffer.from("\n"));
  assert.equal(envelope.stats.currentMetadataBytes, 0);
  assert.equal(frames[0]?.kind === "oversized" ? frames[0].requestId : undefined, 7);
});
