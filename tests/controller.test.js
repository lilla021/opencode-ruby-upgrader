import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginBundlerBridgeRun, beginRailsBridgeRun, beginRun, discardLastRailsIteration, recordBundlerBridge, recordBundlerResearch, recordDependencyReview, recordExecutedIteration, recordExecutedBundlerIteration, recordFrameworkBridge, recordIteration, recordRiskDecision, recordRailsIteration, recordRailsResearch, recordResearch, resumeRun, transitionRun } from "../src/controller.js";
import { inventoryProject } from "../src/inventory.js";
import { inspectSupplyChain } from "../src/supply-chain.js";
import { parseTestEvidence } from "../src/test-evidence.js";
import { readRun, validateRun, writeRun } from "../src/run-state.js";
import { createLinkedWorktree } from "./helpers/git-worktree.js";

const testReceipt = () => ({ receiptVersion: 1, id: "11111111-1111-4111-8111-111111111111", kind: "test", commandId: "bundle-rake-test", argv: ["bundle", "exec", "rake", "test"], startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "a".repeat(64), summary: "1 runs, 0 failures" }, testEvidence: { passed: true } });
const appUpdateReceipt = () => ({ receiptVersion: 1, id: "22222222-2222-4222-8222-222222222222", kind: "rails_app_update", commandId: "rails-app-update", argv: ["bin/rails", "app:update"], startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "b".repeat(64), summary: "No changes" } });
const iteration = (from, to) => ({ from, to, files: ["Gemfile"], fixes: [{ files: ["Gemfile"], explanation: "Update runtime." }], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }], tests: { passed: true, command: "bundle exec rake test", smoke: "Boot passed." }, validationReceipts: [testReceipt()] });

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

test("durable runs reject non-Git projects even if the removed override is supplied", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-controller-no-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\n');
  fs.mkdirSync(path.join(root, "test"));
  assert.throws(() => beginRun({ root, target: "3.4" }), /requires a supported linked Git worktree/);
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
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-lifecycle-", files: { Gemfile: 'source "https://rubygems.org"\n' }, directories: ["test"] });
  const run = beginRun({ root, target: "3.4" });
  assert.equal(run.report.phase, "initialized");
  assert.throws(() => transitionRun({ root, reportPath: run.reportPath, phase: "hop_validated" }), /Cannot transition/);
  assert.equal(transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" }).phase, "inventory_complete");
});

test("validation preflights report phase before resolving an executor command", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-validation-preflight-", files: { Gemfile: 'source "https://rubygems.org"\n' }, directories: ["test"] });
  const run = beginRun({ root, target: "3.4" });
  assert.throws(() => recordExecutedIteration({ root, reportPath: run.reportPath, validationCommandId: "not-an-executor" }), /after research or a prior checkpoint/);
});

test("new reports reject asserted iterations before they can skip executed validation", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-ladder-", files: { Gemfile: 'source "https://rubygems.org"\n' }, directories: ["test"] });
  const run = beginRun({ root, target: "3.4" });
  transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" });
  assert.throws(() => recordResearch({ root, reportPath: run.reportPath, ladder: ["3.2", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] }), /exactly one Ruby minor/);
  recordResearch({ root, reportPath: run.reportPath, ladder: ["3.2", "3.3", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: run.reportPath, phase: "research_complete" });
  assert.throws(() => recordIteration({ root, reportPath: run.reportPath, iteration: iteration("3.2", "3.4") }), /record-executed-iteration/);
  assert.throws(() => recordIteration({ root, reportPath: run.reportPath, iteration: iteration("3.2", "3.3") }), /record-executed-iteration/);
});

