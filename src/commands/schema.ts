import { buildSchema } from "../registry.js";

export async function schemaCommand(pathArgs: string[], opts: { summary?: boolean }, cliVersion: string): Promise<void> {
  process.stdout.write(JSON.stringify(buildSchema(cliVersion, pathArgs, opts.summary ?? false)) + "\n");
}
