const fs = require("node:fs");
const path = require("node:path");

const sourcePlugin = path.join(__dirname, "src", "commands", "plugin.ts");
const source = fs.readFileSync(sourcePlugin, "utf8");

if (!source.includes('["plugin", "install", pluginRoot]')) {
  throw new Error("RED: install-plugin does not install the local Atrium plugin");
}

if (!source.includes('["plugin", "list", "--json"]')) {
  throw new Error("RED: install-plugin reports success without verifying that Copilot cached Atrium as an enabled plugin");
}
