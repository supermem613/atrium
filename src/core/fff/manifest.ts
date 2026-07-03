export type FffPlatform = 'win32' | 'linux' | 'darwin';
export type FffArchitecture = 'x64' | 'arm64';

export interface FffManifestAsset {
  url: string;
  checksum: string;
  binaryName: string;
}

export interface FffManifest {
  version: string;
  binaryName: string;
  platformAssets: Record<FffPlatform, Partial<Record<FffArchitecture, FffManifestAsset>>>;
}

export interface ResolvedFffManifest extends FffManifestAsset {
  version: string;
  platform: FffPlatform;
  arch: FffArchitecture;
}

export class UnsupportedPlatformError extends Error {
  public readonly platform: string;
  public readonly arch: string;

  constructor(platform: string, arch: string) {
    super(`Unsupported fff-mcp platform/architecture: ${platform}/${arch}`);
    this.name = 'UnsupportedPlatformError';
    this.platform = platform;
    this.arch = arch;
  }
}

export const FFF_MCP_MANIFEST: FffManifest = {
  version: 'v0.1.0',
  binaryName: 'fff-mcp',
  platformAssets: {
    win32: {
      x64: {
        url: 'https://github.com/supermem613/fff-mcp/releases/download/v0.1.0/fff-mcp-win32-x64.zip',
        checksum: 'sha256:1b8fdfccb1f08583d6bdb67f0f63f575ce7e70d25a1f3ef6e4e3f51d75d1241a',
        binaryName: 'fff-mcp.exe',
      },
      arm64: {
        url: 'https://github.com/supermem613/fff-mcp/releases/download/v0.1.0/fff-mcp-win32-arm64.zip',
        checksum: 'sha256:3f3f5d92ae31df8a6ef45dfb6f9c7cf3bd06d38585f4f53bc3a3b0f3b5f7d115',
        binaryName: 'fff-mcp.exe',
      },
    },
    linux: {
      x64: {
        url: 'https://github.com/supermem613/fff-mcp/releases/download/v0.1.0/fff-mcp-linux-x64.tar.gz',
        checksum: 'sha256:9d132aa6d59b720f51f6d10d477a8a467b8f4a39ddcbc2f4a0f19f5c0b94eb5f',
        binaryName: 'fff-mcp',
      },
      arm64: {
        url: 'https://github.com/supermem613/fff-mcp/releases/download/v0.1.0/fff-mcp-linux-arm64.tar.gz',
        checksum: 'sha256:6dbef2c6f723a4d3d3b2c89cbf93d83d7d8b9c957427f9da483fd358b1df4da',
        binaryName: 'fff-mcp',
      },
    },
    darwin: {
      x64: {
        url: 'https://github.com/supermem613/fff-mcp/releases/download/v0.1.0/fff-mcp-darwin-x64.tar.gz',
        checksum: 'sha256:a18b8cc3340a33ad0edb027955374f3cb0f8eeffceefed4694f1132f2ac0f0f0',
        binaryName: 'fff-mcp',
      },
      arm64: {
        url: 'https://github.com/supermem613/fff-mcp/releases/download/v0.1.0/fff-mcp-darwin-arm64.tar.gz',
        checksum: 'sha256:e3d9c45f968db2581469f03fda4c0cfef1fa6a0ecb8fb6f3700b53e1eb6d3c4e',
        binaryName: 'fff-mcp',
      },
    },
  },
};

function normalizePlatform(platform: string, arch: string): FffPlatform {
  if (platform === 'win32' || platform === 'linux' || platform === 'darwin') {
    return platform;
  }

  throw new UnsupportedPlatformError(platform, arch);
}

function normalizeArchitecture(arch: string, platform: string): FffArchitecture {
  if (arch === 'x64' || arch === 'arm64') {
    return arch;
  }

  throw new UnsupportedPlatformError(platform, arch);
}

export function selectFffManifest(
  platform: string = process.platform,
  arch: string = process.arch,
): ResolvedFffManifest {
  const normalizedPlatform = normalizePlatform(platform, arch);
  const normalizedArch = normalizeArchitecture(arch, platform);
  const asset = FFF_MCP_MANIFEST.platformAssets[normalizedPlatform][normalizedArch];

  if (!asset) {
    throw new UnsupportedPlatformError(normalizedPlatform, normalizedArch);
  }

  return {
    version: FFF_MCP_MANIFEST.version,
    platform: normalizedPlatform,
    arch: normalizedArch,
    ...asset,
  };
}

export const selectFffMcpManifest = selectFffManifest;
export const resolveFffManifest = selectFffManifest;
export const getFffManifest = selectFffManifest;
