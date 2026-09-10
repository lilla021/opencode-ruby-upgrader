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
  writeRun(root, reportPath, { status: "in_progress", startedAt: "2026-09-09T00:00:00Z", token: "ghp_abcdefghijklmnopqrstuvwxyz123456", iterations: [] });
  assert.equal(readRun(root, reportPath).token, "[REDACTED]");
  acquireRunLock(root, reportPath);
  assert.throws(() => acquireRunLock(root, reportPath), (error) => error instanceof RunStateError && error.code === "run-locked");
  releaseRunLock(root, reportPath);
  assert.doesNotThrow(() => acquireRunLock(root, reportPath));
});
