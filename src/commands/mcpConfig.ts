import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function buildMcpConfig() {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  return {
    servers: {
      atrium: {
        type: "stdio",
        command: "node",
        args: [serverPath],
      },
    },
  };
}

export async function mcpConfigCommand(): Promise<void> {
  process.stdout.write(`${JSON.stringify(buildMcpConfig(), null, 2)}\n`);
}
