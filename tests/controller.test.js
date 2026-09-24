import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginRailsBridgeRun, beginRun, discardLastRailsIteration, recordDependencyReview, recordExecutedIteration, recordFrameworkBridge, recordIteration, recordRailsIteration, recordRailsResearch, recordResearch, resumeRun, transitionRun } from "../src/controller.js";
import { inventoryProject } from "../src/inventory.js";
import { inspectSupplyChain } from "../src/supply-chain.js";
import { parseTestEvidence } from "../src/test-evidence.js";
import { writeRun } from "../src/run-state.js";

const testReceipt = () => ({ receiptVersion: 1, id: "11111111-1111-4111-8111-111111111111", kind: "test", commandId: "bundle-rake-test", argv: ["bundle", "exec", "rake", "test"], startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "a".repeat(64), summary: "1 runs, 0 failures" }, testEvidence: { passed: true } });
const appUpdateReceipt = () => ({ receiptVersion: 1, id: "22222222-2222-4222-8222-222222222222", kind: "rails_app_update", commandId: "rails-app-update", argv: ["bin/rails", "app:update"], startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "b".repeat(64), summary: "No changes" } });

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
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "Gemfile.lock"), "GEM\n  remote: https://rubygems.org/\n  specs:\n    rake (13.0.0)\n");
  assert.equal(inventoryProject(root).supported, true);
  assert.deepEqual(inspectSupplyChain(root).privateSources, []);
  assert.deepEqual(parseTestEvidence("2 examples, 0 failures\nFinished in 1.5 seconds", "bundle exec rspec"), { command: "bundle exec rspec", count: 2, passed: true, failures: 0, durationSeconds: 1.5, coveragePercent: null });
});

test("inventory resolves the locked Rails version", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-rails-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rails", "~> 7.1"\n');
  fs.writeFileSync(path.join(root, "Gemfile.lock"), "GEM\n  specs:\n    rails (7.1.5.1)\n");
  assert.deepEqual(inventoryProject(root).rails, { declaredVersion: "~> 7.1", resolvedVersion: "7.1.5.1" });
});

test("supply-chain inventory identifies custom Gemfile sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://private.example.test"\ngem "example"\n');
  assert.deepEqual(inspectSupplyChain(root).privateSources, ["https://private.example.test"]);
});

test("supply-chain inventory redacts credential-bearing sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-source-redaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://token:password@private.example.test/gems?token=secret"\n');
  assert.deepEqual(inspectSupplyChain(root).privateSources, ["https://[REDACTED]@private.example.test/gems?token=[REDACTED]"]);
});

test("supported Rails/RSpec and Minitest fixtures select the expected adapters", () => {
  const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
  const rails = inventoryProject(path.join(fixtures, "rails-rspec"));
  const minitest = inventoryProject(path.join(fixtures, "minitest"));
  assert.equal(rails.framework, "rails");
  assert.equal(rails.testFramework, "rspec");
  assert.equal(rails.rubyDeclarations[0].value, "3.3.6");
  assert.equal(minitest.testFramework, "minitest");
});

test("state transitions reject skipped phases and persist valid lifecycle steps", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\n');
  fs.mkdirSync(path.join(root, "test"));
  const run = beginRun({ root, target: "3.4", allowNonGit: true });
  assert.equal(run.report.phase, "initialized");
  assert.throws(() => transitionRun({ root, reportPath: run.reportPath, phase: "hop_validated" }), /Cannot transition/);
  assert.equal(transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" }).phase, "inventory_complete");
});

test("validation preflights report phase before resolving an executor command", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-validation-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\n');
  fs.mkdirSync(path.join(root, "test"));
  const run = beginRun({ root, target: "3.4", allowNonGit: true });
  assert.throws(() => recordExecutedIteration({ root, reportPath: run.reportPath, validationCommandId: "not-an-executor" }), /after research or a prior checkpoint/);
});

