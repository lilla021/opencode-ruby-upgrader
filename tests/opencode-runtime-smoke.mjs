import { execFileSync } from "node:child_process";
import RubyUpgradePlugin from "../src/index.js";

if (process.env.OPENCODE_RUNTIME_E2E !== "1") {
  console.log("OpenCode runtime smoke skipped; set OPENCODE_RUNTIME_E2E=1 in a CI job with OpenCode installed.");
  process.exit(0);
}

execFileSync("opencode", ["--version"], { stdio: "inherit" });
const plugin = await RubyUpgradePlugin();
const config = {};
await plugin.config(config);
if (!config.agent?.["ruby-upgrade"] || !config.command?.["ruby-upgrade"]) throw new Error("OpenCode plugin contract was not registered.");
console.log("OpenCode runtime smoke passed.");
