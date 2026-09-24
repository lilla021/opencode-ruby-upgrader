import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitValidatedHop, commitValidatedRailsHop, CommitGateError } from "../src/commit-hop.js";
import { acquireRunLock, assertRunLock, validateRun, writeRun } from "../src/run-state.js";
import { resumeRun, transitionRun } from "../src/controller.js";
import { worktreeFingerprint } from "../src/provenance.js";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const testReceipt = (root) => ({ receiptVersion: 1, id: "11111111-1111-4111-8111-111111111111", kind: "test", commandId: "bundle-rspec", argv: ["bundle", "exec", "rspec"], startedAt: "2026-09-09T00:02:00Z", finishedAt: "2026-09-09T00:02:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "a".repeat(64), bytes: 22 }, worktree: worktreeFingerprint(root), testEvidence: { passed: true } });
const appUpdateReceipt = (root) => ({ receiptVersion: 1, id: "22222222-2222-4222-8222-222222222222", kind: "rails_app_update", commandId: "rails-app-update", argv: ["bin/rails", "app:update"], startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "b".repeat(64), bytes: 10 }, worktree: worktreeFingerprint(root) });

function worktree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-commit-gate-"));
  const linked = `${root}-linked`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "opencode-ruby-upgrader.defaultBranch", "master"]);
  fs.writeFileSync(path.join(root, "README.md"), "initial\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]);
  const startingSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["worktree", "add", "-b", "ruby-upgrade/ruby-3.3", linked]);
  return { linked, startingSha };
}

function writeCompleteReport(root, startingSha, branch, from = "3.2.x", to = "3.3.x", expectedHead = startingSha, files = ["README.md"]) {
  const reportPath = ".ruby-upgrades/runs/run.json";
  let lock; try { lock = assertRunLock(root, reportPath); } catch { lock = acquireRunLock(root, reportPath); }
  writeRun(root, reportPath, { schemaVersion: 2, validationReceiptsRequired: true, runId: "11111111-1111-4111-8111-111111111111", lockNonce: lock.nonce, title: "Test migration", status: "in_progress", phase: "hop_validated", startedAt: "2026-09-09T00:00:00Z", targetRuby: "3.4", targetPinnedAt: "2026-09-09T00:00:00Z", branch, startingSha, expectedHead, control: { stopAfterHop: false }, gitCapabilities: { supported: true }, research: { ladder: ["3.2", "3.3", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] }, riskDecisions: [], iterations: [{ from, to, status: "complete", files, dependencyReview: { completed: true, compatibility: "Reviewed.", licenses: "Reviewed." }, fixes: [{ files, explanation: "Compatibility update." }], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }], tests: { passed: true, command: "bundle exec rspec", smoke: "Boot passed." }, validationReceipts: [testReceipt(root)] }] });
  return reportPath;
}

function writeRailsReport(root, startingSha, branch) {
  const reportPath = ".ruby-upgrades/runs/rails.json"; const lock = acquireRunLock(root, reportPath);
  const update = appUpdateReceipt(root);
  writeRun(root, reportPath, { schemaVersion: 2, validationReceiptsRequired: true, reportType: "rails_bridge", runId: "22222222-2222-4222-8222-222222222222", lockNonce: lock.nonce, title: "Rails bridge", status: "in_progress", phase: "hop_validated", startedAt: "2026-09-09T00:00:00Z", targetRails: "7.0", targetRailsPinnedAt: "2026-09-09T00:00:00Z", branch, startingSha, expectedHead: startingSha, control: { stopAfterHop: false }, gitCapabilities: { supported: true }, bridge: { rubyReportPath: ".ruby-upgrades/runs/ruby.json", rubyRunId: "11111111-1111-4111-8111-111111111111", rubyFrom: "3.0", rubyTo: "3.1", railsFrom: "6.1", railsTo: "7.0", approvedAt: "2026-09-09T00:00:00Z" }, research: { ladder: ["6.1", "7.0"], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }, riskDecisions: [], requiredRisks: [], iterations: [{ from: "6.1", to: "7.0", status: "complete", files: ["README.md"], fixes: [{ files: ["README.md"], explanation: "Framework compatibility update." }], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }], tests: { passed: true, command: "bundle exec rspec", smoke: "Boot passed." }, validationReceipts: [update, testReceipt(root)], appUpdateReview: { command: "bin/rails app:update", receiptId: update.id, executedAt: update.startedAt, reviewedAt: "2026-09-09T00:01:00Z", worktree: update.worktree, outcome: "no_changes", files: [], summary: "Reviewed generated changes." } }] });
  return reportPath;
}

test("commits a validated hop locally and permits the next recorded hop", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "Ruby 3.3\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  const first = commitValidatedHop({ cwd: linked, reportPath });
  assert.match(first.sha, /^[0-9a-f]{40}$/);
  assert.match(git(linked, ["log", "-1", "--format=%B"]), /Ruby-Upgrade-Report: .ruby-upgrades\/runs\/run.json/);

  fs.appendFileSync(path.join(linked, "README.md"), "Ruby 3.4\n");
  writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3", "3.3.x", "3.4.x", first.sha);
  const second = commitValidatedHop({ cwd: linked, reportPath });
  assert.notEqual(second.sha, first.sha);
  assert.equal(git(linked, ["status", "--porcelain"]), "");
});

