import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { RecoveringStdioTransport } from "../../src/mcp/recoveringStdioTransport.js";

const RESPONSE_TIMEOUT_MS = 5_000;

async function waitFor<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await new Promise<void>((resolve, reject) => {
    const poll = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(message));
      } else {
        setImmediate(poll);
      }
    };
    poll();
  });
}

function readLine(stream: PassThrough): () => Promise<string> {
  stream.setEncoding("utf8");
  let buffered = "";
  const waiters: Array<(line: string) => void> = [];
  const drain = () => {
    while (waiters.length > 0) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      waiters.shift()?.(line);
    }
  };
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    drain();
  });
  return () => new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for transport output")), RESPONSE_TIMEOUT_MS);
    waiters.push((line) => {
      clearTimeout(timeout);
      resolve(line);
    });
    drain();
  });
}

function request(id: string | number, method = "tools/list", params: Record<string, unknown> = {}): Buffer {
  return Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`);
}

test("recoverable oversized requests receive one correlated error and later messages arrive", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RecoveringStdioTransport(stdin, stdout, { maxFrameBytes: 128 });
  const nextLine = readLine(stdout);
  const messages: unknown[] = [];
  const errors: string[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error.message);
  await transport.start();

  stdin.write(Buffer.from(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { padding: "x".repeat(256) } },
    id: 100,
  })}\n`));
  const response = JSON.parse(await nextLine()) as {
    id: number;
    error?: { code?: number; data?: { code?: string } };
  };
  assert.equal(response.id, 100);
  assert.equal(response.error?.code, -32600);
  assert.equal(response.error?.data?.code, "FrameTooLarge");

  const nextMessage = new Promise<void>((resolve) => {
    transport.onmessage = () => {
      messages.push("received");
      resolve();
    };
  });
  stdin.write(request(101));
  await nextMessage;
  assert.deepEqual(messages, ["received"]);
  assert.equal(errors.some((error) => error.includes("FrameTooLarge")), true);
  assert.equal(stdin.listenerCount("data"), 1);

  await transport.close();
  await transport.close();
  assert.equal(stdin.listenerCount("data"), 0);
  await assert.rejects(transport.send({ jsonrpc: "2.0", id: 102, result: {} }));
});

test("start preserves the SDK single-start error contract", async () => {
  const transport = new RecoveringStdioTransport(new PassThrough(), new PassThrough());
  await transport.start();

  await assert.rejects(
    transport.start(),
    /StdioServerTransport already started! If using Server class, note that connect\(\) calls start\(\) automatically\./,
  );
  await transport.close();
});

test("large coalesced input yields to other work while delivering every frame", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RecoveringStdioTransport(stdin, stdout);
  const frame = request(1);
  const count = Math.ceil(stdin.readableHighWaterMark / frame.length) + 1;
  let received = 0;
  let receivedAtYield: number | undefined;
  let resolveYield: () => void = () => {};
  const yielded = new Promise<void>((resolve) => {
    resolveYield = resolve; 
  });
  transport.onmessage = () => {
    received += 1;
    if (received === 1) {
      setImmediate(() => {
        receivedAtYield = received;
        resolveYield();
      });
    }
  };
  await transport.start();
  stdin.write(Buffer.concat(Array.from({ length: count }, () => frame)));
  await waitFor(yielded, "coalesced input prevented event-loop progress");
  assert.ok(receivedAtYield !== undefined && receivedAtYield < count);
  await waitForCondition(() => received === count, "input resumption lost frames");
  assert.equal(received, count);
  await transport.close();
});

