#!/usr/bin/env node
import { inspectGitCapabilities, inspectWorktree, setupInstructions } from "../src/preflight.js";
import { startDashboard } from "../src/dashboard.js";
import { commitValidatedHop, commitValidatedRailsHop, CommitGateError } from "../src/commit-hop.js";
import { acquireRunLock, readRun, releaseRunLock, RunStateError } from "../src/run-state.js";
import { beginRailsBridgeRun, beginRun, discardLastRailsIteration, discardPendingRailsAppUpdate, recordDependencyReview, recordExecutedIteration, recordExecutedRailsIteration, recordFrameworkBridge, recordRailsResearch, recordResearch, recordRiskDecision, resumeRun, runStatus, transitionRun } from "../src/controller.js";
import { inventoryProject } from "../src/inventory.js";
import { inspectSupplyChain } from "../src/supply-chain.js";
import { prepareTargetRuntime } from "../src/target-runtime.js";

const [command, ...args] = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const options = (name) => args.flatMap((argument, index) => argument === name && args[index + 1] ? [args[index + 1]] : []);
const reportOption = () => option("--report");
const citation = (value) => { const [title, url] = (value ?? "").split("|"); return { title, url }; };
const usage = "Usage: opencode-ruby-upgrader <preflight|dashboard|begin|begin-rails-bridge|prepare-target-runtime|status|transition|record-research|record-rails-research|record-risk|record-framework-bridge|record-executed-iteration|record-executed-rails-iteration|discard-pending-app-update|record-dependency-review|inventory|supply-chain|git-capabilities|commit-hop|commit-rails-hop|resume|release-lock> [--help]";
if (command === "help" || args.includes("--help")) {
  console.log(`${usage}\n\nUse status --summary for a concise report view. release-lock is stale-session recovery only and requires --force.`);
} else if (command === "preflight") {
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
} else if (command === "begin-rails-bridge") {
  try { console.log(JSON.stringify(beginRailsBridgeRun({ rubyReportPath: option("--ruby-report"), dryRun: args.includes("--dry-run"), stopAfterHop: args.includes("--stop-after-hop"), allowNonGit: args.includes("--allow-non-git") }), null, 2)); }
  catch (error) { console.error(`Rails bridge start blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "prepare-target-runtime") {
  try {
    if (!option("--ruby") || args.some((argument) => !["--ruby", "--report", option("--ruby"), option("--report")].includes(argument))) throw new Error("Usage: prepare-target-runtime --ruby <x.y.z> [--report .ruby-upgrades/runs/<run>.json]");
    console.log(JSON.stringify(prepareTargetRuntime({ ruby: option("--ruby"), reportPath: option("--report") }), null, 2));
  } catch (error) { console.error(`Target runtime preparation blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "status") {
  try {
    const run = runStatus({ reportPath: option("--report") });
    if (args.includes("--summary")) {
      const target = run.reportType === "rails_bridge" ? `Rails ${run.targetRails}` : `Ruby ${run.targetRuby}`;
      const latest = run.iterations.at(-1); const checkpoint = latest?.checkpointSha ? `checkpoint ${latest.checkpointSha.slice(0, 12)}` : "no checkpoint yet";
      console.log(`${run.title}\n${target} · ${run.status}/${run.phase} · ${checkpoint}\nReport: ${option("--report")}`);
    } else console.log(JSON.stringify(run, null, 2));
  }
  catch (error) { console.error(`Run status failed: ${error.message}`); process.exitCode = 1; }
} else if (command === "transition") {
  try { console.log(JSON.stringify(transitionRun({ reportPath: reportOption(), phase: option("--phase"), note: option("--note"), commitSha: option("--commit-sha") }), null, 2)); }
  catch (error) { console.error(`State transition blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "record-research") {
  try { console.log(JSON.stringify(recordResearch({ reportPath: reportOption(), ladder: (option("--ladder") ?? "").split(",").filter(Boolean), citations: options("--citation").map(citation) }), null, 2)); }
  catch (error) { console.error(`Research recording blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "record-rails-research") {
  try { console.log(JSON.stringify(recordRailsResearch({ reportPath: reportOption(), ladder: (option("--ladder") ?? "").split(",").filter(Boolean), citations: options("--citation").map(citation) }), null, 2)); }
  catch (error) { console.error(`Rails research recording blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "record-risk") {
  try { console.log(JSON.stringify(recordRiskDecision({ reportPath: reportOption(), risk: option("--risk"), decision: option("--decision"), evidence: option("--evidence") }), null, 2)); }
  catch (error) { console.error(`Risk recording blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "record-framework-bridge") {
  try { console.log(JSON.stringify(recordFrameworkBridge({ reportPath: reportOption(), rubyFrom: option("--ruby-from"), rubyTo: option("--ruby-to"), railsFrom: option("--rails-from"), railsTo: option("--rails-to"), rationale: option("--rationale"), citations: options("--citation").map(citation) }), null, 2)); }
  catch (error) { console.error(`Rails compatibility bridge blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "record-executed-iteration") {
  try { console.log(JSON.stringify(recordExecutedIteration({ reportPath: reportOption(), iteration: JSON.parse(option("--json") ?? ""), validationCommandId: option("--validation") }), null, 2)); }
  catch (error) { console.error(`Executed validation blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "record-executed-rails-iteration") {
  try { console.log(JSON.stringify(recordExecutedRailsIteration({ reportPath: reportOption(), iteration: JSON.parse(option("--json") ?? ""), testValidationCommandId: option("--validation") }), null, 2)); }
  catch (error) { console.error(`Executed Rails validation blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "discard-pending-app-update") {
  try { console.log(JSON.stringify(discardPendingRailsAppUpdate({ reportPath: reportOption(), reason: option("--reason") }), null, 2)); }
  catch (error) { console.error(`Rails app:update discard blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "discard-last-rails-iteration") {
  try { console.log(JSON.stringify(discardLastRailsIteration({ reportPath: reportOption(), reason: option("--reason") }), null, 2)); }
  catch (error) { console.error(`Rails iteration discard blocked: ${error.message}`); process.exitCode = 1; }
} else if (command === "record-dependency-review") {
  try { console.log(JSON.stringify(recordDependencyReview({ reportPath: reportOption(), compatibility: option("--compatibility"), licenses: option("--licenses") }), null, 2)); }
  catch (error) { console.error(`Dependency review blocked: ${error.message}`); process.exitCode = 1; }
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
} else if (command === "commit-rails-hop") {
  const reportIndex = args.indexOf("--report");
  try { console.log(JSON.stringify(commitValidatedRailsHop({ reportPath: reportIndex >= 0 ? args[reportIndex + 1] : undefined, allowHooks: args.includes("--allow-hooks"), allowBroadLockfile: args.includes("--allow-broad-lockfile"), allowPrivateSources: args.includes("--allow-private-sources") }), null, 2)); }
  catch (error) { console.error(`${error instanceof CommitGateError ? `Rails commit blocked (${error.code})` : "Rails commit failed"}: ${error.message}`); process.exitCode = 1; }
} else if (["resume", "release-lock"].includes(command)) {
  const reportIndex = args.indexOf("--report");
  const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
  try {
    if (!reportPath) throw new RunStateError("Provide --report .ruby-upgrades/runs/<run>.json.", "missing-report-path");
    if (command === "resume") {
      console.log(JSON.stringify(resumeRun({ reportPath, continueAfterHop: args.includes("--continue-after-hop") }), null, 2));
    } else {
      if (!args.includes("--force")) throw new RunStateError("release-lock is stale-session recovery only. Verify the owner is gone, then rerun with --force.", "force-required");
      releaseRunLock(process.cwd(), reportPath, readRun(process.cwd(), reportPath).lockNonce);
      console.log("Upgrade run lock released.");
    }
  } catch (error) {
    const prefix = error instanceof RunStateError ? `Run control blocked (${error.code})` : "Run control failed";
    console.error(`${prefix}: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  console.error(usage);
  process.exitCode = 1;
}
