import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitValidatedHop, CommitGateError } from "../src/commit-hop.js";
import { acquireRunLock } from "../src/run-state.js";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function worktree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-commit-gate-"));
  const linked = `${root}-linked`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "initial\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]);
  const startingSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["worktree", "add", "-b", "ruby-upgrade/ruby-3.3", linked]);
  return { linked, startingSha };
}

function writeCompleteReport(root, startingSha, from = "3.2.x", to = "3.3.x") {
  const directory = path.join(root, ".ruby-upgrades", "runs"); fs.mkdirSync(directory, { recursive: true });
  const reportPath = path.join(directory, "run.json");
  fs.writeFileSync(reportPath, JSON.stringify({ startingSha, targetRuby: "3.4.0", targetPinnedAt: "2026-09-09T00:00:00Z", iterations: [{ from, to, status: "complete", files: ["README.md"], tests: { passed: true, command: "bundle exec rspec" } }] }));
  return ".ruby-upgrades/runs/run.json";
}

test("commits a validated hop locally and permits the next recorded hop", (t) => {
  const { linked, startingSha } = worktree(t);
  const reportPath = writeCompleteReport(linked, startingSha);
  acquireRunLock(linked, reportPath);
  fs.appendFileSync(path.join(linked, "README.md"), "Ruby 3.3\n");
  const first = commitValidatedHop({ cwd: linked, reportPath });
  assert.match(first.sha, /^[0-9a-f]{40}$/);
  assert.match(git(linked, ["log", "-1", "--format=%B"]), /Ruby-Upgrade-Report: .ruby-upgrades\/runs\/run.json/);

  writeCompleteReport(linked, startingSha, "3.3.x", "3.4.x");
  fs.appendFileSync(path.join(linked, "README.md"), "Ruby 3.4\n");
  const second = commitValidatedHop({ cwd: linked, reportPath });
  assert.notEqual(second.sha, first.sha);
  assert.equal(git(linked, ["status", "--porcelain"]), "");
});

test("blocks credential-like changes and restores an empty staging area", (t) => {
  const { linked, startingSha } = worktree(t);
  const reportPath = writeCompleteReport(linked, startingSha);
  acquireRunLock(linked, reportPath);
  const reportFile = path.join(linked, reportPath);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  report.iterations[0].files.push(".env");
  fs.writeFileSync(reportFile, JSON.stringify(report));
  fs.writeFileSync(path.join(linked, ".env"), 'API_KEY="not-a-real-secret-value"\n');
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "secret-detected");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
  assert.equal(git(linked, ["rev-parse", "HEAD"]), startingSha);
});

test("blocks changes omitted from the hop manifest", (t) => {
  const { linked, startingSha } = worktree(t);
  const reportPath = writeCompleteReport(linked, startingSha);
  acquireRunLock(linked, reportPath);
  fs.writeFileSync(path.join(linked, "unexpected.rb"), "puts :surprise\n");
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "unexpected-change-scope");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
});

test("pauses before running an executable Git hook", (t) => {
  const { linked, startingSha } = worktree(t);
  const reportPath = writeCompleteReport(linked, startingSha);
  acquireRunLock(linked, reportPath);
  fs.appendFileSync(path.join(linked, "README.md"), "hook review\n");
  const hooksDirectory = git(linked, ["rev-parse", "--git-path", "hooks"]);
  fs.mkdirSync(hooksDirectory, { recursive: true });
  const hook = path.join(hooksDirectory, "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n"); fs.chmodSync(hook, 0o755);
  assert.throws(() => commitValidatedHop({ cwd: linked, reportPath }), (error) => error instanceof CommitGateError && error.code === "active-git-hooks");
  assert.equal(git(linked, ["diff", "--cached", "--name-only"]), "");
});