test("notifications and responses do not create recovery replies", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RecoveringStdioTransport(stdin, stdout, { maxFrameBytes: 64 });
  const messages: unknown[] = [];
  const errors: string[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error.message);
  await transport.start();

  const notification = JSON.stringify({ jsonrpc: "2.0", method: "test", params: { padding: "x".repeat(256) } });
  const response = JSON.stringify({ jsonrpc: "2.0", id: 8, result: { padding: "x".repeat(256) } });
  const validMessage = new Promise<void>((resolve) => {
    transport.onmessage = (message) => {
      messages.push(message);
      resolve();
    };
  });
  stdin.write(Buffer.from(`${notification}\n${response}\n${JSON.stringify({ jsonrpc: "2.0", method: "test", id: 9 })}\n`));

  await validMessage;
  assert.equal(messages.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(stdout.read(), null);
  await transport.close();
});

test("repeated faults and reused ids do not prevent a later valid frame", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RecoveringStdioTransport(stdin, stdout, { maxFrameBytes: 64 });
  const nextLine = readLine(stdout);
  const errors: string[] = [];
  const validMessage = new Promise<void>((resolve) => {
    transport.onmessage = (message) => {
      if ("id" in message && message.id === 44) {
        resolve();
      }
    };
  });
  transport.onerror = (error) => errors.push(error.message);
  await transport.start();

  const oversized = JSON.stringify({ jsonrpc: "2.0", method: "test", params: { padding: "x".repeat(256) }, id: 44 });
  const malformed = `{"jsonrpc":"2.0","method":"test","params":{"padding":"${"x".repeat(256)}",},"id":45}`;
  stdin.write(Buffer.from(`${oversized}\n${malformed}\n${oversized}\n${JSON.stringify({ jsonrpc: "2.0", method: "test", id: 44 })}\n`));

  const replies = [JSON.parse(await nextLine()), JSON.parse(await nextLine())] as Array<{
    id: number;
    error?: { data?: { code?: string } };
  }>;
  await validMessage;
  assert.deepEqual(replies.map((reply) => [reply.id, reply.error?.data?.code]), [[44, "FrameTooLarge"], [44, "FrameTooLarge"]]);
  assert.equal(errors.filter((error) => error.includes("FrameTooLarge")).length, 3);
  await transport.close();
});

test("input end and error are terminal, settle pending writes, and notify close once", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const transport = new RecoveringStdioTransport(stdin, stdout);
  let closeCount = 0;
  const errors: string[] = [];
  transport.onclose = () => {
    closeCount += 1;
  };
  transport.onerror = (error) => errors.push(error.message);
  await transport.start();

  stdin.emit("error", new Error("injected stdin failure"));
  stdin.emit("end");
  assert.equal(closeCount, 1);
  assert.ok(errors.some((error) => error.includes("injected stdin failure")));
  await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, result: {} }));
});

test("destroying stdin mid-frame reports the input error, truncated frame, and one close", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RecoveringStdioTransport(stdin, stdout);
  const errors: string[] = [];
  let closeCount = 0;
  transport.onerror = (error) => errors.push(error.message);
  transport.onclose = () => {
    closeCount += 1;
  };
  await transport.start();

  stdin.write(Buffer.from('{"jsonrpc":"2.0","method":"test","id":1'));
  stdin.destroy(new Error("injected mid-frame stdin failure"));
  await waitForCondition(() => closeCount === 1, "stdin destroy did not close the transport");
  stdin.emit("end");
  stdin.emit("close");

  assert.deepEqual(errors, [
    "injected mid-frame stdin failure",
    "MalformedFrame: stdin ended before the JSON-RPC frame delimiter",
  ]);
  assert.equal(closeCount, 1);
});

test("independent transports keep their own callbacks and buffers", async () => {
  const firstInput = new PassThrough();
  const firstOutput = new PassThrough();
  const secondInput = new PassThrough();
  const secondOutput = new PassThrough();
  const first = new RecoveringStdioTransport(firstInput, firstOutput);
  const second = new RecoveringStdioTransport(secondInput, secondOutput);
  const firstMessages: unknown[] = [];
  const secondMessages: unknown[] = [];
  first.onmessage = (message) => firstMessages.push(message);
  second.onmessage = (message) => secondMessages.push(message);
  await Promise.all([first.start(), second.start()]);

  firstInput.write(request(1));
  secondInput.write(request(2));
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    const poll = () => {
      if (firstMessages.length === 1 && secondMessages.length === 1) {
        resolve();
      } else if (Date.now() < deadline) {
        setImmediate(poll);
      } else {
        throw new Error("timed out waiting for independent transports");
      }
    };
    poll();
  });
  assert.equal((firstMessages[0] as { id: number }).id, 1);
  assert.equal((secondMessages[0] as { id: number }).id, 2);
  await Promise.all([first.close(), second.close()]);
});

