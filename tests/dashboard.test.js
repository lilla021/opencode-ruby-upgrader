import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUpgradeRuns, startDashboard } from "../src/dashboard.js";

test("reads and orders durable upgrade run artifacts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-dashboard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, ".ruby-upgrades", "runs"); fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, "old.json"), JSON.stringify({ startedAt: "2026-01-01", targetRuby: "3.3" }));
  fs.writeFileSync(path.join(runs, "new.json"), JSON.stringify({ startedAt: "2026-02-01", targetRuby: "3.4" }));
  assert.deepEqual(readUpgradeRuns(root).map((run) => run.targetRuby), ["3.4", "3.3"]);
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
