import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUpgradeRuns, startDashboard } from "../src/dashboard.js";
import { writeRun } from "../src/run-state.js";

test("reads and orders durable upgrade run artifacts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-dashboard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = (startedAt, targetRuby) => ({ schemaVersion: 2, runId: crypto.randomUUID(), lockNonce: crypto.randomUUID(), title: "Test", status: "in_progress", phase: "initialized", startedAt, targetRuby, targetPinnedAt: startedAt, research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] });
  writeRun(root, ".ruby-upgrades/runs/old.json", report("2026-01-01T00:00:00Z", "3.3"));
  writeRun(root, ".ruby-upgrades/runs/new.json", report("2026-02-01T00:00:00Z", "3.4"));
  assert.deepEqual(readUpgradeRuns(root).map((run) => run.targetRuby), ["3.4", "3.3"]);
  assert.equal("lockNonce" in readUpgradeRuns(root)[0], false);
});

test("serves run data only from a local dashboard", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-dashboard-server-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startDashboard({ root });
  t.after(() => server.close());
  const { port, address } = server.address();
  assert.equal(address, "127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
  assert.deepEqual(await response.json(), []);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/missing`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs`, { method: "POST" })).status, 405);
});
