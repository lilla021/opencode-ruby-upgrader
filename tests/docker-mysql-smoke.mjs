import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeRun } from "../src/run-state.js";
import { prepareTargetRuntime } from "../src/target-runtime.js";
import { executeValidation } from "../src/validation-executor.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-upgrader-mysql-smoke-")));
const runId = crypto.randomUUID();
const prefix = `ruby-upgrader-${runId}`;
const reportPath = ".ruby-upgrades/runs/mysql-smoke.json";
// Held across the try/catch so the original failure survives the cleanup below
// and can be rethrown after teardown, instead of being masked by it.
let failure;

function command(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, shell: false, encoding: "utf8", maxBuffer: 256 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result;
}

try {
  command("docker", ["version"]);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "spec"), { recursive: true });
  fs.writeFileSync(path.join(root, "Gemfile"), 'source "https://rubygems.org"\ngem "rails", "~> 7.1.0"\ngem "mysql2"\ngem "rspec"\n');
  fs.writeFileSync(path.join(root, "config", "database.yml"), "test:\n  adapter: mysql2\n  database: ruby_upgrade_test\n");
  fs.writeFileSync(path.join(root, "spec", "mysql_spec.rb"), 'require "uri"\nrequire "mysql2"\n\nRSpec.describe "isolated MySQL" do\n  it "connects through DATABASE_URL" do\n    uri = URI(ENV.fetch("DATABASE_URL"))\n    client = Mysql2::Client.new(host: uri.host, port: uri.port, username: uri.user, password: uri.password, database: uri.path.delete_prefix("/"))\n    expect(client.query("SELECT DATABASE() AS name").first["name"]).to eq("ruby_upgrade_test")\n  end\nend\n');
  command("git", ["init", "-q", "."]);
  command("git", ["add", "Gemfile", "config/database.yml", "spec/mysql_spec.rb"]);
  command("git", ["-c", "user.name=smoke-test", "-c", "user.email=smoke-test@example.invalid", "commit", "-q", "-m", "MySQL smoke fixture"]);
  writeRun(root, reportPath, { schemaVersion: 2, validationReceiptsRequired: true, runId, title: "MySQL Docker smoke", status: "in_progress", phase: "initialized", startedAt: new Date().toISOString(), targetRuby: "3.4", targetPinnedAt: new Date().toISOString(), research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] });

  const runtime = prepareTargetRuntime({ root, reportPath, ruby: "3.4.1" });
  assert.equal(runtime.database, "mysql");
  const receipt = executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec", expectedRuntime: { runId, reportPath }, timeoutMs: 600_000 });
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.testEvidence?.passed, true);
  assert.equal(receipt.environment.database, "mysql");
  assert.equal(receipt.environment.databaseImageRef, "mysql:8.4");
  // The persisted manifest is the artifact a real user commits alongside their
  // code, so assert on that file rather than the in-memory object: it must
  // carry no connection string and no local filesystem path. Identity is bound
  // to the run ID plus a hash of the worktree, never the path itself.
  const manifest = fs.readFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), "utf8");
  assert.equal(manifest.includes("mysql2://"), false);
  assert.equal(manifest.includes(root), false);
  assert.equal(manifest.includes(os.tmpdir()), false);
  assert.equal(/^sha256:[a-f0-9]{64}$/i.test(JSON.parse(manifest).databaseImageId), true);
  console.log("MySQL Docker smoke passed: real mysql:8.4, mysql2 connection, docker-bundle-rspec receipt, and secret-free manifest verified.");
} catch (error) {
  failure = error;
} finally {
  // Best-effort safety net so a failing run does not strand containers or a
  // worktree, whether it fails mid-preparation or mid-RSpec.
  for (const name of [`${prefix}-app`, `${prefix}-mysql`, `${prefix}-postgres`]) spawnSync("docker", ["rm", "--force", name], { shell: false, stdio: "ignore" });
  spawnSync("docker", ["network", "rm", `${prefix}-network`], { shell: false, stdio: "ignore" });
  fs.rmSync(root, { recursive: true, force: true });
}

if (failure) throw failure;

// Teardown is a documented guarantee, so it is asserted rather than assumed.
// Scoped to this run's own prefix -- a global check would false-fail on a
// shared runner holding unrelated resources. Checked only after a successful
// run, because on the failure path the `finally` above is a safety net, not
// evidence of a teardown bug.
for (const label of ["container", "network"]) {
  const args = label === "container" ? ["ps", "-aq", "--filter", `name=${prefix}`] : ["network", "ls", "-q", "--filter", `name=${prefix}`];
  const result = spawnSync("docker", args, { shell: false, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed while checking teardown: ${result.stderr}`);
  assert.equal(result.stdout.trim(), "", `Smoke run leaked ${label} resources named ${prefix}-*.`);
}
assert.equal(fs.existsSync(root), false, "Smoke run leaked its temporary worktree.");
console.log("Teardown verified: no leftover containers, network, or worktree.");
