import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertRunLock, readRun } from "./run-state.js";

const text = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd, args) => execFileSync("git", args, { cwd, stdio: "ignore" });
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
  try { defaultBranch = text(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, ""); }
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

function assertValidatedIteration(report) {
  const iteration = report.iterations?.at(-1);
  if (!report.targetRuby || !report.targetPinnedAt) {
    throw new CommitGateError("The report must pin targetRuby and targetPinnedAt before an automatic commit.", "target-not-pinned");
  }
  if (!iteration || iteration.status !== "complete" || iteration.tests?.passed !== true) {
    throw new CommitGateError("The latest hop is not recorded as complete with passing tests.", "validation-missing");
  }
  if (!iteration.from || !iteration.to) {
    throw new CommitGateError("The latest report iteration needs both from and to Ruby versions.", "invalid-iteration");
  }
  return iteration;
}

function assertExpectedHead(cwd, state, report, reportPath) {
  const expected = report.startingSha;
  if (expected && state.sha === expected) return;
  const previousMessage = text(cwd, ["log", "-1", "--format=%B"]);
  if (previousMessage.includes(`Ruby-Upgrade-Report: ${reportPath}`) && previousMessage.includes("Ruby-Upgrade-Hop:")) return;
  if (!expected || state.sha !== expected) {
    throw new CommitGateError("HEAD no longer matches the recorded upgrade baseline; refusing to commit mixed changes.", "unexpected-head");
  }
}