test("Ruby research accepts a major-series boundary but still rejects a skipped minor", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-major-boundary-", files: { Gemfile: 'ruby "2.4.10"\n' }, directories: ["test"] });
  const run = beginRun({ root, target: "3.1" });
  transitionRun({ root, reportPath: run.reportPath, phase: "inventory_complete" });
  const citations = [{ title: "Ruby", url: "https://www.ruby-lang.org/" }];
  assert.throws(() => recordResearch({ root, reportPath: run.reportPath, ladder: ["2.4", "2.5", "2.6", "3.0", "3.1"], citations }), /exactly one Ruby minor/);
  recordResearch({ root, reportPath: run.reportPath, ladder: ["2.4", "2.5", "2.6", "2.7", "3.0", "3.1"], citations });
});

test("records an approved Rails bridge for the next blocked Ruby hop", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-rails-bridge-", files: { Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 6.1"\n', "Gemfile.lock": "GEM\n  specs:\n    rails (6.1.7.10)\n" }, directories: ["test"] });
  const run = beginRun({ root, target: "3.1" });
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
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-committed-bridge-", files: { Gemfile: 'ruby "2.6.10"\ngem "rails", "4.2.11.3"\n', "Gemfile.lock": "GEM\n  specs:\n    rails (4.2.11.3)\n" }, directories: ["spec"] });
  const started = beginRun({ root, target: "2.7.8" });
  transitionRun({ root, reportPath: started.reportPath, phase: "inventory_complete" });
  recordResearch({ root, reportPath: started.reportPath, ladder: ["2.6.10", "2.7.8"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: started.reportPath, phase: "research_complete" });
  const current = JSON.parse(fs.readFileSync(path.join(root, started.reportPath), "utf8")); current.phase = "committed"; writeRun(root, started.reportPath, current);
  const bridged = recordFrameworkBridge({ root, reportPath: started.reportPath, rubyFrom: "2.6.10", rubyTo: "2.7.8", railsFrom: "4.2.11.3", railsTo: "5.2.8.1", rationale: "Ruby 2.7 removed BigDecimal.new used by Rails 4.2.", citations: [{ title: "Rails upgrade guide", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] });
  assert.equal(bridged.frameworkBridge.railsTo, "5.2.8.1");
});

test("runs Rails bridges in a separate contiguous lifecycle with app:update evidence", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "rails-bridge-lifecycle-", files: { Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 6.1"\n', "Gemfile.lock": "GEM\n  specs:\n    rails (6.1.7.10)\n" }, directories: ["test"] });
  const ruby = beginRun({ root, target: "3.1" });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "inventory_complete" }); recordResearch({ root, reportPath: ruby.reportPath, ladder: ["3.0", "3.1"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] }); transitionRun({ root, reportPath: ruby.reportPath, phase: "research_complete" });
  recordFrameworkBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.0", rubyTo: "3.1", railsFrom: "6.1", railsTo: "7.0", rationale: "Rails upgrade required.", citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }); transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "rails-bridge-no-git-"));
  t.after(() => fs.rmSync(nonGit, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, "Gemfile"), path.join(nonGit, "Gemfile"));
  fs.copyFileSync(path.join(root, "Gemfile.lock"), path.join(nonGit, "Gemfile.lock"));
  writeRun(nonGit, ruby.reportPath, JSON.parse(fs.readFileSync(path.join(root, ruby.reportPath), "utf8")));
  assert.throws(() => beginRailsBridgeRun({ root: nonGit, rubyReportPath: ruby.reportPath }), /requires a supported linked Git worktree/);
  const bridge = beginRailsBridgeRun({ root, rubyReportPath: ruby.reportPath });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "inventory_complete" });
  assert.throws(() => recordRailsResearch({ root, reportPath: bridge.reportPath, ladder: ["6.1", "7.1"], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }), /contiguous/);
  recordRailsResearch({ root, reportPath: bridge.reportPath, ladder: ["6.1", "7.0"], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] }); transitionRun({ root, reportPath: bridge.reportPath, phase: "research_complete" });
  const iteration = { from: "6.1", to: "7.0", files: ["Gemfile"], fixes: [{ files: ["Gemfile"], explanation: "Upgrade Rails." }], citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }], tests: { passed: true, command: "bundle exec rake test", smoke: "Boot passed." }, validationReceipts: [testReceipt(), appUpdateReceipt()], appUpdateReview: { command: "bin/rails app:update", executedAt: "2026-01-01T00:00:00Z", reviewedAt: "2026-01-01T00:01:00Z", outcome: "changes_deferred", files: [], summary: "Reviewed generated config changes; deferred defaults." } };
  assert.throws(() => recordRailsIteration({ root, reportPath: bridge.reportPath, iteration }), /record-executed-rails-iteration/);
});

