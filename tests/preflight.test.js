import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectWorktree } from "../src/preflight.js";
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