test("commits active evidence while leaving runtime and stale reports local", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "Ruby 3.3\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  fs.writeFileSync(path.join(linked, ".ruby-upgrades", "runtime.json"), "{}\n");
  fs.writeFileSync(path.join(linked, ".ruby-upgrades", "runs", "stale.json"), "{}\n");
  fs.writeFileSync(path.join(linked, ".ruby-upgrades", "runs", "stale.md"), "stale\n");
  commitValidatedHop({ cwd: linked, reportPath });
  const committed = git(linked, ["show", "--format=", "--name-only", "HEAD"]).split("\n");
  assert.ok(committed.includes("README.md"));
  assert.ok(committed.includes(reportPath));
  assert.equal(committed.includes(".ruby-upgrades/runtime.json"), false);
  assert.match(git(linked, ["status", "--porcelain"]), /runtime\.json/);
  assert.match(git(linked, ["status", "--porcelain"]), /stale\.json/);
});

test("accepts the official RubyGems lockfile source", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.writeFileSync(path.join(linked, "Gemfile.lock"), "GEM\n  remote: https://rubygems.org/\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3", "3.2.x", "3.3.x", startingSha, ["Gemfile.lock"]);
  assert.doesNotThrow(() => commitValidatedHop({ cwd: linked, reportPath }));
});

test("blocks credential-like changes and restores an empty staging area", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.writeFileSync(path.join(linked, ".env"), 'API_KEY="not-a-real-secret-value"\n');
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3", "3.2.x", "3.3.x", startingSha, ["README.md", ".env"]);
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "secret-detected");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
  assert.equal(git(linked, ["rev-parse", "HEAD"]), startingSha);
});

test("blocks changes omitted from the hop manifest", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.writeFileSync(path.join(linked, "unexpected.rb"), "puts :surprise\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "unexpected-change-scope");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
});

test("rejects declared working-tree changes made after validation", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "validated change\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  fs.appendFileSync(path.join(linked, "README.md"), "post-validation change\n");
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "validation-fingerprint-mismatch");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
});

test("pauses before running an executable Git hook", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "hook review\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  const hooksDirectory = git(linked, ["rev-parse", "--git-path", "hooks"]);
  fs.mkdirSync(hooksDirectory, { recursive: true });
  const hook = path.join(hooksDirectory, "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n"); fs.chmodSync(hook, 0o755);
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "active-git-hooks");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
});

test("blocks a report whose expected checkpoint is not HEAD", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "tampered baseline\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3", "3.2.x", "3.3.x", "0".repeat(40));
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "unexpected-head");
});

test("unstages changes when Git refuses the final checkpoint commit", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "commit failure\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  const hooksDirectory = git(linked, ["rev-parse", "--git-path", "hooks"]);
  fs.mkdirSync(hooksDirectory, { recursive: true });
  const hook = path.join(hooksDirectory, "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n"); fs.chmodSync(hook, 0o755);
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath, allowHooks: true }), (error) => error instanceof CommitGateError && error.code === "git-commit-failed");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
  assert.equal(git(linked, ["rev-parse", "HEAD"]), startingSha);
});

test("verifies the real checkpoint and enforces stop-after-hop before continuation", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "first hop\n");
  const reportPath = writeCompleteReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  const reportFile = path.join(linked, reportPath);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  report.control.stopAfterHop = true;
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const checkpoint = commitValidatedHop({ cwd: linked, reportPath });
  const paused = transitionRun({ root: linked, reportPath, phase: "committed", commitSha: checkpoint.sha });
  assert.equal(paused.phase, "paused");
  assert.equal(paused.status, "paused");
  assert.throws(() => resumeRun({ root: linked, reportPath }), /continue-after-hop/);
  const resumed = resumeRun({ root: linked, reportPath, continueAfterHop: true });
  assert.equal(resumed.run.phase, "committed");
  assert.equal(resumed.run.control.stopAfterHop, false);
  assert.throws(() => transitionRun({ root: linked, reportPath, phase: "hop_validated" }), /checkpointed iteration cannot be validated again/);
});

test("commits a reviewed Rails bridge hop with Rails-specific trailers", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "Rails 7.0\n");
  const reportPath = writeRailsReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  const checkpoint = commitValidatedRailsHop({ cwd: linked, reportPath });
  const message = git(linked, ["log", "-1", "--format=%B"]);
  assert.match(message, /Rails-Upgrade-Hop: 6.1->7.0/); assert.match(message, /Rails-App-Update-Reviewed: 6.1->7.0/);
  assert.equal(transitionRun({ root: linked, reportPath, phase: "committed", commitSha: checkpoint.sha }).phase, "committed");
});

test("rejects Rails receipts that do not preserve app:update review test order", (t) => {
  const { linked, startingSha } = worktree(t);
  fs.appendFileSync(path.join(linked, "README.md"), "Rails 7.0\n");
  const reportPath = writeRailsReport(linked, startingSha, "ruby-upgrade/ruby-3.3");
  const report = JSON.parse(fs.readFileSync(path.join(linked, reportPath), "utf8"));
  report.iterations[0].validationReceipts.reverse();
  assert.equal(validateRun(report).valid, false);
  report.iterations[0].validationReceipts.reverse();
  report.iterations[0].validationReceipts[0].output.summary = "raw output must not persist";
  assert.equal(validateRun(report).valid, false);
});