test("records dependency findings only on a validated uncommitted hop", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-dependency-review-", files: { Gemfile: 'ruby "3.0.0"\n' }, directories: ["test"] });
  const started = beginRun({ root, target: "3.1.0" });
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
  const { linked: root } = createLinkedWorktree(t, { prefix: "rails-discard-iteration-", files: { Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.0"\n', "Gemfile.lock": "GEM\n  specs:\n    rails (7.0.10)\n" }, directories: ["test"] });
  const ruby = beginRun({ root, target: "3.1" });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "inventory_complete" });
  recordResearch({ root, reportPath: ruby.reportPath, ladder: ["3.0", "3.1"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "research_complete" });
  recordFrameworkBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.0", rubyTo: "3.1", railsFrom: "7.0", railsTo: "7.1", rationale: "Rails upgrade required.", citations: [{ title: "Rails", url: "https://guides.rubyonrails.org/upgrading_ruby_on_rails.html" }] });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  const bridge = beginRailsBridgeRun({ root, rubyReportPath: ruby.reportPath });
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

test("a latest approved decision supersedes a paused risk at the iteration gate", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-risk-gate-", files: { Gemfile: 'ruby "3.3.0"\n' }, directories: ["test"] });
  const started = beginRun({ root, target: "3.4" });
  transitionRun({ root, reportPath: started.reportPath, phase: "inventory_complete" });
  recordResearch({ root, reportPath: started.reportPath, ladder: ["3.3", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: started.reportPath, phase: "research_complete" });
  const run = JSON.parse(fs.readFileSync(path.join(root, started.reportPath), "utf8"));
  delete run.validationReceiptsRequired;
  writeRun(root, started.reportPath, run);
  const legacyIteration = iteration("3.3", "3.4");
  delete legacyIteration.validationReceipts;

  recordRiskDecision({ root, reportPath: started.reportPath, risk: "runtime-support", decision: "paused", evidence: "Needs review." });
  assert.throws(() => recordIteration({ root, reportPath: started.reportPath, iteration: legacyIteration }), /Resolve every detected risk/);
  recordRiskDecision({ root, reportPath: started.reportPath, risk: "runtime-support", decision: "approved", evidence: "Review completed." });
  assert.equal(recordIteration({ root, reportPath: started.reportPath, iteration: legacyIteration }).iterations.length, 1);
});

test("a latest approved decision supersedes a blocked risk at completion", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "ruby-risk-completion-", files: { Gemfile: 'ruby "3.3.0"\n' }, directories: ["test"] });
  const started = beginRun({ root, target: "3.4" });
  recordRiskDecision({ root, reportPath: started.reportPath, risk: "runtime-support", decision: "blocked", evidence: "Unsupported dependency." });
  const run = JSON.parse(fs.readFileSync(path.join(root, started.reportPath), "utf8"));
  delete run.validationReceiptsRequired;
  run.phase = "committed";
  run.research = { ladder: ["3.3", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] };
  const completedIteration = iteration("3.3", "3.4");
  delete completedIteration.validationReceipts;
  run.iterations = [{ ...completedIteration, status: "complete", checkpointSha: run.expectedHead }];
  writeRun(root, started.reportPath, run);

  assert.throws(() => transitionRun({ root, reportPath: started.reportPath, phase: "complete" }), /Unresolved risks/);
  recordRiskDecision({ root, reportPath: started.reportPath, risk: "runtime-support", decision: "approved", evidence: "Dependency replaced." });
  assert.equal(transitionRun({ root, reportPath: started.reportPath, phase: "complete" }).status, "complete");
});

