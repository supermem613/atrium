import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFffMcpClient } from '../../src/core/fff/mcpClient.js';
import type {
  FffToolCallArguments,
  FffToolCallResult,
  FffToolListResult,
} from '../../src/core/fff/types.js';

class FakeTransport {
  public closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeMcpClient {
  public connectCalls: unknown[] = [];
  public initializeCount = 0;
  public listToolsCount = 0;
  public closeCount = 0;
  public callHistory: Array<{ name: string; args: FffToolCallArguments | undefined }> = [];

  constructor(
    private readonly listToolsResult: FffToolListResult = { tools: [] },
    private readonly callToolResult: FffToolCallResult = { content: [] },
    private readonly callToolError?: Error,
  ) {}

  async connect(transport: unknown): Promise<void> {
    this.connectCalls.push(transport);
  }

  async initialize(): Promise<void> {
    this.initializeCount += 1;
  }

  async listTools(): Promise<FffToolListResult> {
    this.listToolsCount += 1;
    return this.listToolsResult;
  }

  async callTool(request: { name: string; arguments?: FffToolCallArguments }): Promise<FffToolCallResult> {
    this.callHistory.push({ name: request.name, args: request.arguments });
    if (this.callToolError) {
      throw this.callToolError;
    }
    return this.callToolResult;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

test('listTools returns definitions from the underlying MCP client', async () => {
  const client = new FakeMcpClient({
    tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object' } }],
  });
  const transport = new FakeTransport();
  const wrappedClient = createFffMcpClient({
    clientFactory: () => client,
    transportFactory: () => transport,
  });

  await wrappedClient.connect({ command: 'node', args: ['server.js'] });
  const tools = await wrappedClient.listTools();

  assert.deepEqual(tools, [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object' } }]);
  assert.equal(client.listToolsCount, 1);
  assert.equal(client.initializeCount, 1);
  assert.equal(client.connectCalls[0], transport);
});

test('callTool forwards the tool name and arguments', async () => {
  const client = new FakeMcpClient(
    { tools: [] },
    { content: [{ type: 'text', text: 'pong' }], isError: false },
  );
  const wrappedClient = createFffMcpClient({
    clientFactory: () => client,
    transportFactory: () => new FakeTransport(),
  });

  await wrappedClient.connect({ command: 'node', args: ['server.js'] });
  const result = await wrappedClient.callTool('echo', { message: 'ping' });

  assert.deepEqual(result, { content: [{ type: 'text', text: 'pong' }], isError: false });
  assert.deepEqual(client.callHistory, [{ name: 'echo', args: { message: 'ping' } }]);
});

test('close closes the client and the transport', async () => {
  const client = new FakeMcpClient();
  const transport = new FakeTransport();
  const wrappedClient = createFffMcpClient({
    clientFactory: () => client,
    transportFactory: () => transport,
  });

  await wrappedClient.connect({ command: 'node', args: ['server.js'] });
  await wrappedClient.close();

  assert.equal(client.closeCount, 1);
  assert.equal(transport.closed, true);
});

test('errors from the underlying client are rethrown', async () => {
  const error = new Error('boom');
  const client = new FakeMcpClient({ tools: [] }, { content: [] }, error);
  const wrappedClient = createFffMcpClient({
    clientFactory: () => client,
    transportFactory: () => new FakeTransport(),
  });

  await wrappedClient.connect({ command: 'node', args: ['server.js'] });

  await assert.rejects(() => wrappedClient.callTool('echo'), /boom/);
});