test("new reports reject asserted iterations before they can skip executed validation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-ladder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\n');
  fs.mkdirSync(path.join(root, "test"));
  const run = beginRun({ root, target: "3.4", allowNonGit: true });
  transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" });
  assert.throws(() => recordResearch({ root, reportPath: run.reportPath, ladder: ["3.2", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] }), /exactly one Ruby minor/);
  recordResearch({ root, reportPath: run.reportPath, ladder: ["3.2", "3.3", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: run.reportPath, phase: "research_complete" });
  const iteration = (from, to) => ({ from, to, files: ["Gemfile"], fixes: [{ files: ["Gemfile"], explanation: "Update runtime." }], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }], tests: { passed: true, command: "bundle exec rake test", smoke: "Boot passed." }, validationReceipts: [testReceipt()] });
  assert.throws(() => recordIteration({ root, reportPath: run.reportPath, iteration: iteration("3.2", "3.4") }), /record-executed-iteration/);
  assert.throws(() => recordIteration({ root, reportPath: run.reportPath, iteration: iteration("3.2", "3.3") }), /record-executed-iteration/);
});

test("Ruby research accepts a major-series boundary but still rejects a skipped minor", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-major-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'ruby "2.4.10"\n'); fs.mkdirSync(path.join(root, "test"));
  const run = beginRun({ root, target: "3.1", allowNonGit: true });
  transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" });
  const citations = [{ title: "Ruby", url: "https://www.ruby-lang.org/" }];
  assert.throws(() => recordResearch({ root, reportPath: run.reportPath, ladder: ["2.4", "2.5", "2.6", "3.0", "3.1"], citations }), /exactly one Ruby minor/);
  recordResearch({ root, reportPath: run.reportPath, ladder: ["2.4", "2.5", "2.6", "2.7", "3.0", "3.1"], citations });
});

test("records an approved Rails bridge for the next blocked Ruby hop", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-rails-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\ngem "rails", "~> 6.1"\n');
  fs.writeFileSync(path.join(root, "Gemfile.lock"), "GEM\n  specs:\n    rails (6.1.7.10)\n");
  fs.mkdirSync(path.join(root, "test"));
  const run = beginRun({ root, target: "3.1", allowNonGit: true });
  transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" });
  recordResearch({ root, reportPath: run.reportPath, ladder: ["3.0", "3.1"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: run.reportPath, phase: "research_complete" });
  assert.throws(() => recordFrameworkBridge({ root, reportPath: run.reportPath, rubyFrom: "3.0", rubyTo: "3.1", railsFrom: "7.0", railsTo: "7.1", rationale: "Compatibility", citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }), /detected Rails version/);
  const bridged = recordFrameworkBridge({ root, reportPath: run.reportPath, rubyFrom: "3.0", rubyTo: "3.1", railsFrom: "6.1", railsTo: "7.0", rationale: "Rails 6.1 blocks the target Ruby; the user approved a separate framework migration.", citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] });
  assert.equal(bridged.frameworkBridge.railsTo, "7.0");
  assert.equal(transitionRun({ root, reportPath: run.reportPath, phase: "blocked" }).status, "blocked");
  assert.throws(() => resumeRun({ root, reportPath: run.reportPath }), /cannot resume/);
});

test("records a Rails bridge after a committed Ruby checkpoint", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-committed-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'ruby "2.6.10"\ngem "rails", "4.2.11.3"\n');
  fs.writeFileSync(path.join(root, "Gemfile.lock"), "GEM\n  specs:\n    rails (4.2.11.3)\n"); fs.mkdirSync(path.join(root, "spec"));
  const started = beginRun({ root, target: "2.7.8", allowNonGit: true });
  transitionRun({ root, reportPath: started.reportPath, phase: "inventory_complete" });
  recordResearch({ root, reportPath: started.reportPath, ladder: ["2.6.10", "2.7.8"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: started.reportPath, phase: "research_complete" });
  const current = JSON.parse(fs.readFileSync(path.join(root, started.reportPath), "utf8")); current.phase = "committed"; writeRun(root, started.reportPath, current);
  const bridged = recordFrameworkBridge({ root, reportPath: started.reportPath, rubyFrom: "2.6.10", rubyTo: "2.7.8", railsFrom: "4.2.11.3", railsTo: "5.2.8.1", rationale: "Ruby 2.7 removed BigDecimal.new used by Rails 4.2.", citations: [{ title: "Rails upgrade guide", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] });
  assert.equal(bridged.frameworkBridge.railsTo, "5.2.8.1");
});

