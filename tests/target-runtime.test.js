import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeRun } from "../src/run-state.js";
import { prepareTargetRuntime, validateTargetRuntime } from "../src/target-runtime.js";
import { executeValidation } from "../src/validation-executor.js";

const run = (id, status = "in_progress") => ({ schemaVersion: 2, validationReceiptsRequired: true, runId: id, title: "Runtime test", status, phase: "initialized", startedAt: "2026-01-01T00:00:00Z", targetRuby: "3.4", targetPinnedAt: "2026-01-01T00:00:00Z", research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] });

function dockerFixture(root, runtime) {
  const app = { Id: "app-id", Image: `sha256:${"a".repeat(64)}`, Config: { Image: `ruby:${runtime.ruby}`, WorkingDir: "/app", Labels: { "io.opencode-ruby-upgrader.run-id": runtime.runId }, Env: ["RAILS_ENV=test", `DATABASE_URL=postgresql://postgres@${runtime.postgresContainer}:5432/ruby_upgrade_test`] }, State: { Running: true }, Mounts: [{ Type: "bind", Source: root, Destination: "/app" }], NetworkSettings: { Networks: { [runtime.network]: { NetworkID: "network-id" } } } };
  const postgres = { Id: "postgres-id", Config: { Labels: { "io.opencode-ruby-upgrader.run-id": runtime.runId } }, State: { Running: true }, NetworkSettings: { Networks: { [runtime.network]: { NetworkID: "network-id" } } } };
  return { app, postgres };
}

test("prepares a labelled fixed Docker runtime and persists nonsecret metadata", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "11111111-1111-4111-8111-111111111111";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rails"\n');
  const calls = [];
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, postgresContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network` };
  let appStarted = false;
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "network" && args[1] === "inspect") return { status: 1, stdout: "" };
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).app]) : "" };
    if (args[0] === "inspect" && args[1]?.endsWith("-postgres")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).postgres]) : "" };
    if (args[0] === "run" && args.includes(runtime.appContainer)) appStarted = true;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "bootstrap output", stderr: "" };
  };
  const prepared = prepareTargetRuntime({ root, ruby: "3.4.1", spawn });
  assert.equal(prepared.version, 2);
  assert.equal(prepared.resolvedImageId, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(Object.keys(prepared.preparation).sort(), ["bundleInstall", "bundler", "databaseCreate", "node", "rubyVersion"]);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), "utf8"));
  assert.deepEqual(persisted, prepared);
  assert.equal(JSON.stringify(persisted).includes("DATABASE_URL"), false);
  assert.equal(JSON.stringify(persisted).includes("bootstrap output"), false);
  assert.deepEqual(calls.slice(0, 12), [
    ["docker", ["network", "inspect", runtime.network]],
    ["docker", ["network", "create", "--label", `io.opencode-ruby-upgrader.run-id=${id}`, runtime.network]],
    ["docker", ["inspect", runtime.postgresContainer]],
    ["docker", ["run", "--detach", "--name", runtime.postgresContainer, "--label", `io.opencode-ruby-upgrader.run-id=${id}`, "--network", runtime.network, "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=ruby_upgrade_test", "postgres:16-alpine"]],
    ["docker", ["exec", runtime.postgresContainer, "pg_isready", "-U", "postgres", "-d", "ruby_upgrade_test"]],
    ["docker", ["inspect", runtime.appContainer]],
    ["docker", ["run", "--detach", "--name", runtime.appContainer, "--label", `io.opencode-ruby-upgrader.run-id=${id}`, "--network", runtime.network, "--mount", `type=bind,src=${root},dst=/app`, "--workdir", "/app", "--env", "RAILS_ENV=test", "--env", `DATABASE_URL=postgresql://postgres@${runtime.postgresContainer}:5432/ruby_upgrade_test`, "ruby:3.4.1", "sleep", "infinity"]],
    ["docker", ["exec", runtime.appContainer, "sh", "-c", "set -eu; . /etc/os-release; codename=${VERSION_CODENAME:-stretch}; printf '%s\\n' \"deb http://deb.debian.org/debian ${codename} main\" > /etc/apt/sources.list; printf '%s\\n' 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99archive; if ! apt-get update; then printf '%s\\n' \"deb http://archive.debian.org/debian ${codename} main\" > /etc/apt/sources.list; apt-get update; fi; apt-get install -y --no-install-recommends nodejs; if [ ! -x /usr/bin/node ]; then ln -sf /usr/bin/nodejs /usr/local/bin/node; fi; node --version"]],
    ["docker", ["exec", runtime.appContainer, "gem", "install", "bundler", "-v", "2.4.22", "--no-document"]],
    ["docker", ["exec", runtime.appContainer, "bundle", "_2.4.22_", "install"]],
    ["docker", ["exec", runtime.appContainer, "bundle", "exec", "rake", "db:create"]],
    ["docker", ["exec", runtime.appContainer, "ruby", "--version"]]
  ]);
});

