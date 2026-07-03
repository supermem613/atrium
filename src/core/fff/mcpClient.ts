import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  type FffLaunchArgs,
  type FffRootOptions,
  type FffToolCallArguments,
  type FffToolCallResult,
  type FffToolDefinition,
  type FffToolListResult,
} from './types.js';

export interface FffMcpClientAdapter {
  connect(transport: unknown): Promise<void>;
  initialize?(): Promise<void>;
  listTools(): Promise<FffToolListResult>;
  callTool(request: { name: string; arguments?: FffToolCallArguments }): Promise<FffToolCallResult>;
  close(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface FffMcpTransportLike {
  close?(): Promise<void>;
}

export interface FffMcpClientFactoryOptions {
  clientFactory?: (transport: FffMcpTransportLike) => FffMcpClientAdapter;
  transportFactory?: (launchArgs: FffLaunchArgs) => FffMcpTransportLike;
}

export class FffMcpClient {
  private client: FffMcpClientAdapter | null = null;
  private transport: FffMcpTransportLike | null = null;
  private connected = false;

  constructor(private readonly options: FffMcpClientFactoryOptions = {}) {}

  async connect(rootOptions: FffRootOptions = {}): Promise<void> {
    const launchArgs = toLaunchArgs(rootOptions);
    const transport = this.options.transportFactory
      ? this.options.transportFactory(launchArgs)
      : createDefaultTransport(launchArgs);
    this.transport = transport;

    const client = this.options.clientFactory
      ? this.options.clientFactory(transport)
      : createDefaultClient();
    this.client = client;

    await client.connect(transport);
    await client.initialize?.();
    this.connected = true;
  }

  async initialize(): Promise<void> {
    this.ensureConnected();
    await this.client?.initialize?.();
  }

  async listTools(): Promise<FffToolDefinition[]> {
    this.ensureConnected();
    const result = await this.client!.listTools();
    return Array.isArray(result?.tools)
      ? result.tools.map((tool) => normalizeToolDefinition(tool))
      : [];
  }

  async callTool(name: string, args: FffToolCallArguments = {}): Promise<FffToolCallResult> {
    this.ensureConnected();
    const result = await this.client!.callTool({ name, arguments: args });
    return normalizeToolCallResult(result);
  }

  async close(): Promise<void> {
    if (this.client) {
      if (typeof this.client.close === 'function') {
        await this.client.close();
      } else if (this.client.dispose) {
        await this.client.dispose();
      }
    }

    if (this.transport && typeof this.transport.close === 'function') {
      await this.transport.close();
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  async dispose(): Promise<void> {
    await this.close();
  }

  private ensureConnected(): void {
    if (!this.connected || !this.client) {
      throw new Error('MCP client is not connected');
    }
  }
}

export function createFffMcpClient(options: FffMcpClientFactoryOptions = {}): FffMcpClient {
  return new FffMcpClient(options);
}

function createDefaultClient(): FffMcpClientAdapter {
  const client = new Client({ name: 'fff-mcp-client', version: '0.0.0' }, { capabilities: {} } as never);
  return {
    connect: (transport: unknown) => client.connect(transport as Parameters<Client['connect']>[0]),
    listTools: () => client.listTools() as Promise<FffToolListResult>,
    callTool: (request: { name: string; arguments?: FffToolCallArguments }) => client.callTool({
      name: request.name,
      arguments: request.arguments ?? {},
    }, CallToolResultSchema) as Promise<FffToolCallResult>,
    close: () => client.close(),
  };
}

function createDefaultTransport(launchArgs: FffLaunchArgs): FffMcpTransportLike {
  return new StdioClientTransport({
    command: launchArgs.command,
    args: launchArgs.args,
    cwd: launchArgs.cwd,
  }) as unknown as FffMcpTransportLike;
}

function toLaunchArgs(rootOptions: FffRootOptions): FffLaunchArgs {
  return {
    command: rootOptions.command ?? 'node',
    args: rootOptions.args ?? [],
    cwd: rootOptions.cwd ?? rootOptions.rootDir,
  };
}

function normalizeToolDefinition(tool: FffToolDefinition | Record<string, unknown>): FffToolDefinition {
  return {
    name: typeof tool?.name === 'string' ? tool.name : '',
    description: typeof tool?.description === 'string' ? tool.description : undefined,
    inputSchema: isRecord(tool?.inputSchema) ? (tool.inputSchema as Record<string, unknown>) : undefined,
  };
}

function normalizeToolCallResult(result: FffToolCallResult | Record<string, unknown> | undefined): FffToolCallResult {
  const content = Array.isArray(result?.content)
    ? result.content.map((part) => ({ ...part }))
    : [];

  return {
    content,
    isError: typeof result?.isError === 'boolean' ? result.isError : undefined,
    ...(result && isRecord(result) ? result : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
