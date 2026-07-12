import { resolveSurfaceSelection } from "../mcp/surfaces.js";

export function buildMcpConfig(selection?: readonly string[]) {
  const { surfaces, toolNames, isDefault } = resolveSurfaceSelection(selection);
  const args = isDefault ? ["mcp-server"] : ["mcp-server", "--surface", surfaces.join(",")];
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

export async function mcpConfigCommand(selection?: readonly string[]): Promise<void> {
  process.stdout.write(`${JSON.stringify(buildMcpConfig(selection), null, 2)}\n`);
}