test("docker RSpec reuses prepared runtime metadata without an environment variable", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-executor-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture"], { cwd: root });
  const id = "22222222-2222-4222-8222-222222222222";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, postgresContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network` };
  let appStarted = false;
  const spawn = (command, args) => {
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: "[]" };
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).app]) : "" };
    if (args[0] === "inspect" && args[1]?.endsWith("-postgres")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).postgres]) : "" };
    if (args[0] === "run" && args.includes(runtime.appContainer)) appStarted = true;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "1 example, 0 failures\nFinished in 0.1 seconds\n", stderr: "" };
  };
  prepareTargetRuntime({ root, ruby: "3.4.1", spawn });
  const receipt = executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec", spawn });
  assert.equal(receipt.environment.name, runtime.appContainer);
  assert.equal(receipt.environment.ruby, "3.4.1");
  assert.deepEqual(receipt.argv, ["docker", "exec", "--env", "DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL=true", runtime.appContainer, "bundle", "exec", "rspec"]);
  const update = executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "rails-app-update", spawn });
  assert.deepEqual(update.argv.slice(0, 9), ["docker", "exec", "--env", "DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL=true", runtime.appContainer, "bundle", "exec", "ruby", "-e"]);
  assert.match(update.argv[9], /behavior: :skip/);
});

test("preparation retry reuses a labelled app container before a manifest exists", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-retry-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "55555555-5555-4555-8555-555555555555";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, postgresContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network` };
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: 0, stdout: JSON.stringify([dockerFixture(root, runtime).app]) };
    if (args[0] === "inspect" && args[1]?.endsWith("-postgres")) return { status: 0, stdout: JSON.stringify([dockerFixture(root, runtime).postgres]) };
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "ok", stderr: "" };
  };
  prepareTargetRuntime({ root, ruby: "3.4.1", spawn });
  assert.equal(calls.some(([, args]) => args[0] === "rm"), false);
  assert.equal(calls.some(([, args]) => args[0] === "run" && args.includes(runtime.appContainer)), false);
});

test("target runtime rejects a mutable image tag resolving to a different image ID", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-image-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = { version: 2, runId: "55555555-5555-4555-8555-555555555555", reportPath: ".ruby-upgrades/runs/runtime.json", ruby: "3.4.1", appContainer: "ruby-upgrader-55555555-5555-4555-8555-555555555555-app", postgresContainer: "ruby-upgrader-55555555-5555-4555-8555-555555555555-postgres", network: "ruby-upgrader-55555555-5555-4555-8555-555555555555-network", resolvedImageId: `sha256:${"b".repeat(64)}`, preparation: { node: {}, bundler: {}, bundleInstall: {}, rubyVersion: {} } };
  const { app, postgres } = dockerFixture(root, runtime);
  const spawn = (_command, args) => ({ status: 0, stdout: JSON.stringify([args[1] === runtime.appContainer ? app : postgres]) });
  assert.throws(() => validateTargetRuntime({ root, runtime, spawn }), /no longer matches/);
});

test("target runtime preparation rejects ambiguous active runs and nonnumeric Ruby", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-ambiguous-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRun(root, ".ruby-upgrades/runs/one.json", run("33333333-3333-4333-8333-333333333333"));
  writeRun(root, ".ruby-upgrades/runs/two.json", run("44444444-4444-4444-8444-444444444444", "paused"));
  assert.throws(() => prepareTargetRuntime({ root, ruby: "3.4.1" }), /Multiple active or paused/);
  assert.throws(() => prepareTargetRuntime({ root, ruby: "ruby-3.4.1" }), /exact numeric/);
});
