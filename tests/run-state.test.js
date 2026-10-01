import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRunLock, readRun, releaseRunLock, RunStateError, validateRun, writeRun } from "../src/run-state.js";

const dockerEnvironment = () => ({ type: "docker", runId: "11111111-1111-4111-8111-111111111111", reportPath: ".ruby-upgrades/runs/run.json", name: "ruby-upgrader-11111111-1111-4111-8111-111111111111-app", id: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, imageRef: "ruby:3.4.1", ruby: "3.4.1", database: "mysql", databaseContainer: "ruby-upgrader-11111111-1111-4111-8111-111111111111-mysql", databaseContainerId: "c".repeat(64), databaseImageId: `sha256:${"d".repeat(64)}`, databaseImageRef: "mysql:8.4", network: "ruby-upgrader-11111111-1111-4111-8111-111111111111-network", networkId: "e".repeat(64) });
const dockerReceipt = (environment) => ({ receiptVersion: 2, id: "22222222-2222-4222-8222-222222222222", kind: "test", commandId: "docker-bundle-rspec", argv: ["docker", "exec"], ...(environment ? { environment } : {}), startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z", durationMs: 1000, exitCode: 0, timedOut: false, output: { redactedSha256: "f".repeat(64), bytes: 10 }, worktree: { algorithm: "sha256", headSha: "1".repeat(40), diffSha256: "2".repeat(64) }, testEvidence: { passed: true } });
const reportWith = (receipt) => ({ schemaVersion: 2, validationReceiptsRequired: true, runId: "11111111-1111-4111-8111-111111111111", title: "Test", status: "in_progress", phase: "hop_validated", startedAt: "2026-09-09T00:00:00Z", targetRuby: "3.4", targetPinnedAt: "2026-09-09T00:00:00Z", research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [{ from: "3.3", to: "3.4", status: "complete", files: ["Gemfile.lock"], fixes: [{ files: ["Gemfile.lock"], explanation: "Update." }], citations: [{ title: "Ruby", url: "https://www.ruby-lang.org/" }], tests: { passed: true, command: "bundle exec rspec", smoke: "Boot passed." }, validationReceipts: [receipt] }] });

test("validates Docker receipt environment evidence", () => {
  assert.equal(validateRun(reportWith(dockerReceipt(dockerEnvironment()))).valid, true);
  // Stripping the environment would otherwise let unattributed Docker evidence validate.
  const missing = validateRun(reportWith(dockerReceipt(undefined)));
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join(" "), /valid executed validation receipts/);
  // Engine and image evidence must be present and well-formed, not partially trusted.
  for (const patch of [{ database: "sqlite" }, { databaseContainerId: "short" }, { networkId: undefined }, { reportPath: "elsewhere/run.json" }]) {
    assert.equal(validateRun(reportWith(dockerReceipt({ ...dockerEnvironment(), ...patch }))).valid, false);
  }
  // Legacy non-Docker receipts stay valid without an environment.
  const legacy = { ...dockerReceipt(undefined), receiptVersion: 1, commandId: "bundle-rspec" };
  assert.equal(validateRun(reportWith(legacy)).valid, true);
});

test("writes redacted valid reports atomically and serializes active runs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-run-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = ".ruby-upgrades/runs/run.json";
  writeRun(root, reportPath, { schemaVersion: 2, runId: "11111111-1111-4111-8111-111111111111", title: "Test", status: "in_progress", phase: "initialized", startedAt: "2026-09-09T00:00:00Z", targetRuby: "3.4", targetPinnedAt: "2026-09-09T00:00:00Z", token: "ghp_abcdefghijklmnopqrstuvwxyz123456", research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] });
  assert.equal(readRun(root, reportPath).token, "[REDACTED]");
  assert.equal(fs.existsSync(path.join(root, ".ruby-upgrades", "runs", "run.md")), true);
  acquireRunLock(root, reportPath);
  assert.throws(() => acquireRunLock(root, reportPath), (error) => error instanceof RunStateError && error.code === "run-locked");
  releaseRunLock(root, reportPath);
  assert.doesNotThrow(() => acquireRunLock(root, reportPath));
});

test("redacts credentials embedded in source URLs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-run-source-redaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = ".ruby-upgrades/runs/run.json";
  writeRun(root, reportPath, { schemaVersion: 2, runId: "11111111-1111-4111-8111-111111111111", title: "Test", status: "in_progress", phase: "initialized", startedAt: "2026-09-09T00:00:00Z", targetRuby: "3.4", targetPinnedAt: "2026-09-09T00:00:00Z", supplyChain: { sources: ["https://token:password@example.test/gems?api_key=secret"], privateSources: [] }, research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] });
  assert.equal(readRun(root, reportPath).supplyChain.sources[0], "https://[REDACTED]@example.test/gems?api_key=[REDACTED]");
  assert.doesNotMatch(fs.readFileSync(path.join(root, reportPath), "utf8"), /token:password|api_key=secret/);
});

test("rejects malformed reports and symlinked evidence directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-run-state-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-run-state-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, ".ruby-upgrades"));
  const report = { schemaVersion: 2, runId: "11111111-1111-4111-8111-111111111111", title: "Test", status: "in_progress", phase: "initialized", startedAt: "2026-09-09T00:00:00Z", targetRuby: "3.4", targetPinnedAt: "2026-09-09T00:00:00Z", research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] };
  assert.throws(() => writeRun(root, ".ruby-upgrades/runs/run.json", report), (error) => error instanceof RunStateError && error.code === "unsafe-report-path");
  assert.equal(fs.readdirSync(outside).length, 0);
});
