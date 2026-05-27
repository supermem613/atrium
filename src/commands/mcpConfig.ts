export function buildMcpConfig() {
  return {
    mcpServers: {
      atrium: {
        type: "local",
        command: "atrium",
        args: ["mcp-server"],
        tools: ["*"],
      },
    },
  };
}

export async function mcpConfigCommand(): Promise<void> {
  process.stdout.write(`${JSON.stringify(buildMcpConfig(), null, 2)}\n`);
}
