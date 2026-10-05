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

// Advisories are recomputed per request from the live worktree, so the dashboard
// reflects the repo as it is now rather than a value frozen into a past run.
test("dashboard exposes advisory findings without storing them in the report", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-dashboard-advisory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".ruby-upgrades", "runs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ruby-version"), "3.3.4\n");
  fs.writeFileSync(path.join(root, ".ruby-upgrades", "runs", "run.json"), JSON.stringify({
    schemaVersion: 2, reportType: "ruby", runId: "11111111-1111-4111-8111-111111111111", title: "Ruby 3.3 to 3.4",
    status: "in_progress", phase: "hop_validated", startedAt: "2026-09-09T00:00:00Z", targetRuby: "3.4.1", targetPinnedAt: "2026-09-09T00:00:00Z", validationReceiptsRequired: true, research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [], summary: []
  }));
  const server = await startDashboard({ root });
  t.after(() => server.close());
  const { port } = server.address();

  const [run] = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
  assert.equal(run.advisories.some((item) => item.title.includes(".ruby-version pins Ruby 3.3.4")), true);
  // The finding is a live view, not durable evidence: it must not leak into the
  // stored report, or a re-read would present an inference as recorded proof.
  assert.equal("advisories" in JSON.parse(fs.readFileSync(path.join(root, ".ruby-upgrades", "runs", "run.json"), "utf8")), false);

  // Updating the file must change the answer on the next request, with no rewrite.
  fs.writeFileSync(path.join(root, ".ruby-version"), "3.4.1\n");
  const [updated] = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json();
  assert.equal(updated.advisories.some((item) => item.area === "version-pin"), false);
});
