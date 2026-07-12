export interface ContentParityOptions {
  query: string;
  regex?: boolean;
  all?: boolean;
  globs?: string[];
  excludes?: string[];
}

export interface ContentParityMatch {
  path: string;
  line: number;
  text: string;
}

export interface FilesParityOptions {
  all?: boolean;
  globs?: string[];
  excludes?: string[];
  rootIsFile?: boolean;
  rootName?: string;
}

export function contentParity(
  root: string,
  options: ContentParityOptions,
): Promise<{ rg: ContentParityMatch[]; native: ContentParityMatch[] }>;

export function filesParity(
  root: string,
  options?: FilesParityOptions,
): Promise<{ rg: string[]; native: string[] }>;