// The Bundler bridge is the mirror image of the Rails bridge. A Rails hop is
// blocked because the framework lags the Ruby; a Bundler hop is blocked because
// the project's own `BUNDLED WITH` pin lags the Ruby it must now run on.
const bundlerProject = (pin) => ({
  Gemfile: 'source "https://rubygems.org"\n',
  "Gemfile.lock": `GEM\n  specs:\n\nPLATFORMS\n  ruby\n\nBUNDLED WITH\n   ${pin}\n`
});
const bundlerCitation = [{ title: "Bundler compatibility with Ruby", url: "https://guides.rubygems.org/bundler-compatibility/" }];

const blockedRubyRunOnStaleBundler = (root, pin = "2.4.17") => {
  const ruby = beginRun({ root, target: "3.4" });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "inventory_complete" });
  recordResearch({ root, reportPath: ruby.reportPath, ladder: ["3.3", "3.4"], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }] });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "research_complete" });
  return ruby;
};

test("approves a Bundler bridge only when the pin is genuinely below a cited floor", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "bundler-bridge-floor-", files: bundlerProject("2.4.17"), directories: ["test"] });
  const ruby = blockedRubyRunOnStaleBundler(root);
  const approve = (patch) => recordBundlerBridge({
    root, reportPath: ruby.reportPath, rubyFrom: "3.3", rubyTo: "3.4", bundlerFrom: "2.4.17", bundlerTo: "2.5.22", minimumBundler: "2.5",
    rationale: "Bundler 2.4 predates Ruby 3.4 support.", citations: bundlerCitation, ...patch
  });
  // Rejection paths are checked first, while the run still has no bridge.
  // Blocking a hop that the pin already satisfies would be wrong as often as right.
  // The project records 2.4.17, so a claimed 2.7 pin contradicts the lockfile.
  assert.throws(() => approve({ bundlerFrom: "2.7", minimumBundler: "2.5" }), /must begin at the version recorded/);
  // A floor the recorded pin already clears must not be able to block a hop.
  assert.throws(() => approve({ minimumBundler: "2.4" }), /Bundler 2\.4\.17 is not below the researched floor 2\.4/);
  // A target under the floor leaves the project still broken.
  assert.throws(() => approve({ bundlerTo: "2.4.22" }), /at or above the researched minimum/);
  assert.throws(() => approve({ citations: [] }), /rationale and HTTPS citations/);
  assert.throws(() => approve({ rubyTo: "3.5" }), /next researched Ruby hop/);
  // The real-world case: a 2.4 pin cannot run a 3.4 project.
  const approved = approve({});
  assert.equal(approved.bundlerBridge.status, "approved");
  assert.equal(approved.bundlerBridge.minimumBundler, "2.5");
  assert.equal(approved.bundlerBridge.compatibilitySource, "https://guides.rubygems.org/bundler-compatibility/");
  // One approved bridge per run: the prerequisite is done once, in its own scope.
  assert.throws(() => approve({}), /already has an approved compatibility bridge/);
});

