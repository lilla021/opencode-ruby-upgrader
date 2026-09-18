import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRunLock, readRun, releaseRunLock, RunStateError, writeRun } from "../src/run-state.js";

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
