import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const inputSchema = {
  query: z.string().min(1),
  glob: z.string().min(1).optional(),
  exclude: z.string().min(1).optional(),
  max: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
};

interface SearchInput {
  query: string;
  glob?: string;
  exclude?: string;
  max?: number;
}

interface FileMatch {
  path: string;
}

interface ContentMatch {
  path: string;
  line: number;
  text: string;
}

type ResidentSearchResult =
  | { kind: 'files'; matches: FileMatch[]; warnings: [] }
  | { kind: 'content'; matches: ContentMatch[]; warnings: [] };

export function createResidentSearchServer(root = process.cwd()): McpServer {
  const server = new McpServer({ name: 'atrium-resident-search', version: '0.0.0' });

  server.registerTool('find-files', {
    title: 'Find files',
    description: 'Find files under the resident root.',
    inputSchema,
  }, async (input: SearchInput) => toolResult({
    kind: 'files',
    matches: await findFileMatches(root, input),
    warnings: [],
  }));

  server.registerTool('grep', {
    title: 'Grep files',
    description: 'Search file contents under the resident root.',
    inputSchema,
  }, async (input: SearchInput) => toolResult({
    kind: 'content',
    matches: await grepMatches(root, input),
    warnings: [],
  }));

  server.registerTool('multi-grep', {
    title: 'Multi-grep files',
    description: 'Search file contents under the resident root.',
    inputSchema,
  }, async (input: SearchInput) => toolResult({
    kind: 'content',
    matches: await grepMatches(root, input),
    warnings: [],
  }));

  return server;
}

async function findFileMatches(root: string, input: SearchInput): Promise<FileMatch[]> {
  const matches: FileMatch[] = [];
  for await (const filePath of walkFiles(root, input)) {
    const displayPath = normalizeRelativePath(root, filePath);
    if (displayPath.toLowerCase().includes(input.query.toLowerCase())) {
      matches.push({ path: displayPath });
      if (input.max !== undefined && matches.length >= input.max) {
        break;
      }
    }
  }
  return matches;
}

async function grepMatches(root: string, input: SearchInput): Promise<ContentMatch[]> {
  const matches: ContentMatch[] = [];
  for await (const filePath of walkFiles(root, input)) {
    const content = await readFile(filePath, 'utf8');
    const displayPath = normalizeRelativePath(root, filePath);
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(input.query)) {
        continue;
      }
      matches.push({ path: displayPath, line: index + 1, text: lines[index] });
      if (input.max !== undefined && matches.length >= input.max) {
        return matches;
      }
    }
  }
  return matches;
}

async function* walkFiles(root: string, input: SearchInput): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const fullPath = join(root, entry.name);
    const displayPath = normalizeRelativePath(process.cwd(), fullPath);
    if (input.exclude && matchesGlob(displayPath, input.exclude)) {
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, input);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (input.glob && !matchesGlob(displayPath, input.glob)) {
      continue;
    }
    yield fullPath;
  }
}

function normalizeRelativePath(root: string, filePath: string): string {
  return relative(root, filePath).split('\\').join('/');
}

function toolResult(result: ResidentSearchResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function matchesGlob(value: string, glob: string): boolean {
  const regex = new RegExp(`^${globToRegexSource(glob)}$`, 'u');
  return regex.test(value);
}

function globToRegexSource(glob: string): string {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegex(char);
  }
  return source;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await createResidentSearchServer().connect(new StdioServerTransport());
}
