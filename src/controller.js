import path from "node:path";
import { inspectGitCapabilities, inspectWorktree } from "./preflight.js";
import { inventoryProject } from "./inventory.js";
import { inspectSupplyChain } from "./supply-chain.js";
import { acquireRunLock, assertRunLock, readRun, writeRun } from "./run-state.js";

const rubyVersion = /^\d+\.\d+(?:\.\d+)?$/;
const runName = () => new Date().toISOString().replace(/[:.]/g, "-");
const transitions = {
  initialized: ["inventory_complete", "blocked"],
  inventory_complete: ["research_complete", "blocked"],
  research_complete: ["hop_validated", "blocked"],
  hop_validated: ["committed", "blocked"],
  committed: ["hop_validated", "complete", "blocked"],
  blocked: ["inventory_complete", "research_complete", "hop_validated"],
  complete: []
};

export function beginRun({ root = process.cwd(), target, dryRun = false, stopAfterHop = false, allowNonGit = false } = {}) {
  if (!target || !rubyVersion.test(target)) throw new Error("Provide --target as a Ruby version such as 3.4 or 3.4.1.");
  const preflight = inspectWorktree(root);
  const inventory = inventoryProject(root);
  const supplyChain = inspectSupplyChain(root);
  const gitCapabilities = inspectGitCapabilities(root);
  const plan = { preflight, inventory, supplyChain, gitCapabilities, targetRuby: target, dryRun, stopAfterHop };
  if (dryRun || !preflight.ok) return plan;
  if (preflight.mode === "non-git" && !allowNonGit) throw new Error("Non-Git runs need explicit consent: rerun begin with --allow-non-git after reviewing the loss of worktree isolation and checkpoint commits.");
  const reportPath = path.join(".ruby-upgrades", "runs", `${runName()}.json`);
  const report = {
    schemaVersion: 1, title: `Ruby migration to ${target}`, status: "in_progress", startedAt: new Date().toISOString(), targetRuby: target,
    targetPinnedAt: new Date().toISOString(), branch: preflight.branch ?? null, startingSha: preflight.sha ?? null,
    phase: "initialized", control: { stopAfterHop }, inventory, supplyChain, gitCapabilities, summary: ["Run initialized; official-source research and compatibility ladder pending."], iterations: [], sessionSummary: ""
  };
  writeRun(root, reportPath, report);
  const lock = acquireRunLock(root, reportPath);
  return { ...plan, reportPath, report, lock };
}

export function runStatus({ root = process.cwd(), reportPath }) { return readRun(root, reportPath); }

export function transitionRun({ root = process.cwd(), reportPath, phase, note = "" }) {
  if (!Object.hasOwn(transitions, phase)) throw new Error(`Unknown run phase: ${phase}.`);
  assertRunLock(root, reportPath);
  const run = readRun(root, reportPath);
  const current = run.phase ?? "initialized";
  if (!transitions[current]?.includes(phase)) throw new Error(`Cannot transition from ${current} to ${phase}.`);
  if (phase === "hop_validated") {
    const iteration = run.iterations?.at(-1);
    if (iteration?.status !== "complete" || iteration.tests?.passed !== true) throw new Error("A hop requires a complete iteration with passing tests before validation.");
  }
  run.phase = phase;
  run.status = phase === "complete" ? "complete" : phase === "blocked" ? "blocked" : "in_progress";
  if (note) run.summary = [...(run.summary ?? []), note];
  writeRun(root, reportPath, run);
  return run;
}

export const runPhases = Object.freeze(Object.keys(transitions));