test("write callbacks and drain control output progress and input backpressure", async () => {
  const stdin = new PassThrough();
  const callbacks: Array<(error?: Error | null) => void> = [];
  const writes: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  const write = stdout.write.bind(stdout);
  stdout.write = ((chunk: Uint8Array, callback: (error?: Error | null) => void) => {
    write(chunk, callback);
    return false;
  }) as typeof stdout.write;
  const transport = new RecoveringStdioTransport(stdin, stdout);
  await transport.start();

  const first = transport.send({ jsonrpc: "2.0", id: 1, result: {} });
  const second = transport.send({ jsonrpc: "2.0", id: 2, result: {} });
  assert.equal(writes.length, 1);
  assert.equal(stdin.isPaused(), true);

  callbacks[0]?.();
  assert.equal(writes.length, 1);
  stdout.emit("drain");
  await first;
  assert.equal(writes.length, 2);

  callbacks[1]?.();
  stdout.emit("drain");
  await second;
  await transport.close();
});

test("synchronous, callback, and emitted write failures reject sends and close once", async () => {
  const failures = [
    {
      name: "synchronous",
      createOutput: () => {
        const output = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        output.write = (() => {
          throw new Error("sync EPIPE");
        }) as typeof output.write;
        return output;
      },
    },
    {
      name: "callback",
      createOutput: () => new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error("callback EPIPE"));
        },
      }),
    },
    {
      name: "emitted",
      createOutput: () => new Writable({
        write() {
          // Keep the active write pending until the output emits its terminal error.
        },
      }),
    },
  ];

  for (const failure of failures) {
    const stdin = new PassThrough();
    const stdout = failure.createOutput();
    const transport = new RecoveringStdioTransport(stdin, stdout);
    let closeCount = 0;
    transport.onclose = () => {
      closeCount += 1;
    };
    await transport.start();

    const pending = transport.send({ jsonrpc: "2.0", id: 3, result: {} });
    if (failure.name === "emitted") {
      stdout.emit("error", new Error("emitted EPIPE"));
    }
    await assert.rejects(pending, /EPIPE/);
    assert.equal(closeCount, 1);
    await transport.close();
    assert.equal(closeCount, 1);
  }
});

test("a write callback error followed by its emitted error is diagnosed once", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("paired callback EPIPE"));
    },
  });
  const transport = new RecoveringStdioTransport(stdin, stdout);
  const errors: string[] = [];
  let closeCount = 0;
  transport.onerror = (error) => errors.push(error.message);
  transport.onclose = () => {
    closeCount += 1;
  };
  await transport.start();
  const outputClosed = new Promise<void>((resolve) => {
    stdout.once("close", resolve);
  });

  await assert.rejects(
    transport.send({ jsonrpc: "2.0", id: 4, result: {} }),
    /paired callback EPIPE/,
  );
  await waitFor(outputClosed, "writable did not complete its callback-error lifecycle");

  assert.deepEqual(errors, ["paired callback EPIPE"]);
  assert.equal(closeCount, 1);
});

test("close during queued sends settles every write and permits no later output", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({
    write() {
      // Keep the first write pending until the transport closes.
    },
  });
  const transport = new RecoveringStdioTransport(stdin, stdout);
  await transport.start();

  const first = transport.send({ jsonrpc: "2.0", id: 10, result: {} });
  const second = transport.send({ jsonrpc: "2.0", id: 11, result: {} });
  await transport.close();

  await assert.rejects(first, /closed/);
  await assert.rejects(second, /closed/);
  assert.equal(stdout.listenerCount("error"), 1);
  stdout.emit("close");
  assert.equal(stdout.listenerCount("error"), 0);
});

