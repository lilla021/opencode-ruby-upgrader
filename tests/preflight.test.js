import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectWorktree } from "../src/preflight.js";

const git = (cwd, args) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("allows a non-Git project without Git checkpointing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-upgrade-no-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(inspectWorktree(root), { ok: true, mode: "non-git", root });
});

test("blocks a primary checkout and accepts a linked worktree", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "opencode-ruby-upgrader.defaultBranch", "master"]);
  fs.writeFileSync(path.join(root, "README.md"), "test\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]);
  assert.equal(inspectWorktree(root).reason, "primary-checkout");
  const worktree = `${root}-worktree`;
  git(root, ["worktree", "add", "-b", "ruby-upgrade/ruby-3.4", worktree]);
  assert.equal(inspectWorktree(worktree).ok, true);
  fs.mkdirSync(path.join(worktree, ".ruby-upgrades", "runs"), { recursive: true });
  fs.writeFileSync(path.join(worktree, ".ruby-upgrades", "runs", "run.json"), "{}\n");
  assert.equal(inspectWorktree(worktree).ok, true);
  fs.writeFileSync(path.join(worktree, "uncommitted.txt"), "nope\n");
  assert.equal(inspectWorktree(worktree).reason, "dirty-worktree");
});

test("fails closed when no explicit default branch is configured", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-upgrade-default-"));
  const worktree = `${root}-worktree`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "test\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]);
  git(root, ["worktree", "add", "-b", "ruby-upgrade/ruby-3.4", worktree]);
  assert.equal(inspectWorktree(worktree).reason, "default-branch-unconfigured");
});
