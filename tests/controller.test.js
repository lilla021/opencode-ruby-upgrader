import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginRun, transitionRun } from "../src/controller.js";
import { inventoryProject } from "../src/inventory.js";
import { inspectSupplyChain } from "../src/supply-chain.js";
import { parseTestEvidence } from "../src/test-evidence.js";

test("dry-run inventories a Ruby project without writing migration state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-controller-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rails"\ngem "rspec-rails"\n');
  fs.mkdirSync(path.join(root, "spec"));
  const plan = beginRun({ root, target: "3.4", dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.inventory.framework, "rails");
  assert.equal(fs.existsSync(path.join(root, ".ruby-upgrades")), false);
});

test("inventory, supply-chain, and test parsers produce structured evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\n');
  fs.writeFileSync(path.join(root, "Gemfile.lock"), "GEM\n  remote: https://rubygems.org/\n  specs:\n    rake (13.0.0)\n");
  assert.equal(inventoryProject(root).supported, true);
  assert.deepEqual(inspectSupplyChain(root).privateSources, []);
  assert.deepEqual(parseTestEvidence("2 examples, 0 failures\nFinished in 1.5 seconds", "bundle exec rspec"), { command: "bundle exec rspec", count: 2, passed: true, failures: 0, durationSeconds: 1.5, coveragePercent: null });
});

test("state transitions reject skipped phases and persist valid lifecycle steps", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\n');
  const run = beginRun({ root, target: "3.4", allowNonGit: true });
  assert.equal(run.report.phase, "initialized");
  assert.throws(() => transitionRun({ root, reportPath: run.reportPath, phase: "hop_validated" }), /Cannot transition/);
  assert.equal(transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" }).phase, "inventory_complete");
});