test("runs Rails bridges in a separate contiguous lifecycle with app:update evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rails-bridge-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\ngem "rails", "~> 6.1"\n');
  fs.writeFileSync(path.join(root, "Gemfile.lock"), "GEM\n  specs:\n    rails (6.1.7.10)\n"); fs.mkdirSync(path.join(root, "test"));
  const ruby = beginRun({ root, target: "3.1", allowNonGit: true });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "inventory_complete" }); recordResearch({ root, reportPath: ruby.reportPath, ladder: ["3.0", "3.1"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] }); transitionRun({ root, reportPath: ruby.reportPath, phase: "research_complete" });
  recordFrameworkBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.0", rubyTo: "3.1", railsFrom: "6.1", railsTo: "7.0", rationale: "Rails upgrade required.", citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }); transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  const bridge = beginRailsBridgeRun({ root, rubyReportPath: ruby.reportPath, allowNonGit: true });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "inventory_complete" });
  assert.throws(() => recordRailsResearch({ root, reportPath: bridge.reportPath, ladder: ["6.1", "7.1"], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }), /contiguous/);
  recordRailsResearch({ root, reportPath: bridge.reportPath, ladder: ["6.1", "7.0"], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }); transitionRun({ root, reportPath: bridge.reportPath, phase: "research_complete" });
  const iteration = { from: "6.1", to: "7.0", files: ["Gemfile"], fixes: [{ files: ["Gemfile"], explanation: "Upgrade Rails." }], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }], tests: { passed: true, command: "bundle exec rake test", smoke: "Boot passed." }, validationReceipts: [testReceipt(), appUpdateReceipt()], appUpdateReview: { command: "bin/rails app:update", executedAt: "2026-01-01T00:00:00Z", reviewedAt: "2026-01-01T00:01:00Z", outcome: "changes_deferred", files: [], summary: "Reviewed generated config changes; deferred defaults." } };
  assert.throws(() => recordRailsIteration({ root, reportPath: bridge.reportPath, iteration }), /record-executed-rails-iteration/);
});

test("records dependency findings only on a validated uncommitted hop", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-dependency-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'ruby "3.0.0"\n'); fs.mkdirSync(path.join(root, "test"));
  const started = beginRun({ root, target: "3.1.0", allowNonGit: true });
  assert.throws(() => recordDependencyReview({ root, reportPath: started.reportPath, compatibility: "Compatible.", licenses: "No changes." }), /validated/);
  const run = JSON.parse(fs.readFileSync(path.join(root, started.reportPath), "utf8"));
  const fingerprint = { algorithm: "sha256", headSha: "a".repeat(40), diffSha256: "b".repeat(64) };
  run.phase = "hop_validated";
  run.iterations = [{ from: "3.0.0", to: "3.1.0", status: "complete", files: ["Gemfile.lock"], fixes: [{ files: ["Gemfile.lock"], explanation: "Resolve dependencies." }], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }], tests: { passed: true, command: "bundle exec rake test", smoke: "Boot passed." }, validationReceipts: [{ receiptVersion: 1, id: "11111111-1111-4111-8111-111111111111", kind: "test", commandId: "bundle-rake-test", argv: ["bundle", "exec", "rake", "test"], startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "c".repeat(64), bytes: 10 }, worktree: fingerprint, testEvidence: { passed: true } }] }];
  writeRun(root, started.reportPath, run);
  const reviewed = recordDependencyReview({ root, reportPath: started.reportPath, compatibility: "Resolved set supports the target runtime.", licenses: "No newly identified incompatible licenses." });
  assert.deepEqual(reviewed.iterations[0].dependencyReview, { completed: true, compatibility: "Resolved set supports the target runtime.", licenses: "No newly identified incompatible licenses.", reviewedAt: reviewed.iterations[0].dependencyReview.reviewedAt });
});

