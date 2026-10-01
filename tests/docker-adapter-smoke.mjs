// Real-container proof for one adapter. Run as:
//
//   node tests/docker-adapter-smoke.mjs            # both engines
//   node tests/docker-adapter-smoke.mjs mysql      # one engine
//
// Unit tests mock the docker spawn, so they cannot catch a wrong readiness
// probe, a malformed connection URL, or a driver gem that never loads. Each
// engine therefore provisions a real database container, connects from a
// throwaway Rails app through that engine's own driver, and asserts the receipt.
//
// Detection is deliberately left to run here rather than passing an explicit
// `--database`: a Postgres leg that only worked because it was told the answer
// would not prove the flag-free path that most users take. The fixture is
// written the way a real project declares its engine, and the detected value is
// asserted, so a regression in detection fails this smoke rather than passing
// quietly.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeRun } from "../src/run-state.js";
import { prepareTargetRuntime } from "../src/target-runtime.js";
import { executeValidation } from "../src/validation-executor.js";

// A `gem` line plus an `adapter:` line, written the way a real project declares
// its engine. The Gemfile alone would be ambiguous once both adapters are
// listed below, so each fixture names exactly one.
const ENGINES = Object.freeze({
  mysql: Object.freeze({
    gem: "mysql2",
    adapter: "mysql2",
    urlScheme: "mysql2://",
    image: "mysql:8.4",
    database: "MySQL",
    // `SELECT DATABASE()` is MySQL-specific and fails on PostgreSQL, so the spec
    // genuinely exercises this engine's dialect rather than only its transport.
    spec: (driver) => `require "uri"\nrequire "${driver}"\n\nRSpec.describe "isolated ${driver}" do\n  it "connects through DATABASE_URL" do\n    uri = URI(ENV.fetch("DATABASE_URL"))\n    client = Mysql2::Client.new(host: uri.host, port: uri.port, username: uri.user, password: uri.password, database: uri.path.delete_prefix("/"))\n    expect(client.query("SELECT DATABASE() AS name").first["name"]).to eq("ruby_upgrade_test")\n  end\nend\n`,
  }),
  postgres: Object.freeze({
    gem: "pg",
    adapter: "postgresql",
    urlScheme: "postgresql://",
    image: "postgres:16-alpine",
    database: "PostgreSQL",
    spec: (driver) => `require "uri"\nrequire "${driver}"\n\nRSpec.describe "isolated ${driver}" do\n  it "connects through DATABASE_URL" do\n    uri = URI(ENV.fetch("DATABASE_URL"))\n    client = PG.connect(host: uri.host, port: uri.port, user: uri.user, password: uri.password, dbname: uri.path.delete_prefix("/"))\n    expect(client.exec("SELECT current_database() AS name").first["name"]).to eq("ruby_upgrade_test")\n  end\nend\n`,
  }),
});

