#!/usr/bin/env node
import { inspectGitCapabilities, inspectWorktree, setupInstructions } from "../src/preflight.js";
import { startDashboard } from "../src/dashboard.js";
import { commitValidatedHop, CommitGateError } from "../src/commit-hop.js";
import { acquireRunLock, readRun, releaseRunLock, RunStateError } from "../src/run-state.js";
import { beginRun, runStatus, transitionRun } from "../src/controller.js";
import { inventoryProject } from "../src/inventory.js";
import { inspectSupplyChain } from "../src/supply-chain.js";

const [command, ...args] = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
if (command === "preflight") {
  const result = inspectWorktree();
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else if (result.ok && result.mode === "non-git") console.log("✓ No Git repository detected; proceeding without Git checkpoints or worktree isolation.");
  else if (result.ok) console.log(`✓ Linked worktree: ${result.root}\n✓ Branch: ${result.branch}\n✓ Starting commit: ${result.sha}\n✓ Remote writes: disabled`);
  else console.error(`${setupInstructions(result)}\n\nPreflight blocked: ${result.reason}`);
  process.exitCode = result.ok ? 0 : 1;
} else if (command === "dashboard") {
  const server = await startDashboard();
  const address = server.address();
  console.log(`Ruby Upgrade Workspace: http://127.0.0.1:${address.port}`);
} else if (command === "begin") {
  try { console.log(JSON.stringify(beginRun({ target: option("--target"), dryRun: args.includes("--dry-run"), stopAfterHop: args.includes("--stop-after-hop"), allowNonGit: args.includes("--allow-non-git") }), null, 2)); }
  catch (error) { console.error(`Run start blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "status") {
  try { console.log(JSON.stringify(runStatus({ reportPath: option("--report") }), null, 2)); }
  catch (error) { console.error(`Run status failed: ${error.message}`); process.exitCode = 1; }
} else if (command === "transition") {
  try { console.log(JSON.stringify(transitionRun({ reportPath: option("--report"), phase: option("--phase"), note: option("--note") }), null, 2)); }
  catch (error) { console.error(`State transition blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "inventory") {
  console.log(JSON.stringify(inventoryProject(), null, 2));
} else if (command === "git-capabilities") {
  console.log(JSON.stringify(inspectGitCapabilities(), null, 2));
} else if (command === "supply-chain") {
  console.log(JSON.stringify(inspectSupplyChain(), null, 2));
} else if (command === "commit-hop") {
  const reportIndex = args.indexOf("--report");
  try {
    const result = commitValidatedHop({ reportPath: reportIndex >= 0 ? args[reportIndex + 1] : undefined, allowHooks: args.includes("--allow-hooks"), allowBroadLockfile: args.includes("--allow-broad-lockfile"), allowPrivateSources: args.includes("--allow-private-sources") });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const prefix = error instanceof CommitGateError ? `Commit blocked (${error.code})` : "Commit failed";
    console.error(`${prefix}: ${error.message}`);
    process.exitCode = 1;
  }
} else if (["resume", "release-lock"].includes(command)) {
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
  try {
    if (!reportPath) throw new RunStateError("Provide --report .ruby-upgrades/runs/<run>.json.", "missing-report-path");
    if (command === "resume") {
      const run = readRun(process.cwd(), reportPath);
      if (run.status === "complete") throw new RunStateError("This run is already complete; start a new run instead.", "run-complete");
      console.log(JSON.stringify({ lock: acquireRunLock(process.cwd(), reportPath), run }, null, 2));
    } else {
      releaseRunLock(process.cwd(), reportPath);
      console.log("Upgrade run lock released.");
    }
  } catch (error) {
    const prefix = error instanceof RunStateError ? `Run control blocked (${error.code})` : "Run control failed";
    console.error(`${prefix}: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  console.error("Usage: opencode-ruby-upgrader <preflight|dashboard|begin --target VERSION [--dry-run] [--stop-after-hop] [--allow-non-git]|status --report path|transition --report path --phase PHASE|inventory|supply-chain|git-capabilities|commit-hop --report path|resume --report path|release-lock --report path>");
  process.exitCode = 1;
}
