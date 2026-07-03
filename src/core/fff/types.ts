export interface FffRootOptions {
  rootDir?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

export interface FffLaunchArgs {
  command: string;
  args: string[];
  cwd?: string;
}

export interface FffToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface FffToolContentPart {
  type: string;
  text?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface FffToolCallArguments {
  [key: string]: unknown;
}

export interface FffToolCallResult {
  content: FffToolContentPart[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface FffToolListResult {
  tools: FffToolDefinition[];
}