function runSmoke(engine) {
  const spec = ENGINES[engine];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ruby-upgrader-${engine}-smoke-`)));
  const runId = crypto.randomUUID();
  const prefix = `ruby-upgrader-${runId}`;
  const reportPath = `.ruby-upgrades/runs/${engine}-smoke.json`;
  const specPath = `spec/${engine}_spec.rb`;
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
    // A real Rails skeleton, not just a Gemfile. PostgreSQL's adapter creates the
    // test database through the app's own `rake db:create`, so it needs a
    // bootable application; MySQL's creates it server-side and would accept a
    // bare Gemfile. The MySQL leg passed for a long time with a Gemfile and no
    // app at all, because its adapter could not tell the difference -- so this
    // fixture is deliberately strong enough to fail on the engine that does
    // require one.
    for (const dir of ["app/models", "bin", "config/environments", "db", "lib/tasks", "spec"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, "Gemfile"), `source "https://rubygems.org"\ngem "rails", "~> 7.1.0"\ngem "${spec.gem}"\ngem "rspec"\n`);
    // `host: localhost` is deliberate. `rake db:create` runs inside the app
    // container, where localhost is the app itself rather than the isolated
    // database, so a fixture that pointed anywhere reachable would hide whether
    // DATABASE_URL actually overrides the project's own configuration. Rails
    // prefers DATABASE_URL, and this proves it on a value that would otherwise
    // be wrong.
    fs.writeFileSync(path.join(root, "config", "database.yml"), `test:\n  adapter: ${spec.adapter}\n  database: ruby_upgrade_test\n  host: localhost\n  username: nobody\n  password: not-a-real-password\n`);
    fs.writeFileSync(path.join(root, "config", "application.rb"), 'require "rails"\nrequire "active_record/railtie"\n\nmodule Smoke\n  class Application < Rails::Application\n    config.load_defaults 7.1\n    config.eager_load = false\n    config.root = File.expand_path("..", __dir__)\n  end\nend\n');
    fs.writeFileSync(path.join(root, "config", "environment.rb"), 'require_relative "application"\nRails.application.initialize!\n');
    fs.writeFileSync(path.join(root, "config", "boot.rb"), 'ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)\nrequire "bundler/setup"\n');
    fs.writeFileSync(path.join(root, "config", "environment"), "");
    fs.writeFileSync(path.join(root, "config", "environments", "test.rb"), 'Rails.application.configure do\n  config.cache_classes = true\n  config.eager_load = false\n  config.consider_all_requests_local = true\nend\n');
    fs.writeFileSync(path.join(root, "config", "routes.rb"), 'Rails.application.routes.draw do\nend\n');
    fs.writeFileSync(path.join(root, "Rakefile"), 'require_relative "config/application"\nRails.application.load_tasks\n');
    fs.writeFileSync(path.join(root, "bin", "rails"), '#!/usr/bin/env ruby\nAPP_PATH = File.expand_path("../config/application", __dir__)\nrequire_relative "../config/boot"\nrequire "rails/commands"\n');
    fs.writeFileSync(path.join(root, "spec", "spec_helper.rb"), 'ENV["RAILS_ENV"] ||= "test"\nrequire_relative "../config/environment"\nrequire "rspec"\n');
    // `rake db:create` reads the app's own database.yml, so the container hostname
    // and credentials arrive through the environment the runtime already sets.
    fs.writeFileSync(path.join(root, "spec", `${engine}_spec.rb`), spec.spec(spec.gem));
    command("git", ["init", "-q", "."]);
    command("git", ["add", "-A"]);
    command("git", ["-c", "user.name=smoke-test", "-c", "user.email=smoke-test@example.invalid", "commit", "-q", "-m", `${spec.database} smoke fixture`]);
    writeRun(root, reportPath, { schemaVersion: 2, validationReceiptsRequired: true, runId, title: `${spec.database} Docker smoke`, status: "in_progress", phase: "initialized", startedAt: new Date().toISOString(), targetRuby: "3.4", targetPinnedAt: new Date().toISOString(), research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] });

    // No `--database`: detection must infer the engine from the fixture above.
    const runtime = prepareTargetRuntime({ root, reportPath, ruby: "3.4.1" });
    assert.equal(runtime.database, engine, `expected detection to infer ${engine} from the fixture`);
    const receipt = executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec", expectedRuntime: { runId, reportPath }, timeoutMs: 600_000 });
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.testEvidence?.passed, true);
    assert.equal(receipt.environment.database, engine);
    assert.equal(receipt.environment.databaseImageRef, spec.image);
    // The persisted manifest is the artifact a real user commits alongside their
    // code, so assert on that file rather than the in-memory object: it must
    // carry no connection string and no local filesystem path. Identity is bound
    // to the run ID plus a hash of the worktree, never the path itself.
    const manifest = fs.readFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), "utf8");
    assert.equal(manifest.includes(spec.urlScheme), false, "manifest must not persist a connection string");
    assert.equal(manifest.includes(root), false);
    assert.equal(manifest.includes(os.tmpdir()), false);
    assert.match(JSON.parse(manifest).databaseImageId, /^sha256:[a-f0-9]{64}$/i);
    console.log(`${spec.database} Docker smoke passed: real ${spec.image}, ${spec.gem} connection, docker-bundle-rspec receipt, and secret-free manifest verified.`);
  } catch (error) {
    failure = error;
  } finally {
    // Best-effort safety net so a failing run does not strand containers or a
    // worktree, whether it fails mid-preparation or mid-RSpec. Both container
    // suffixes are attempted so the cleanup is correct regardless of which
    // engine was prepared.
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
  console.log(`${spec.database} teardown verified: no leftover containers, network, or worktree.`);
}

const requested = process.argv.slice(2);
const engines = requested.length === 0 ? Object.keys(ENGINES) : requested;
for (const engine of engines) {
  if (!Object.hasOwn(ENGINES, engine)) throw new Error(`--engine must be one of: ${Object.keys(ENGINES).join(", ")}.`);
}
for (const engine of engines) runSmoke(engine);