test("discards a validated uncommitted Rails iteration so the hop can be re-validated", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rails-discard-iteration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\ngem "rails", "~> 7.0"\n');
  fs.writeFileSync(path.join(root, "Gemfile.lock"), "GEM\n  specs:\n    rails (7.0.10)\n"); fs.mkdirSync(path.join(root, "test"));
  const ruby = beginRun({ root, target: "3.1", allowNonGit: true });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "inventory_complete" });
  recordResearch({ root, reportPath: ruby.reportPath, ladder: ["3.0", "3.1"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "research_complete" });
  recordFrameworkBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.0", rubyTo: "3.1", railsFrom: "7.0", railsTo: "7.1", rationale: "Rails upgrade required.", citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  const bridge = beginRailsBridgeRun({ root, rubyReportPath: ruby.reportPath, allowNonGit: true });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "inventory_complete" });
  recordRailsResearch({ root, reportPath: bridge.reportPath, ladder: ["7.0", "7.1"], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "research_complete" });
  const fingerprint = { algorithm: "sha256", headSha: "a".repeat(40), diffSha256: "b".repeat(64) };
  const update = { receiptVersion: 1, id: "22222222-2222-4222-8222-222222222222", kind: "rails_app_update", commandId: "rails-app-update", argv: ["bin/rails", "app:update"], startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "c".repeat(64), bytes: 10 }, worktree: fingerprint };
  const test = { receiptVersion: 1, id: "33333333-3333-4333-8333-333333333333", kind: "test", commandId: "bundle-rake-test", argv: ["bundle", "exec", "rake", "test"], startedAt: "2026-01-01T00:00:02Z", finishedAt: "2026-01-01T00:00:03Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "c".repeat(64), bytes: 10 }, worktree: fingerprint, testEvidence: { passed: true } };
  const iteration = { from: "7.0", to: "7.1", status: "complete", files: ["Gemfile", "config/initializers/new_framework_defaults_7_1.rb"], fixes: [{ files: ["Gemfile"], explanation: "Upgrade Rails." }], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }], tests: { passed: true, command: "bundle exec rake test", smoke: "Boot passed." }, validationReceipts: [update, test], appUpdateReview: { command: "bin/rails app:update", receiptId: update.id, executedAt: update.startedAt, reviewedAt: "2026-01-01T00:00:01Z", worktree: fingerprint, outcome: "changes_applied", files: ["config/initializers/new_framework_defaults_7_1.rb"], summary: "Reviewed generated config changes." } };
  const run = JSON.parse(fs.readFileSync(path.join(root, bridge.reportPath), "utf8"));
  run.phase = "hop_validated"; run.iterations = [iteration]; writeRun(root, bridge.reportPath, run);
  assert.throws(() => discardLastRailsIteration({ root, reportPath: bridge.reportPath }), /review reason/);
  const discarded = discardLastRailsIteration({ root, reportPath: bridge.reportPath, reason: "Working tree changed after final validation; re-run the hop against the clean tree." });
  assert.equal(discarded.iterations.length, 0);
  assert.equal(discarded.phase, "research_complete");
  assert.equal(discarded.discardedIterations.length, 1);
  assert.equal(discarded.discardedIterations[0].iteration.from, "7.0");
  assert.throws(() => discardLastRailsIteration({ root, reportPath: bridge.reportPath, reason: "Already discarded." }), /validated/);
});