// Keep these tests top-level. Nesting them under another test caused Node 22
// to cancel them when the parent settled (CI run 38174353508).
test("a serialization failure rejects only that send and later output remains usable", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RecoveringStdioTransport(stdin, stdout);
  const nextLine = readLine(stdout);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await transport.start();
  await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, result: circular }), /circular/i);
  await transport.send({ jsonrpc: "2.0", id: 2, result: { recovered: true } });
  assert.deepEqual(JSON.parse(await nextLine()), { jsonrpc: "2.0", id: 2, result: { recovered: true } });
  await transport.close();
});

test("EOF drains the last coalesced input chunk before notifying close", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RecoveringStdioTransport(stdin, stdout);
  const frame = request(1);
  const count = Math.ceil(stdin.readableHighWaterMark / frame.length) + 1;
  let received = 0;
  let receivedAtClose = 0;
  transport.onmessage = () => {
    received += 1; 
  };
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => {
      receivedAtClose = received;
      resolve();
    };
  });
  await transport.start();
  stdin.end(Buffer.concat(Array.from({ length: count }, () => frame)));
  await waitFor(closed, "EOF did not complete transport lifecycle");
  assert.equal(receivedAtClose, count);
  await transport.close();
});

test("output close without an error settles pending sends and closes once", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({
    write() {
      // Keep the write pending so output close owns settlement.
    },
  });
  const transport = new RecoveringStdioTransport(stdin, stdout);
  let closeCount = 0;
  transport.onclose = () => {
    closeCount += 1;
  };
  await transport.start();

  const first = transport.send({ jsonrpc: "2.0", id: 20, result: {} });
  const second = transport.send({ jsonrpc: "2.0", id: 21, result: {} });
  stdout.emit("close");

  await assert.rejects(
    waitFor(first, "output close did not settle the first send", 500),
    /closed/,
  );
  await assert.rejects(
    waitFor(second, "output close did not settle the second send", 500),
    /closed/,
  );
  assert.equal(closeCount, 1);
});

test("slow output applies backpressure within one coalesced rejection chunk without false close", async () => {
  const maxFrameBytes = 128 * 1024;
  const stdin = new PassThrough();
  const responseIds: string[] = [];
  const stdout = new Writable({
    highWaterMark: 64,
    write(chunk, _encoding, callback) {
      const response = JSON.parse(Buffer.from(chunk).toString("utf8")) as { id: string };
      responseIds.push(response.id);
      setImmediate(callback);
    },
  });
  const transport = new RecoveringStdioTransport(stdin, stdout, { maxFrameBytes });
  let closeCount = 0;
  transport.onclose = () => {
    closeCount += 1;
  };
  transport.onerror = () => {};
  const finalMessage = new Promise<void>((resolve) => {
    transport.onmessage = (message) => {
      if ("id" in message && message.id === 9000) {
        resolve();
      }
    };
  });
  await transport.start();

  const ids = Array.from({ length: 112 }, (_, index) => `${index}-${"i".repeat(96 * 1024)}`);
  const rejectedFrames = ids.map((id) => JSON.stringify({
    jsonrpc: "2.0",
    method: "test",
    params: { padding: "x".repeat(40 * 1024) },
    id,
  }));
  const finalFrame = JSON.stringify({ jsonrpc: "2.0", method: "test", id: 9000 });
  stdin.write(Buffer.from(`${rejectedFrames.join("\n")}\n${finalFrame}\n`));

  await waitFor(finalMessage, "coalesced input starved the final valid frame", 15_000);
  await waitForCondition(
    () => responseIds.length === ids.length,
    "slow output did not flush every correlated rejection",
    15_000,
  );

  assert.deepEqual(responseIds, ids);
  assert.equal(closeCount, 0);
  await transport.close();
});