test("runs a Bundler bridge as its own scoped report linked to the blocked Ruby run", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "bundler-bridge-lifecycle-", files: bundlerProject("2.4.17"), directories: ["test"] });
  const ruby = blockedRubyRunOnStaleBundler(root);
  recordBundlerBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.3", rubyTo: "3.4", bundlerFrom: "2.4.17", bundlerTo: "2.5.22", minimumBundler: "2.5", rationale: "Bundler 2.4 predates Ruby 3.4.", citations: bundlerCitation });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  const bridge = beginBundlerBridgeRun({ root, rubyReportPath: ruby.reportPath });
  assert.equal(bridge.report.reportType, "bundler_bridge");
  assert.equal(bridge.report.targetBundler, "2.5.22");
  assert.equal(bridge.report.bridge.rubyRunId, ruby.report.runId);
  // The link back is what makes this separately scoped rather than a second phase.
  assert.equal(bridge.report.bridge.minimumBundler, "2.5");

  transitionRun({ root, reportPath: bridge.reportPath, phase: "inventory_complete" });
  // The ladder must walk one series at a time and can cross the 2.7 -> 4.0 boundary.
  // Skipping to the target crosses two intermediate series at once.
  assert.throws(() => recordBundlerResearch({ root, reportPath: bridge.reportPath, ladder: ["2.4.17", "2.5.22", "2.7.2"], citations: bundlerCitation }), /one minor series per hop/);
  assert.throws(() => recordBundlerResearch({ root, reportPath: bridge.reportPath, ladder: ["2.5.22", "2.6.9"], citations: bundlerCitation }), /begin at the version recorded/);
  assert.throws(() => recordBundlerResearch({ root, reportPath: bridge.reportPath, ladder: ["2.4.17", "2.5.22", "2.6.9"], citations: bundlerCitation }), /end at the researched target/);
  assert.throws(() => recordBundlerResearch({ root, reportPath: bridge.reportPath, ladder: ["2.4.17", "2.5.22"], citations: [] }), /HTTPS official-source citation/);
  recordBundlerResearch({ root, reportPath: bridge.reportPath, ladder: ["2.4.17", "2.5.22"], citations: bundlerCitation });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "research_complete" });
  assert.equal(validateRun(readRun(root, bridge.reportPath)).valid, true);
});

test("a Bundler bridge crosses the 2.7 to 4.0 series boundary", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "bundler-bridge-boundary-", files: bundlerProject("2.4.17"), directories: ["test"] });
  const ruby = blockedRubyRunOnStaleBundler(root);
  recordBundlerBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.3", rubyTo: "3.4", bundlerFrom: "2.4.17", bundlerTo: "4.0.11", minimumBundler: "2.5", rationale: "Move to the current Bundler series.", citations: bundlerCitation });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  const bridge = beginBundlerBridgeRun({ root, rubyReportPath: ruby.reportPath });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "inventory_complete" });
  // 4.0 skips major 3 entirely, so a +1-only rule could never reach it.
  recordBundlerResearch({ root, reportPath: bridge.reportPath, ladder: ["2.4.17", "2.5.22", "2.6.9", "2.7.2", "4.0.11"], citations: bundlerCitation });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "research_complete" });
  assert.equal(bridge.report.targetBundler, "4.0.11");
});

