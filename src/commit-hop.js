import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertRunLock, readRun } from "./run-state.js";
import { receiptDigest, worktreeFingerprint } from "./provenance.js";

const text = (cwd, args, env) => execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd, args, env) => execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
const within = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

export class CommitGateError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function gitState(cwd) {
  const root = text(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = text(cwd, ["rev-parse", "--git-dir"]);
  const commonDir = text(cwd, ["rev-parse", "--git-common-dir"]);
  const linked = path.resolve(root, gitDir) !== path.resolve(root, commonDir);
  const branch = text(cwd, ["branch", "--show-current"]);
  let defaultBranch;
  try { defaultBranch = text(cwd, ["config", "--get", "opencode-ruby-upgrader.defaultBranch"]); }
  catch { defaultBranch = undefined; }
  return { root, linked, branch, defaultBranch, sha: text(cwd, ["rev-parse", "HEAD"]) };
}

function readReport(root, reportPath) {
  const fullPath = path.resolve(root, reportPath);
  const allowedDirectory = path.join(root, ".ruby-upgrades", "runs");
  if (!within(allowedDirectory, fullPath) || path.extname(fullPath) !== ".json") {
    throw new CommitGateError("Report must be a JSON file under .ruby-upgrades/runs/.", "invalid-report-path");
  }
  try { return { fullPath, report: readRun(root, reportPath) }; }
  catch { throw new CommitGateError("The upgrade report is missing or fails the run schema.", "invalid-report"); }
}

function assertValidatedIteration(report, rails = false) {
  const iteration = report.iterations?.at(-1);
  if (rails ? (!report.targetRails || !report.targetRailsPinnedAt || !report.bridge) : (!report.targetRuby || !report.targetPinnedAt)) {
    throw new CommitGateError("The report must pin its target and bridge evidence before an automatic commit.", "target-not-pinned");
  }
  if (!iteration || iteration.status !== "complete" || iteration.tests?.passed !== true) {
    throw new CommitGateError("The latest hop is not recorded as complete with passing tests.", "validation-missing");
  }
  if (iteration.checkpointSha) throw new CommitGateError("The latest iteration already has a checkpoint; record the next hop before committing again.", "iteration-already-checkpointed");
  if (!Array.isArray(iteration.validationReceipts) || !iteration.validationReceipts.length) {
    throw new CommitGateError("The latest hop requires an executed validation receipt.", "validation-receipt-missing");
  }
  if (!iteration.from || !iteration.to) {
    throw new CommitGateError("The latest report iteration needs both from and to Ruby versions.", "invalid-iteration");
  }
  if (!Array.isArray(iteration.fixes) || !iteration.fixes.length || !Array.isArray(iteration.citations) || !iteration.citations.length || !iteration.tests?.smoke) {
    throw new CommitGateError("The latest hop requires explained fixes, citations, and smoke-test evidence.", "evidence-missing");
  }
  if (rails && !iteration.appUpdateReview) throw new CommitGateError("The latest Rails hop requires reviewed bin/rails app:update evidence.", "app-update-review-missing");
  return iteration;
}

function assertExpectedHead(state, report) {
  if (!report.expectedHead || state.sha !== report.expectedHead) {
    throw new CommitGateError("HEAD no longer matches the recorded upgrade baseline; refusing to commit mixed changes.", "unexpected-head");
  }
}

function stagedSecretPaths(cwd, env) {
  const tokens = text(cwd, ["diff", "--cached", "--name-status", "-z"], env).split("\0").filter(Boolean);
  const names = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (/^[MACD]/.test(status)) {
      if (status.charAt(0) !== "D") names.push(tokens[i + 1]);
      i += 1;
    } else if (/^[RC]\d{3}$/.test(status)) {
      names.push(tokens[i + 2]);
      i += 2;
    }
  }
  const indicators = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/,
    /\b(?:xox[baprs]-|npm_|glpat-)[A-Za-z0-9_-]{16,}/,
    /(?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*["'][^"'\n]{8,}["']/i
  ];
  const flagged = [];
  for (const name of names) {
    try {
      const size = Number(text(cwd, ["cat-file", "-s", `:${name}`], env));
      if (!Number.isSafeInteger(size) || size > 2 * 1024 * 1024) { flagged.push(name); continue; }
      const contents = execFileSync("git", ["show", `:${name}`], { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
      if (contents.includes("\0") || indicators.some((pattern) => pattern.test(contents))) flagged.push(name);
    } catch { flagged.push(name); }
  }
  return flagged;
}

function executableHooks(cwd) {
  let hooksPath;
  try { hooksPath = text(cwd, ["config", "--get", "core.hooksPath"]); }
  catch { hooksPath = text(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]); }
  const directory = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(text(cwd, ["rev-parse", "--show-toplevel"]), hooksPath);
  try { return fs.readdirSync(directory).filter((name) => !name.endsWith(".sample") && (fs.statSync(path.join(directory, name)).mode & 0o111)); }
  catch { return []; }
}

function assertScopedChanges(cwd, iteration, reportPath, env) {
  const changed = text(cwd, ["diff", "--cached", "--name-only", "-z"], env).split("\0").filter(Boolean);
  const declared = new Set([...(iteration.files ?? []), reportPath, reportPath.replace(/\.json$/, ".md")]);
  const unexpected = changed.filter((file) => !declared.has(file));
  if (unexpected.length) throw new CommitGateError(`Changed files were not declared by this hop: ${unexpected.join(", ")}. Add them with an explanation or stop for review.`, "unexpected-change-scope");
  if (!changed.length) throw new CommitGateError("There are no migration changes to commit.", "nothing-to-commit");
  return changed;
}

function unstageUnrelatedEvidence(cwd, iteration, reportPath, env) {
  const declared = new Set([...(iteration.files ?? []), reportPath, reportPath.replace(/\.json$/, ".md")]);
  const staged = text(cwd, ["diff", "--cached", "--name-only", "-z"], env).split("\0").filter(Boolean);
  const localEvidence = staged.filter((file) => file.startsWith(".ruby-upgrades/") && !declared.has(file));
  if (localEvidence.length) run(cwd, ["reset", "-q", "HEAD", "--", ...localEvidence], env);
}

function dependencyGate(cwd, changed, iteration, { allowBroadLockfile, allowPrivateSources }, env) {
  const lockfiles = changed.filter((file) => /(?:^|\/)(?:Gemfile\.lock|gems\.lock)$/i.test(file));
  if (lockfiles.length && iteration.dependencyReview?.completed !== true) throw new CommitGateError("A changed lockfile requires dependencyReview.completed: true with compatibility and license findings recorded.", "dependency-review-missing");
  for (const lockfile of lockfiles) {
    const lines = text(cwd, ["diff", "--cached", "--numstat", "--", lockfile], env).split("\t");
    if ((Number(lines[0]) + Number(lines[1])) > 500 && !allowBroadLockfile) throw new CommitGateError(`Lockfile churn in ${lockfile} exceeds 500 changed lines. Review it and explicitly continue with --allow-broad-lockfile.`, "broad-lockfile-churn");
    const content = execFileSync("git", ["show", `:${lockfile}`], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
    const remotes = [...content.matchAll(/^\s*remote:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    if (remotes.some((remote) => !/^https:\/\/rubygems\.org\/?$/i.test(remote)) && !allowPrivateSources) throw new CommitGateError(`A non-RubyGems source appears in ${lockfile}. Review its trust and explicitly continue with --allow-private-sources.`, "private-dependency-source");
  }
  const gemfiles = changed.filter((file) => /(?:^|\/)Gemfile$/i.test(file));
  for (const gemfile of gemfiles) {
    const content = execFileSync("git", ["show", `:${gemfile}`], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
    if (/(?:git|github|path)\s*:\s*["']/i.test(content) || /\bsource\s*["'](?!https:\/\/rubygems\.org\/?["'])/i.test(content)) {
      if (!allowPrivateSources) throw new CommitGateError(`A non-standard or non-RubyGems dependency source appears in ${gemfile}. Review its trust and explicitly continue with --allow-private-sources.`, "private-dependency-source");
    }
  }
}

function commit(cwd, message, env) {
  try { execFileSync("git", ["commit", "-m", message], { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) {
    const detail = String(error.stderr ?? error.message);
    if (/cannot lock ref|is at .+ but expected|reference transaction/i.test(detail)) throw new CommitGateError("Git history changed while the checkpoint was being created. The migration changes were not committed; review the new commit and resume only after explicit review.", "unexpected-head");
    if (/Author identity unknown|unable to auto-detect email/i.test(detail)) throw new CommitGateError("Git author identity is not configured. Configure user.name and user.email yourself, then resume the run; this tool will not change Git configuration.", "git-identity-missing");
    if (/gpg failed|failed to sign/i.test(detail)) throw new CommitGateError("Git commit signing failed. Repair your local signing setup or disable it yourself, then resume the run.", "git-signing-failed");
    throw new CommitGateError(`Git refused the local commit: ${detail.trim()}`, "git-commit-failed");
  }
}

function finalTestReceipt(iteration) {
  return iteration.validationReceipts.findLast((receipt) => receipt.kind === "test" && receipt.exitCode === 0 && receipt.testEvidence?.passed === true);
}

function assertValidationFingerprint(cwd, iteration) {
  const receipt = finalTestReceipt(iteration);
  const current = worktreeFingerprint(cwd);
  if (!receipt || receipt.worktree.headSha !== current.headSha || receipt.worktree.diffSha256 !== current.diffSha256) {
    throw new CommitGateError("The working tree changed after final validation; rerun validation before committing.", "validation-fingerprint-mismatch");
  }
}

function messageFor(iteration, reportPath, report, rails = false) {
  const receiptTrailer = iteration.validationReceipts?.length ? [`Validation-Receipt-Digest: sha256:${receiptDigest(iteration.validationReceipts)}`] : [];
  if (rails) return [
    `chore(rails): upgrade ${iteration.from} to ${iteration.to}`, "", "Apply the reviewed Rails framework compatibility changes.", `Validation: ${iteration.tests.command || "project test suite"}.`, `Evidence: ${reportPath}`,
    `Rails-Upgrade-Report: ${reportPath}`, `Rails-Upgrade-Hop: ${iteration.from}->${iteration.to}`, `Rails-App-Update-Reviewed: ${iteration.from}->${iteration.to}`, `Rails-Bridge-Ruby-Report: ${report.bridge.rubyReportPath}`, ...receiptTrailer
  ].join("\n");
  return [
    `chore(ruby): upgrade ${iteration.from} to ${iteration.to}`,
    "",
    "Apply the smallest compatible runtime, dependency, and code changes for this Ruby minor-version hop.",
    `Validation: ${iteration.tests.command || "project test suite"}.`,
    `Evidence: ${reportPath}`,
    `Ruby-Upgrade-Report: ${reportPath}`,
    `Ruby-Upgrade-Hop: ${iteration.from}->${iteration.to}`, ...receiptTrailer
  ].join("\n");
}

function commitValidated({ cwd = process.cwd(), reportPath, allowHooks = false, allowBroadLockfile = false, allowPrivateSources = false, rails = false }) {
  if (!reportPath) throw new CommitGateError("Provide --report .ruby-upgrades/runs/<run>.json.", "missing-report-path");
  const state = gitState(cwd);
  if (!state.linked || !state.branch || !state.defaultBranch || state.branch === state.defaultBranch) {
    throw new CommitGateError("Automatic commits require a configured default branch and a different branch in a linked worktree.", "unsafe-worktree");
  }
  if (text(cwd, ["diff", "--cached", "--name-only"])) {
    throw new CommitGateError("The staging area was not empty before the commit gate ran.", "staging-not-clean");
  }
  const { fullPath, report } = readReport(state.root, reportPath);
  if (!report.lockNonce) throw new CommitGateError("The report is missing its active lock capability.", "lock-capability-missing");
  try { assertRunLock(state.root, reportPath, report.lockNonce); }
  catch (error) { throw new CommitGateError(error.message, error.code); }
  const iteration = assertValidatedIteration(report, rails);
  if (report.schemaVersion !== 2 || report.phase !== "hop_validated" || Boolean(report.reportType === "rails_bridge") !== rails) throw new CommitGateError("The run must use the current schema and transition to hop_validated before an automatic commit.", "phase-not-validated");
  if (report.branch !== state.branch) throw new CommitGateError("The worktree branch no longer matches the recorded run branch.", "unexpected-branch");
  assertExpectedHead(state, report);
  const indexPath = path.resolve(cwd, text(cwd, ["rev-parse", "--git-path", "index"]));
  const lockPath = `${indexPath}.lock`;
  const temporaryIndex = path.join(path.dirname(indexPath), `.opencode-ruby-upgrader-${process.pid}-${Date.now()}.index`);
  try { fs.writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 }); }
  catch { throw new CommitGateError("The Git index is busy; retry after the other Git operation finishes.", "index-busy"); }
  const env = { GIT_INDEX_FILE: temporaryIndex };
  let committed = false;
  try {
    run(cwd, ["read-tree", "HEAD"], env);
    run(cwd, ["add", "--all"], env);
    const relativeReport = path.relative(state.root, fullPath);
    unstageUnrelatedEvidence(cwd, iteration, relativeReport, env);
    const changed = assertScopedChanges(cwd, iteration, relativeReport, env);
    dependencyGate(cwd, changed, iteration, { allowBroadLockfile, allowPrivateSources }, env);
    const hooks = executableHooks(cwd);
    if (hooks.length && !allowHooks) throw new CommitGateError(`Executable Git hooks are active: ${hooks.join(", ")}. Review them and explicitly continue with --allow-hooks.`, "active-git-hooks");
  const secretPaths = stagedSecretPaths(cwd, env);
  if (secretPaths.length) {
    throw new CommitGateError(`Potential credential material detected in: ${secretPaths.join(", ")}. Review it manually; it was not committed.`, "secret-detected");
  }

  const message = messageFor(iteration, relativeReport, report, rails);
    assertValidationFingerprint(cwd, iteration);
    if (text(cwd, ["rev-parse", "HEAD"]) !== report.expectedHead) throw new CommitGateError("HEAD changed while the commit gate was validating; refusing to commit atop unexpected history.", "unexpected-head");
    commit(cwd, message, env);
    committed = true;
    fs.renameSync(temporaryIndex, lockPath);
    fs.renameSync(lockPath, indexPath);
    return { sha: text(cwd, ["rev-parse", "HEAD"]), message, branch: state.branch, report: relativeReport };
  } finally {
    if (!committed) fs.rmSync(temporaryIndex, { force: true });
    fs.rmSync(lockPath, { force: true });
  }
}

export function commitValidatedHop(options = {}) { return commitValidated(options); }
export function commitValidatedRailsHop(options = {}) { return commitValidated({ ...options, rails: true }); }
