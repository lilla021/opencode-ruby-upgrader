import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectGitCapabilities, inspectWorktree } from "./preflight.js";
import { inventoryProject } from "./inventory.js";
import { inspectSupplyChain } from "./supply-chain.js";
import { acquireRunLock, assertRunLock, readRun, releaseRunLock, writeRun } from "./run-state.js";
import { executeValidation } from "./validation-executor.js";
import { receiptDigest } from "./provenance.js";

const rubyVersion = /^\d+\.\d+(?:\.\d+)?$/;
const railsVersion = /^\d+(?:\.\d+)+$/;
const runName = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`;
const transitions = {
  initialized: ["inventory_complete", "blocked", "paused"], inventory_complete: ["research_complete", "blocked", "paused"],
  research_complete: ["hop_validated", "blocked", "paused"], hop_validated: ["committed", "blocked", "paused"],
  committed: ["hop_validated", "complete", "blocked", "paused"], paused: ["inventory_complete", "research_complete", "hop_validated", "committed", "blocked"], blocked: ["inventory_complete", "research_complete", "hop_validated", "paused"], complete: []
};
const series = (value) => value.split(".").slice(0, 2).join(".");
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const minorNumber = (value) => { const [major, minor] = series(value).split(".").map(Number); return major * 1000 + minor; };
const railsMinorNumber = (value) => { const [major, minor] = series(value).split(".").map(Number); return major * 1000 + minor; };
const contiguousRailsHop = (from, to) => railsMinorNumber(to) === railsMinorNumber(from) + 1 || (Number(to.split(".")[0]) === Number(from.split(".")[0]) + 1 && Number(to.split(".")[1]) === 0);
const rubyMajorBoundaries = new Map([[2, 7], [3, 4]]);
const contiguousRubyHop = (from, to) => {
  const [fromMajor, fromMinor] = series(from).split(".").map(Number); const [toMajor, toMinor] = series(to).split(".").map(Number);
  return minorNumber(to) === minorNumber(from) + 1 || (toMajor === fromMajor + 1 && toMinor === 0 && rubyMajorBoundaries.get(fromMajor) === fromMinor);
};
const requiredRisksFor = (supplyChain, gitCapabilities) => [
  ...(supplyChain.privateSources.length ? ["private-dependency-sources"] : []),
  ...(gitCapabilities.shallow ? ["shallow-clone"] : []), ...(gitCapabilities.sparseCheckout ? ["sparse-checkout"] : []),
  ...(gitCapabilities.submodules ? ["submodules"] : []), ...(gitCapabilities.lfsConfigured ? ["git-lfs"] : [])
];
const hasUnapprovedRisks = (run) => {
  const decisions = new Map(run.riskDecisions.map((risk) => [risk.risk, risk.decision]));
  return (run.requiredRisks ?? []).some((risk) => decisions.get(risk) !== "approved") || [...decisions.values()].some((decision) => decision !== "approved");
};
const assertApprovedRisks = (run) => { if (hasUnapprovedRisks(run)) throw new Error("Resolve every detected risk with an explicit approval before recording a routine iteration."); };

export function beginRun({ root = process.cwd(), target, dryRun = false, stopAfterHop = false } = {}) {
  if (!target || !rubyVersion.test(target)) throw new Error("Provide --target as a Ruby version such as 3.4 or 3.4.1.");
  const preflight = inspectWorktree(root); const inventory = inventoryProject(root); const supplyChain = inspectSupplyChain(root); const gitCapabilities = inspectGitCapabilities(root);
  const plan = { preflight, inventory, supplyChain, gitCapabilities, targetRuby: target, dryRun, stopAfterHop };
  if (dryRun) return plan;
  if (!preflight.ok || preflight.mode !== "linked-worktree") throw new Error("A durable migration requires a supported linked Git worktree.");
  if (!inventory.supported || inventory.requiresDecision) throw new Error("A durable migration requires a Gemfile and a recognized executable test adapter. Supply an explicit validation command through a future reviewed adapter instead of guessing.");
  const reportPath = path.join(".ruby-upgrades", "runs", runName());
  const requiredRisks = requiredRisksFor(supplyChain, gitCapabilities);
  const report = {
    schemaVersion: 2, validationReceiptsRequired: true, runId: crypto.randomUUID(), title: `Ruby migration to ${target}`, status: "in_progress", phase: "initialized", startedAt: new Date().toISOString(), targetRuby: target, targetPinnedAt: new Date().toISOString(),
    branch: preflight.branch ?? null, worktreeRoot: preflight.root ?? root, startingSha: preflight.sha ?? null, expectedHead: preflight.sha ?? null, control: { stopAfterHop }, inventory, supplyChain, gitCapabilities,
    research: { ladder: [], citations: [] }, requiredRisks, riskDecisions: [], frameworkBridge: null, summary: ["Run initialized; official-source research and compatibility ladder pending."], iterations: [], sessionSummary: ""
  };
  const lock = acquireRunLock(root, reportPath); report.lockNonce = lock.nonce;
  try { writeRun(root, reportPath, report); } catch (error) { releaseRunLock(root, reportPath, lock.nonce); throw error; }
  return { ...plan, reportPath, report, lock };
}

export function runStatus({ root = process.cwd(), reportPath }) { return readRun(root, reportPath); }

export function beginRailsBridgeRun({ root = process.cwd(), rubyReportPath, dryRun = false, stopAfterHop = false } = {}) {
  const rubyRun = readRun(root, rubyReportPath);
  if (rubyRun.reportType === "rails_bridge" || rubyRun.phase !== "blocked" || rubyRun.status !== "blocked" || !rubyRun.frameworkBridge) throw new Error("A Rails bridge can start only from a blocked Ruby run with an approved compatibility bridge.");
  const preflight = inspectWorktree(root); const inventory = inventoryProject(root); const supplyChain = inspectSupplyChain(root); const gitCapabilities = inspectGitCapabilities(root); const bridge = rubyRun.frameworkBridge;
  const plan = { preflight, inventory, supplyChain, gitCapabilities, bridge, dryRun, stopAfterHop };
  if (dryRun) return plan;
  if (!preflight.ok || preflight.mode !== "linked-worktree") throw new Error("A durable Rails bridge requires a supported linked Git worktree.");
  if (!inventory.rails?.resolvedVersion || series(inventory.rails.resolvedVersion) !== series(bridge.railsFrom)) throw new Error("The current Gemfile.lock must still resolve the Rails version recorded by the blocked Ruby run.");
  if (preflight.branch !== rubyRun.branch || preflight.sha !== rubyRun.expectedHead) throw new Error("Rails bridge must start on the blocked Ruby run's recorded branch and checkpoint SHA.");
  const reportPath = path.join(".ruby-upgrades", "runs", runName());
  const report = { schemaVersion: 2, validationReceiptsRequired: true, reportType: "rails_bridge", runId: crypto.randomUUID(), title: `Rails bridge ${bridge.railsFrom} to ${bridge.railsTo}`, status: "in_progress", phase: "initialized", startedAt: new Date().toISOString(), targetRails: bridge.railsTo, targetRailsPinnedAt: new Date().toISOString(), branch: preflight.branch ?? null, worktreeRoot: preflight.root ?? root, startingSha: preflight.sha ?? null, expectedHead: preflight.sha ?? null, control: { stopAfterHop }, inventory, supplyChain, gitCapabilities, bridge: { rubyReportPath, rubyRunId: rubyRun.runId, rubyFrom: bridge.rubyFrom, rubyTo: bridge.rubyTo, railsFrom: bridge.railsFrom, railsTo: bridge.railsTo, approvedAt: bridge.recordedAt }, research: { ladder: [], citations: [] }, riskDecisions: [], requiredRisks: requiredRisksFor(supplyChain, gitCapabilities), summary: ["Rails bridge initialized from blocked Ruby compatibility decision."], iterations: [], sessionSummary: "" };
  const lock = acquireRunLock(root, reportPath); report.lockNonce = lock.nonce;
  try { writeRun(root, reportPath, report); } catch (error) { releaseRunLock(root, reportPath, lock.nonce); throw error; }
  return { ...plan, reportPath, report, lock };
}

export function recordResearch({ root = process.cwd(), reportPath, ladder, citations }) {
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  if (!Array.isArray(ladder) || !ladder.length || ladder.some((version) => !rubyVersion.test(version))) throw new Error("Research requires a Ruby-version ladder.");
  if (series(ladder.at(-1)) !== series(run.targetRuby)) throw new Error("The research ladder must end at the pinned target Ruby series.");
  if (ladder.some((version, index) => index > 0 && !contiguousRubyHop(ladder[index - 1], version))) throw new Error("The research ladder must advance exactly one Ruby minor series per hop.");
  const declared = run.inventory.rubyDeclarations.map((declaration) => declaration.value).find(Boolean);
  if (declared && series(ladder[0]) !== series(declared)) throw new Error("The research ladder must begin at the project’s detected Ruby version.");
  if (!Array.isArray(citations) || !citations.length || citations.some((citation) => !citation?.title || !/^https:\/\//.test(citation.url ?? ""))) throw new Error("Research requires at least one HTTPS official-source citation.");
  run.research = { ladder, citations }; writeRun(root, reportPath, run); return run;
}

export function recordRailsResearch({ root = process.cwd(), reportPath, ladder, citations }) {
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  if (run.reportType !== "rails_bridge") throw new Error("Rails research belongs only to a Rails bridge report.");
  if (!Array.isArray(ladder) || ladder.length < 2 || ladder.some((version) => !railsVersion.test(version)) || series(ladder[0]) !== series(run.bridge.railsFrom) || series(ladder.at(-1)) !== series(run.targetRails) || ladder.some((version, index) => index > 0 && !contiguousRailsHop(ladder[index - 1], version))) throw new Error("Rails research must provide contiguous minor-version hops from the recorded Rails version to targetRails.");
  if (!Array.isArray(citations) || !citations.length || citations.some((citation) => !citation?.title || !/^https:\/\//.test(citation.url ?? ""))) throw new Error("Rails research requires HTTPS citations.");
  run.research = { ladder, citations }; writeRun(root, reportPath, run); return run;
}

export function recordRiskDecision({ root = process.cwd(), reportPath, risk, decision, evidence = "" }) {
  if (!risk || !["approved", "paused", "blocked"].includes(decision)) throw new Error("Risk decisions require a risk and approved, paused, or blocked decision.");
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce); run.riskDecisions.push({ risk, decision, evidence, recordedAt: new Date().toISOString() }); writeRun(root, reportPath, run); return run;
}

export function recordFrameworkBridge({ root = process.cwd(), reportPath, rubyFrom, rubyTo, railsFrom, railsTo, rationale, citations }) {
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  if (!["research_complete", "committed"].includes(run.phase)) throw new Error("Record a Rails compatibility bridge only after research or a committed Ruby checkpoint and before a blocked Ruby hop.");
  if (run.frameworkBridge) throw new Error("This run already has an approved Rails compatibility bridge; complete it in a separately scoped Rails migration.");
  if (![rubyFrom, rubyTo].every((version) => rubyVersion.test(version)) || ![railsFrom, railsTo].every((version) => railsVersion.test(version))) throw new Error("A Rails compatibility bridge requires Ruby and Rails from/to versions.");
  if (series(rubyFrom) !== series(run.iterations.at(-1)?.to ?? run.research.ladder[0]) || series(rubyTo) !== series(run.research.ladder[run.research.ladder.findIndex((version) => series(version) === series(rubyFrom)) + 1])) throw new Error("Rails compatibility bridge must describe the next researched Ruby hop.");
  if (!run.inventory.rails?.resolvedVersion) throw new Error("Rails compatibility bridges require a resolved Rails version from Gemfile.lock.");
  if (series(railsFrom) !== series(run.inventory.rails.resolvedVersion)) throw new Error("Rails compatibility bridge must begin at the detected Rails version.");
  if (!rationale || !Array.isArray(citations) || !citations.length || citations.some((citation) => !citation?.title || !/^https:\/\//.test(citation.url ?? ""))) throw new Error("Rails compatibility bridge requires a rationale and HTTPS citations.");
  run.frameworkBridge = { status: "approved", rubyFrom, rubyTo, railsFrom, railsTo, rationale, citations, recordedAt: new Date().toISOString() };
  run.summary = [...run.summary, `User approved a separately scoped Rails ${railsFrom} → ${railsTo} bridge before Ruby ${rubyFrom} → ${rubyTo}.`];
  writeRun(root, reportPath, run); return run;
}

function recordIterationInternal({ root = process.cwd(), reportPath, iteration, executed = false }) {
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  if (run.reportType === "rails_bridge") throw new Error("Use record-rails-iteration for a Rails bridge report.");
  if (run.validationReceiptsRequired && !executed) throw new Error("New reports require record-executed-iteration so validation receipts are created by the executor.");
  if (run.phase !== "research_complete" && run.phase !== "committed") throw new Error("Record iterations only after research or a prior checkpoint.");
  assertApprovedRisks(run);
  if (run.iterations.length && (run.phase !== "committed" || !run.iterations.at(-1).checkpointSha)) throw new Error("Each iteration requires exactly one checkpoint before the next iteration.");
  const expectedFrom = run.iterations.at(-1)?.to ?? run.research.ladder[0];
  const fromIndex = run.research.ladder.findIndex((version) => series(version) === series(expectedFrom));
  const expectedTo = run.research.ladder[fromIndex + 1];
  if (!iteration || fromIndex < 0 || !expectedTo || series(iteration.from) !== series(expectedFrom) || series(iteration.to) !== series(expectedTo)) throw new Error("Iteration must advance exactly one researched Ruby minor series from the prior ladder point.");
  run.iterations.push({ ...iteration, status: "complete" }); writeRun(root, reportPath, run); return run;
}

export function recordIteration(options = {}) { return recordIterationInternal(options); }

function recordRailsIterationInternal({ root = process.cwd(), reportPath, iteration, executed = false }) {
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  if (run.reportType !== "rails_bridge" || !["research_complete", "committed"].includes(run.phase)) throw new Error("Record Rails iterations only after Rails research or a prior Rails checkpoint.");
  if (run.validationReceiptsRequired && !executed) throw new Error("New reports require record-executed-rails-iteration so validation receipts are created by the executor.");
  assertApprovedRisks(run);
  if (run.iterations.length && (run.phase !== "committed" || !run.iterations.at(-1).checkpointSha)) throw new Error("Each iteration requires exactly one checkpoint before the next iteration.");
  const expectedFrom = run.iterations.at(-1)?.to ?? run.research.ladder[0]; const index = run.research.ladder.findIndex((version) => series(version) === series(expectedFrom)); const expectedTo = run.research.ladder[index + 1];
  if (!iteration || !expectedTo || series(iteration.from) !== series(expectedFrom) || series(iteration.to) !== series(expectedTo) || !iteration.appUpdateReview) throw new Error("Rails iteration must advance exactly one researched Rails minor and include app:update review evidence.");
  run.iterations.push({ ...iteration, status: "complete" }); writeRun(root, reportPath, run); return run;
}

export function recordRailsIteration(options = {}) { return recordRailsIterationInternal(options); }

export function recordExecutedIteration({ root = process.cwd(), reportPath, iteration, validationCommandId }) {
  const run = validationPreflight(root, reportPath, false); const receipt = executeValidation({ root, inventory: run.inventory, commandId: validationCommandId });
  if (receipt.kind !== "test" || receipt.exitCode !== 0 || receipt.testEvidence?.passed !== true) throw new Error(`Validation failed; receipt ${receipt.id} was not recorded as a passing hop.`);
  return recordIterationInternal({ root, reportPath, executed: true, iteration: { ...iteration, tests: { ...receipt.testEvidence, smoke: iteration?.tests?.smoke }, validationReceipts: [receipt] } });
}

export function recordExecutedRailsIteration({ root = process.cwd(), reportPath, iteration, testValidationCommandId }) {
  const run = validationPreflight(root, reportPath, true);
  if (!run.pendingAppUpdate) {
    const updateReceipt = executeValidation({ root, inventory: run.inventory, commandId: "rails-app-update" });
    if (updateReceipt.exitCode !== 0) throw new Error("app:update failed; Rails hop was not recorded.");
    run.pendingAppUpdate = updateReceipt;
    writeRun(root, reportPath, run);
    return { pendingReview: true, receipt: updateReceipt };
  }
  const updateReceipt = run.pendingAppUpdate;
  const review = { ...iteration?.appUpdateReview, receiptId: updateReceipt.id, executedAt: updateReceipt.startedAt, worktree: updateReceipt.worktree };
  if (!validRailsReviewForExecution(review, updateReceipt)) throw new Error("Review app:update after it executes and bind the review to its receipt and working-tree fingerprint.");
  const testReceipt = executeValidation({ root, inventory: run.inventory, commandId: testValidationCommandId });
  if (testReceipt.kind !== "test" || testReceipt.exitCode !== 0 || testReceipt.testEvidence?.passed !== true) throw new Error("Final validation failed; Rails hop was not recorded.");
  const recorded = recordRailsIterationInternal({ root, reportPath, executed: true, iteration: { ...iteration, tests: { ...testReceipt.testEvidence, smoke: iteration?.tests?.smoke }, validationReceipts: [updateReceipt, testReceipt], appUpdateReview: review } });
  delete recorded.pendingAppUpdate;
  writeRun(root, reportPath, recorded);
  return recorded;
}

export function discardPendingRailsAppUpdate({ root = process.cwd(), reportPath, reason }) {
  if (!reason?.trim()) throw new Error("Discarding app:update evidence requires a review reason.");
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  if (run.reportType !== "rails_bridge" || !run.pendingAppUpdate) throw new Error("No pending Rails app:update receipt exists for this bridge.");
  run.discardedAppUpdates = [...(run.discardedAppUpdates ?? []), { receipt: run.pendingAppUpdate, reason: reason.trim(), discardedAt: new Date().toISOString() }];
  delete run.pendingAppUpdate;
  run.summary = [...run.summary, `Discarded a reviewed app:update result: ${reason.trim()}`];
  writeRun(root, reportPath, run); return run;
}

export function discardLastRailsIteration({ root = process.cwd(), reportPath, reason }) {
  if (!reason?.trim()) throw new Error("Discarding a recorded Rails iteration requires a review reason.");
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  if (run.reportType !== "rails_bridge" || run.phase !== "hop_validated" || run.pendingAppUpdate) throw new Error("Discard the latest validated, uncommitted Rails iteration only while the bridge hop is validated with no pending app:update.");
  const iteration = run.iterations.at(-1);
  if (!iteration || iteration.checkpointSha) throw new Error("There is no validated, uncommitted Rails iteration to discard.");
  run.discardedIterations = [...(run.discardedIterations ?? []), { iteration, reason: reason.trim(), discardedAt: new Date().toISOString() }];
  run.iterations = run.iterations.slice(0, -1);
  run.phase = run.iterations.length ? "committed" : "research_complete";
  run.summary = [...run.summary, `Discarded the latest validated Rails iteration (${iteration.from} -> ${iteration.to}) to re-validate the hop: ${reason.trim()}`];
  writeRun(root, reportPath, run); return run;
}

export function recordDependencyReview({ root = process.cwd(), reportPath, compatibility, licenses }) {
  if (!compatibility?.trim() || !licenses?.trim()) throw new Error("Dependency review requires compatibility and license findings.");
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce);
  const iteration = run.iterations?.at(-1);
  if (run.phase !== "hop_validated" || !iteration || iteration.checkpointSha) throw new Error("Record dependency review only for the latest validated, uncommitted hop.");
  iteration.dependencyReview = { completed: true, compatibility: compatibility.trim(), licenses: licenses.trim(), reviewedAt: new Date().toISOString() };
  run.summary = [...run.summary, "Recorded dependency compatibility and license review for the validated hop."];
  writeRun(root, reportPath, run); return run;
}

function validRailsReviewForExecution(review, receipt) { return review?.command === "bin/rails app:update" && review.receiptId === receipt.id && review.executedAt === receipt.startedAt && review.worktree?.diffSha256 === receipt.worktree.diffSha256 && !Number.isNaN(Date.parse(review.reviewedAt ?? "")) && Date.parse(review.reviewedAt) >= Date.parse(receipt.finishedAt); }

function validationPreflight(root, reportPath, rails) {
  const run = readRun(root, reportPath);
  assertRunLock(root, reportPath, run.lockNonce);
  if (Boolean(run.reportType === "rails_bridge") !== rails || !["research_complete", "committed"].includes(run.phase)) throw new Error("Validation can run only for the active report type after research or a prior checkpoint.");
  assertApprovedRisks(run);
  if (run.iterations.length && (run.phase !== "committed" || !run.iterations.at(-1).checkpointSha)) throw new Error("Each iteration requires exactly one checkpoint before validation can run again.");
  return run;
}

function assertCompletion(run) {
  const final = run.iterations.at(-1);
  const target = run.reportType === "rails_bridge" ? run.targetRails : run.targetRuby;
  if (!final || series(final.to) !== series(target)) throw new Error("A run can complete only after the final validated iteration reaches its pinned target.");
  if (series(run.research.ladder.at(-1)) !== series(target)) throw new Error("Research ladder does not reach its pinned target.");
  if (hasUnapprovedRisks(run)) throw new Error("Unresolved risks prevent completion.");
  if (final.checkpointSha !== run.expectedHead) throw new Error("The final iteration must be committed through the checkpoint gate before completion.");
}

function verifyCheckpoint(root, reportPath, run, commitSha) {
  if (run.gitCapabilities?.supported !== true || !run.branch || !run.expectedHead) throw new Error("Non-Git runs cannot claim Git checkpoints or complete through the checkpoint lifecycle.");
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head !== commitSha) throw new Error("Checkpoint SHA must be the current Git HEAD created by commit-hop.");
  if (git(root, ["branch", "--show-current"]) !== run.branch) throw new Error("Checkpoint branch no longer matches the recorded run branch.");
  if (git(root, ["rev-parse", `${head}^`]) !== run.expectedHead) throw new Error("Checkpoint must be a direct child of the prior recorded checkpoint.");
  const iteration = run.iterations.at(-1);
  const message = git(root, ["log", "-1", "--format=%B"]);
  const prefix = run.reportType === "rails_bridge" ? "Rails" : "Ruby";
  if (!message.includes(`${prefix}-Upgrade-Report: ${reportPath}`) || !message.includes(`${prefix}-Upgrade-Hop: ${iteration.from}->${iteration.to}`) || (iteration.validationReceipts?.length && !message.includes(`Validation-Receipt-Digest: sha256:${receiptDigest(iteration.validationReceipts)}`)) || (prefix === "Rails" && (!message.includes(`Rails-App-Update-Reviewed: ${iteration.from}->${iteration.to}`) || !message.includes(`Rails-Bridge-Ruby-Report: ${run.bridge.rubyReportPath}`)))) throw new Error("Checkpoint commit does not carry the required run and hop trailers.");
}

export function transitionRun({ root = process.cwd(), reportPath, phase, note = "", commitSha = "" }) {
  if (!Object.hasOwn(transitions, phase)) throw new Error(`Unknown run phase: ${phase}.`);
  const run = readRun(root, reportPath); assertRunLock(root, reportPath, run.lockNonce); const current = run.phase;
  if (current === "blocked" && run.frameworkBridge) throw new Error("A Ruby run blocked by a Rails bridge is terminal; complete the bridge and start a fresh Ruby run.");
  if (!transitions[current]?.includes(phase)) throw new Error(`Cannot transition from ${current} to ${phase}.`);
  if (phase === "research_complete" && (!run.research.ladder.length || !run.research.citations.length)) throw new Error("Record research and citations before completing research.");
  if (phase === "hop_validated" && (run.iterations.at(-1)?.tests?.passed !== true || !run.iterations.at(-1)?.validationReceipts?.length)) throw new Error("A hop requires passing tests and executed validation receipts.");
  if (phase === "hop_validated" && run.iterations.at(-1)?.checkpointSha) throw new Error("A checkpointed iteration cannot be validated again; record the next hop first.");
  if (phase === "committed") {
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error("Record the checkpoint SHA after commit-hop.");
    const iteration = run.iterations.at(-1); if (!iteration || iteration.checkpointSha) throw new Error("A committed transition requires one uncheckpointed iteration.");
    verifyCheckpoint(root, reportPath, run, commitSha);
    iteration.checkpointSha = commitSha; run.expectedHead = commitSha;
  }
  if (phase === "complete") assertCompletion(run);
  if (phase === "paused") run.resumePhase = current;
  if (phase === "committed" && run.control.stopAfterHop && run.iterations.length === 1) { run.resumePhase = "committed"; phase = "paused"; }
  run.phase = phase; run.status = phase === "complete" ? "complete" : phase === "blocked" ? "blocked" : phase === "paused" ? "paused" : "in_progress";
  if (note) run.summary = [...run.summary, note]; writeRun(root, reportPath, run);
  if (["complete", "blocked", "paused"].includes(phase)) releaseRunLock(root, reportPath, run.lockNonce);
  return run;
}

export function resumeRun({ root = process.cwd(), reportPath, continueAfterHop = false }) {
  const run = readRun(root, reportPath);
  if (run.status === "complete") throw new Error("This run is complete; start a new run instead.");
  if (run.frameworkBridge && run.phase === "blocked") throw new Error("This Ruby run is blocked by an approved Rails bridge and cannot resume. Complete the linked Rails bridge, then begin a fresh Ruby run.");
  if (run.phase === "paused" && !transitions.paused.includes(run.resumePhase)) throw new Error("Paused run has no safe resume phase.");
  if (run.control.stopAfterHop && run.iterations.length >= 1 && run.resumePhase === "committed" && !continueAfterHop) throw new Error("This run stopped after its requested hop. Resume with explicit --continue-after-hop only after user review.");
  if (continueAfterHop) run.control.stopAfterHop = false;
  const lock = acquireRunLock(root, reportPath); run.lockNonce = lock.nonce;
  try {
   if (run.phase === "paused") {
    run.phase = run.resumePhase; run.status = "in_progress"; delete run.resumePhase; writeRun(root, reportPath, run);
   }
  } catch (error) { releaseRunLock(root, reportPath, lock.nonce); throw error; }
  return { lock, run: readRun(root, reportPath) };
}

export const runPhases = Object.freeze(Object.keys(transitions));
