import { resolveSurfaceSelection } from "../mcp/surfaces.js";

export function buildMcpConfig(selection?: readonly string[], searchRepositoryExcludes?: readonly string[]) {
  const { surfaces, toolNames, isDefault } = resolveSurfaceSelection(selection);
  const args = isDefault ? ["mcp-server"] : ["mcp-server", "--surface", surfaces.join(",")];
  if (searchRepositoryExcludes !== undefined) {
    for (const pattern of searchRepositoryExcludes) {
      args.push("--search-repository-exclude", pattern);
    }
  }
  const tools = isDefault ? ["*"] : toolNames;
  return {
    mcpServers: {
      atrium: {
        type: "local",
        command: "atrium",
        args,
        tools,
      },
    },
  };
}

export async function mcpConfigCommand(selection?: readonly string[], searchRepositoryExcludes?: readonly string[]): Promise<void> {
  process.stdout.write(`${JSON.stringify(buildMcpConfig(selection, searchRepositoryExcludes), null, 2)}\n`);
}