test("records a Bundler hop only when the lockfile pin and the executed runtime agree", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "bundler-hop-evidence-", files: bundlerProject("2.4.17"), directories: ["test"] });
  const ruby = blockedRubyRunOnStaleBundler(root);
  recordBundlerBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.3", rubyTo: "3.4", bundlerFrom: "2.4.17", bundlerTo: "2.5.22", minimumBundler: "2.5", rationale: "Bundler 2.4 predates Ruby 3.4.", citations: bundlerCitation });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  const bridge = beginBundlerBridgeRun({ root, rubyReportPath: ruby.reportPath });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "inventory_complete" });
  recordBundlerResearch({ root, reportPath: bridge.reportPath, ladder: ["2.4.17", "2.5.22"], citations: bundlerCitation });
  transitionRun({ root, reportPath: bridge.reportPath, phase: "research_complete" });

  const hop = { from: "2.4.17", to: "2.5.22", files: ["Gemfile.lock"], fixes: [{ files: ["Gemfile.lock"], explanation: "Raise BUNDLED WITH." }], citations: bundlerCitation, tests: { passed: true, command: "bundle exec rake test", smoke: "Boot passed." } };
  // The adapter check runs before the executor, so a bare minitest project never
  // reaches the runtime path on a command it cannot support.
  assert.throws(() => recordExecutedBundlerIteration({ root, reportPath: bridge.reportPath, iteration: hop, validationCommandId: "docker-bundle-rspec" }), /not supported by this project's detected adapter/);
  // A failing validation run is never recorded as a passing hop.
  assert.throws(() => recordExecutedBundlerIteration({ root, reportPath: bridge.reportPath, iteration: hop, validationCommandId: "bundle-rake-test" }), /not recorded as a passing hop/);

  // The pin and the executed Bundler are recorded together, so a later reader can
  // see the lockfile agreed with the version that ran the tests.
  const recorded = JSON.parse(fs.readFileSync(path.join(root, bridge.reportPath), "utf8"));
  // A Docker receipt carries the attested Bundler, which is what proves the
  // tests actually ran on the new version.
  const environment = { type: "docker", runId: bridge.report.runId, reportPath: bridge.reportPath, name: "ruby-upgrader-app", id: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, imageRef: "ruby:3.4.1", ruby: "3.4.1", bundlerVersion: "2.5.22", database: "postgres", databaseContainer: "ruby-upgrader-pg", databaseContainerId: "c".repeat(64), databaseImageId: `sha256:${"d".repeat(64)}`, databaseImageRef: "postgres:16-alpine", network: "ruby-upgrader-net", networkId: "e".repeat(64) };
  const dockerReceipt = { receiptVersion: 2, id: "44444444-4444-4444-8444-444444444444", kind: "test", commandId: "docker-bundle-rspec", argv: ["docker", "exec"], environment, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "e".repeat(64), bytes: 10 }, worktree: { algorithm: "sha256", headSha: "a".repeat(40), diffSha256: "b".repeat(64) }, testEvidence: { passed: true } };
  recorded.iterations = [{ ...hop, status: "complete", lockfilePin: "2.5.22", validationReceipts: [dockerReceipt] }];
  writeRun(root, bridge.reportPath, recorded);
  const validated = readRun(root, bridge.reportPath);
  assert.equal(validated.iterations[0].lockfilePin, "2.5.22");
  // A hop whose recorded pin disagrees with its target is not valid evidence.
  const tampered = JSON.parse(fs.readFileSync(path.join(root, bridge.reportPath), "utf8"));
  tampered.iterations[0].lockfilePin = "2.4.17";
  assert.equal(validateRun(tampered).valid, false);
});

test("a Ruby run blocked by a Bundler bridge is terminal", (t) => {
  const { linked: root } = createLinkedWorktree(t, { prefix: "bundler-bridge-terminal-", files: bundlerProject("2.4.17"), directories: ["test"] });
  const ruby = blockedRubyRunOnStaleBundler(root);
  recordBundlerBridge({ root, reportPath: ruby.reportPath, rubyFrom: "3.3", rubyTo: "3.4", bundlerFrom: "2.4.17", bundlerTo: "2.5.22", minimumBundler: "2.5", rationale: "Bundler 2.4 predates Ruby 3.4.", citations: bundlerCitation });
  transitionRun({ root, reportPath: ruby.reportPath, phase: "blocked" });
  // Resuming would skip the prerequisite change and leave the project on a
  // Bundler that cannot run the target Ruby.
  assert.throws(() => resumeRun({ root, reportPath: ruby.reportPath }), /blocked by an approved compatibility bridge/);
  // Blocking releases the lock, so a later transition cannot even be attempted
  // without resuming -- which is itself the guarantee.
  assert.throws(() => transitionRun({ root, reportPath: ruby.reportPath, phase: "research_complete" }), /No active run lock/);
  const blocked = readRun(root, ruby.reportPath);
  assert.match(blocked.summary.at(-1), /separately scoped Bundler 2\.4\.17 → 2\.5\.22 bridge/);
});