function stagedSecretPaths(cwd) {
  const names = text(cwd, ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
  const indicators = [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
    /(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\n]{8,}["']/i
  ];
  return names.filter((name) => {
    try {
      const contents = execFileSync("git", ["show", `:${name}`], { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
      return indicators.some((pattern) => pattern.test(contents));
    } catch { return false; }
  });
}

function executableHooks(cwd) {
  let hooksPath;
  try { hooksPath = text(cwd, ["config", "--get", "core.hooksPath"]); }
  catch { hooksPath = text(cwd, ["rev-parse", "--git-path", "hooks"]); }
  const directory = path.resolve(cwd, hooksPath);
  try { return fs.readdirSync(directory).filter((name) => !name.endsWith(".sample") && (fs.statSync(path.join(directory, name)).mode & 0o111)); }
  catch { return []; }
}

function assertScopedChanges(cwd, iteration, reportPath) {
  const changed = text(cwd, ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
  const declared = new Set([...(iteration.files ?? []), reportPath, reportPath.replace(/\.json$/, ".md")]);
  const unexpected = changed.filter((file) => !declared.has(file));
  if (unexpected.length) throw new CommitGateError(`Changed files were not declared by this hop: ${unexpected.join(", ")}. Add them with an explanation or stop for review.`, "unexpected-change-scope");
  if (!changed.length) throw new CommitGateError("There are no migration changes to commit.", "nothing-to-commit");
  return changed;
}

function dependencyGate(cwd, changed, iteration, { allowBroadLockfile, allowPrivateSources }) {
  const lockfiles = changed.filter((file) => /(?:^|\/)(?:Gemfile\.lock|gems\.lock)$/i.test(file));
  if (lockfiles.length && iteration.dependencyReview?.completed !== true) throw new CommitGateError("A changed lockfile requires dependencyReview.completed: true with compatibility and license findings recorded.", "dependency-review-missing");
  for (const lockfile of lockfiles) {
    const lines = text(cwd, ["diff", "--cached", "--numstat", "--", lockfile]).split("\t");
    if ((Number(lines[0]) + Number(lines[1])) > 500 && !allowBroadLockfile) throw new CommitGateError(`Lockfile churn in ${lockfile} exceeds 500 changed lines. Review it and explicitly continue with --allow-broad-lockfile.`, "broad-lockfile-churn");
    const content = execFileSync("git", ["show", `:${lockfile}`], { cwd, encoding: "utf8" });
    if (/^\s*remote:\s*(?!https:\/\/rubygems\.org)/m.test(content) && !allowPrivateSources) throw new CommitGateError(`A non-RubyGems source appears in ${lockfile}. Review its trust and explicitly continue with --allow-private-sources.`, "private-dependency-source");
  }
}

function commit(cwd, message) {
  try { execFileSync("git", ["commit", "-m", message], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) {
    const detail = String(error.stderr ?? error.message);
    if (/Author identity unknown|unable to auto-detect email/i.test(detail)) throw new CommitGateError("Git author identity is not configured. Configure user.name and user.email yourself, then resume the run; this tool will not change Git configuration.", "git-identity-missing");
    if (/gpg failed|failed to sign/i.test(detail)) throw new CommitGateError("Git commit signing failed. Repair your local signing setup or disable it yourself, then resume the run.", "git-signing-failed");
    throw new CommitGateError(`Git refused the local commit: ${detail.trim()}`, "git-commit-failed");
  }
}

function messageFor(iteration, reportPath) {
  return [
    `chore(ruby): upgrade ${iteration.from} to ${iteration.to}`,
    "",
    "Apply the smallest compatible runtime, dependency, and code changes for this Ruby minor-version hop.",
    `Validation: ${iteration.tests.command || "project test suite"}.`,
    `Evidence: ${reportPath}`,
    `Ruby-Upgrade-Report: ${reportPath}`,
    `Ruby-Upgrade-Hop: ${iteration.from}->${iteration.to}`
  ].join("\n");
}

export function commitValidatedHop({ cwd = process.cwd(), reportPath, allowHooks = false, allowBroadLockfile = false, allowPrivateSources = false }) {
  if (!reportPath) throw new CommitGateError("Provide --report .ruby-upgrades/runs/<run>.json.", "missing-report-path");
  const state = gitState(cwd);
  if (!state.linked || !state.branch || ["main", "master", state.defaultBranch].includes(state.branch)) {
    throw new CommitGateError("Automatic commits require a non-default branch in a linked worktree.", "unsafe-worktree");
  }
  if (text(cwd, ["diff", "--cached", "--name-only"])) {
    throw new CommitGateError("The staging area was not empty before the commit gate ran.", "staging-not-clean");
  }
  const { fullPath, report } = readReport(state.root, reportPath);
  try { assertRunLock(state.root, reportPath); }
  catch (error) { throw new CommitGateError(error.message, error.code); }
  const iteration = assertValidatedIteration(report);
  if (report.schemaVersion === 1 && report.phase !== "hop_validated") throw new CommitGateError("The run must transition to hop_validated before an automatic commit.", "phase-not-validated");
  assertExpectedHead(cwd, state, report, path.relative(state.root, fullPath));
  run(cwd, ["add", "--all"]);
  const relativeReport = path.relative(state.root, fullPath);
  let changed;
  try {
    changed = assertScopedChanges(cwd, iteration, relativeReport);
    dependencyGate(cwd, changed, iteration, { allowBroadLockfile, allowPrivateSources });
    const hooks = executableHooks(cwd);
    if (hooks.length && !allowHooks) throw new CommitGateError(`Executable Git hooks are active: ${hooks.join(", ")}. Review them and explicitly continue with --allow-hooks.`, "active-git-hooks");
  } catch (error) {
    run(cwd, ["reset"]);
    throw error;
  }
  const secretPaths = stagedSecretPaths(cwd);
  if (secretPaths.length) {
    run(cwd, ["reset"]);
    throw new CommitGateError(`Potential credential material detected in: ${secretPaths.join(", ")}. Review it manually; it was not committed.`, "secret-detected");
  }

  const message = messageFor(iteration, relativeReport);
  commit(cwd, message);
  return { sha: text(cwd, ["rev-parse", "HEAD"]), message, branch: state.branch, report: relativeReport };
}
