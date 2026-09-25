import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectGitCapabilities, inspectWorktree } from "../src/preflight.js";
import { createLinkedWorktree } from "./helpers/git-worktree.js";

test("identifies a non-Git project for dry-run inventory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-upgrade-no-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(inspectWorktree(root), { ok: true, mode: "non-git", root });
});

test("blocks a primary checkout and accepts a linked worktree", (t) => {
  const { primary, linked } = createLinkedWorktree(t);
  assert.equal(inspectWorktree(primary).reason, "primary-checkout");
  assert.equal(inspectWorktree(linked).ok, true);
  fs.mkdirSync(path.join(linked, ".ruby-upgrades", "runs"), { recursive: true });
  fs.writeFileSync(path.join(linked, ".ruby-upgrades", "runs", "run.json"), "{}\n");
  assert.equal(inspectWorktree(linked).ok, true);
  fs.writeFileSync(path.join(linked, "uncommitted.txt"), "nope\n");
  assert.equal(inspectWorktree(linked).reason, "dirty-worktree");
});

test("fails closed when no explicit default branch is configured", (t) => {
  const { linked } = createLinkedWorktree(t, { prefix: "ruby-upgrade-default-", configureDefaultBranch: false });
  assert.equal(inspectWorktree(linked).reason, "default-branch-unconfigured");
});

test("capability detection ignores ambient global git config", (t) => {
  const { linked } = createLinkedWorktree(t, { prefix: "ruby-capabilities-" });
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-gitconfig-"));
  t.after(() => fs.rmSync(globalDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(globalDir, "gitconfig"), '[filter "lfs"]\n\tsmudge = git-lfs smudge -- %f\n\tclean = git-lfs clean -- %f\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(globalDir, "gitconfig");
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  assert.equal(inspectGitCapabilities(linked).lfsConfigured, false);
  assert.equal(inspectGitCapabilities(linked).supported, true);
});

test("detects repository-local LFS from .gitattributes", (t) => {
  // A realistic attribute scope (specific patterns, not `*`) keeps the
  // .gitattributes file itself out of the LFS clean filter, so its committed
  // blob remains plain text even on hosts with git-lfs installed.
  const { linked } = createLinkedWorktree(t, { prefix: "ruby-lfs-", files: { "README.md": "test\n", ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" } });
  assert.equal(inspectGitCapabilities(linked).lfsConfigured, true);
  assert.equal(inspectGitCapabilities(linked).recommendation, "Standard Git topology.");
});
