import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeRun } from "../src/run-state.js";
import { prepareTargetRuntime, validateTargetRuntime } from "../src/target-runtime.js";
import { detectDatabase } from "../src/databases.js";
import { executeValidation } from "../src/validation-executor.js";

const run = (id, status = "in_progress") => ({ schemaVersion: 2, validationReceiptsRequired: true, runId: id, title: "Runtime test", status, phase: "initialized", startedAt: "2026-01-01T00:00:00Z", targetRuby: "3.4", targetPinnedAt: "2026-01-01T00:00:00Z", research: { ladder: [], citations: [] }, riskDecisions: [], iterations: [] });
const rootHash = (root) => crypto.createHash("sha256").update(root).digest("hex");
const APP_ID = "d".repeat(64);
const DATABASE_ID = "e".repeat(64);
const NETWORK_ID = "f".repeat(64);

// The worktree label always mirrors the current root's hash. Pass `legacy: true`
// to simulate pre-ownership resources, which carry the run label only.
function ownershipLabels(root, runId, legacy = false) {
  return legacy ? { "io.opencode-ruby-upgrader.run-id": runId } : { "io.opencode-ruby-upgrader.run-id": runId, "io.opencode-ruby-upgrader.worktree-sha256": rootHash(root) };
}
function dockerFixture(root, runtime, { legacy = false } = {}) {
  const ownership = ownershipLabels(root, runtime.runId, legacy);
  const app = { Id: APP_ID, Image: `sha256:${"a".repeat(64)}`, Config: { Image: `ruby:${runtime.ruby}`, WorkingDir: "/app", Cmd: ["sleep", "infinity"], Labels: ownership, Env: ["RAILS_ENV=test", `DATABASE_URL=${runtime.databaseUrl}`] }, HostConfig: { PortBindings: {}, Privileged: false }, State: { Running: true }, Mounts: [{ Type: "bind", Source: root, Destination: "/app" }], NetworkSettings: { Networks: { [runtime.network]: { NetworkID: NETWORK_ID } } } };
  const databaseImage = runtime.databaseUrl.startsWith("mysql2:") ? "mysql:8.4" : "postgres:16-alpine";
  const databaseEnvironment = databaseImage.startsWith("mysql:") ? ["MYSQL_ALLOW_EMPTY_PASSWORD=yes", "MYSQL_DATABASE=ruby_upgrade_test"] : ["POSTGRES_HOST_AUTH_METHOD=trust", "POSTGRES_DB=ruby_upgrade_test"];
  const database = { Id: DATABASE_ID, Image: `sha256:${"c".repeat(64)}`, Config: { Image: databaseImage, Labels: ownership, Env: databaseEnvironment }, HostConfig: { PortBindings: {}, Privileged: false }, State: { Running: true }, Mounts: [{ Type: "volume", Source: "anonymous", Destination: "/var/lib/database" }], NetworkSettings: { Networks: { [runtime.network]: { NetworkID: NETWORK_ID } } } };
  return { app, database };
}
// `worktreeHash: null` omits the label entirely (pre-ownership resources);
// pass a foreign hash to simulate another worktree's resources.
function networkFixture(runtime, runId = runtime.runId, worktreeHash = rootHash(runtime.root)) {
  const ownership = worktreeHash === null ? { "io.opencode-ruby-upgrader.run-id": runId } : { "io.opencode-ruby-upgrader.run-id": runId, "io.opencode-ruby-upgrader.worktree-sha256": worktreeHash };
  return JSON.stringify([{ Id: NETWORK_ID, Name: runtime.network, Labels: ownership, Containers: { [APP_ID]: { Name: runtime.appContainer }, [DATABASE_ID]: { Name: runtime.databaseContainer } } }]);
}

test("prepares a labelled fixed Docker runtime and persists nonsecret metadata", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "11111111-1111-4111-8111-111111111111";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rails"\n');
  const calls = [];
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  let appStarted = false;
  let networkCreated = false;
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "network" && args[1] === "inspect") return { status: networkCreated ? 0 : 1, stdout: networkCreated ? networkFixture(runtime, id, rootHash(root)) : "" };
    if (args[0] === "network" && args[1] === "create") networkCreated = true;
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).app]) : "" };
    if (args[0] === "inspect" && args[1] === runtime.databaseContainer) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).database]) : "" };
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args[0] === "run" && args.includes(runtime.appContainer)) appStarted = true;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "bootstrap output", stderr: "" };
  };
  const prepared = prepareTargetRuntime({ root, ruby: "3.4.1", spawn });
  assert.equal(prepared.version, 2);
  assert.equal(prepared.database, "postgres");
  assert.equal(prepared.resolvedImageId, `sha256:${"a".repeat(64)}`);
  assert.equal(prepared.databaseImageId, `sha256:${"c".repeat(64)}`);
  assert.deepEqual(Object.keys(prepared.preparation).sort(), ["bundleInstall", "bundler", "databaseCreate", "node", "rubyVersion"]);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), "utf8"));
  assert.deepEqual(persisted, prepared);
  assert.equal(JSON.stringify(persisted).includes("DATABASE_URL"), false);
  assert.equal(JSON.stringify(persisted).includes("bootstrap output"), false);
  assert.equal(JSON.stringify(persisted).includes(root), false);
  // The worktree fingerprint belongs on the Docker labels, where it binds
  // resources to this worktree. Persisting it in a file users are meant to
  // commit would publish a dictionary-attackable hash of their filesystem path.
  assert.equal(Object.hasOwn(persisted, "worktreeHash"), false);
  assert.equal(JSON.stringify(persisted).includes(rootHash(root)), false);
  const ownership = [`io.opencode-ruby-upgrader.run-id=${id}`, `io.opencode-ruby-upgrader.worktree-sha256=${rootHash(root)}`];
  for (const args of calls.filter(([, args]) => args[0] === "run" || (args[0] === "network" && args[1] === "create")).map(([, args]) => args)) {
    assert.equal(ownership.every((label) => args.includes(label)), true);
  }
  assert.equal(calls.some(([, args]) => args[0] === "exec" && args.includes("pg_isready")), true);
  assert.equal(calls.some(([, args]) => args[0] === "exec" && args.includes("db:create")), true);
});

test("docker RSpec reuses prepared runtime metadata without an environment variable", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-executor-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture"], { cwd: root });
  const id = "22222222-2222-4222-8222-222222222222";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  let appStarted = false;
  const spawn = (command, args) => {
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: networkFixture(runtime, id, rootHash(root)) };
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).app]) : "" };
    if (args[0] === "inspect" && args[1] === runtime.databaseContainer) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).database]) : "" };
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args[0] === "run" && args.includes(runtime.appContainer)) appStarted = true;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "1 example, 0 failures\nFinished in 0.1 seconds\n", stderr: "" };
  };
  prepareTargetRuntime({ root, ruby: "3.4.1", spawn });
  const expectedRuntime = { runId: id, reportPath: ".ruby-upgrades/runs/runtime.json" };
  assert.throws(() => executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec", expectedRuntime: { ...expectedRuntime, runId: "33333333-3333-4333-8333-333333333333" }, spawn }), /does not belong to the selected upgrade report/);
  const receipt = executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec", expectedRuntime, spawn });
  assert.equal(receipt.environment.name, runtime.appContainer);
  assert.equal(receipt.environment.ruby, "3.4.1");
  assert.equal(receipt.environment.database, "postgres");
  assert.equal(receipt.environment.databaseImageRef, "postgres:16-alpine");
  assert.equal(receipt.environment.databaseImageId, `sha256:${"c".repeat(64)}`);
  assert.equal(receipt.environment.runId, id);
  assert.equal(receipt.environment.reportPath, expectedRuntime.reportPath);
  assert.equal(receipt.environment.databaseContainerId, DATABASE_ID);
  assert.equal(receipt.environment.networkId, NETWORK_ID);
  assert.deepEqual(receipt.argv, ["docker", "exec", "--env", "DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL=true", runtime.appContainer, "bundle", "exec", "rspec"]);
  const update = executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "rails-app-update", expectedRuntime, spawn });
  assert.deepEqual(update.argv.slice(0, 9), ["docker", "exec", "--env", "DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL=true", runtime.appContainer, "bundle", "exec", "ruby", "-e"]);
  assert.match(update.argv[9], /behavior: :skip/);
});

test("preparation retry reuses a labelled app container before a manifest exists", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-retry-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "55555555-5555-4555-8555-555555555555";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: networkFixture(runtime, id, rootHash(root)) };
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: 0, stdout: JSON.stringify([dockerFixture(root, runtime).app]) };
    if (args[0] === "inspect" && args[1] === runtime.databaseContainer) return { status: 0, stdout: JSON.stringify([dockerFixture(root, runtime).database]) };
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "ok", stderr: "" };
  };
  prepareTargetRuntime({ root, ruby: "3.4.1", spawn });
  assert.equal(calls.some(([, args]) => args[0] === "rm"), false);
  assert.equal(calls.some(([, args]) => args[0] === "run" && args.includes(runtime.appContainer)), false);
});

test("preparation reuses and upgrades a legacy PostgreSQL runtime manifest", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-legacy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "66666666-6666-4666-8666-666666666666";
  const reportPath = ".ruby-upgrades/runs/runtime.json";
  writeRun(root, reportPath, run(id));
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rails"\ngem "pg"\n');
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  fs.writeFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), `${JSON.stringify({ version: 2, runId: id, reportPath, ruby: runtime.ruby, appContainer: runtime.appContainer, postgresContainer: runtime.databaseContainer, network: runtime.network, resolvedImageId: `sha256:${"a".repeat(64)}`, preparation: { node: {}, bundler: {}, bundleInstall: {}, databaseCreate: {}, rubyVersion: {} } }, null, 2)}\n`);
  const calls = [];
  // Pre-ownership resources carry the run label only. Migration proves
  // ownership from the root mount, tears them down, and recreates them with
  // both labels -- so the stub must model that transition, not just the
  // pre-migration state.
  let migrated = false;
  let recreated = false;
  const spawn = (_command, args) => {
    calls.push(args);
    if (args[0] === "rm") { migrated = true; return { status: 0, stdout: "" }; }
    if (args[0] === "network" && args[1] === "create") { recreated = true; return { status: 0, stdout: "" }; }
    if (args[0] === "network" && args[1] === "inspect") {
      if (!migrated) return { status: 0, stdout: networkFixture(runtime, id, null) };
      return recreated ? { status: 0, stdout: networkFixture(runtime, id, rootHash(root)) } : { status: 1, stdout: "" };
    }
    if (args[0] === "inspect" && (args[1] === runtime.appContainer || args[1] === runtime.databaseContainer)) {
      const fixture = dockerFixture(root, runtime, { legacy: !recreated });
      const container = args[1] === runtime.appContainer ? fixture.app : fixture.database;
      if (migrated && !recreated) return { status: 1, stdout: "" };
      return { status: 0, stdout: JSON.stringify([container]) };
    }
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "ok", stderr: "" };
  };

  const prepared = prepareTargetRuntime({ root, ruby: runtime.ruby, spawn });
  assert.equal(prepared.database, "postgres");
  assert.equal(prepared.databaseContainer, runtime.databaseContainer);
  assert.equal(calls.some((args) => args[0] === "rm"), true);
  assert.equal(calls.some((args) => args[0] === "run"), true);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), "utf8"));
  assert.equal(persisted.postgresContainer, undefined);
  assert.equal(persisted.database, "postgres");
  assert.equal(persisted.databaseContainer, runtime.databaseContainer);
});

test("target runtime rejects a mutable image tag resolving to a different image ID", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-image-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = { version: 2, runId: "55555555-5555-4555-8555-555555555555", reportPath: ".ruby-upgrades/runs/runtime.json", ruby: "3.4.1", database: "postgres", appContainer: "ruby-upgrader-55555555-5555-4555-8555-555555555555-app", databaseContainer: "ruby-upgrader-55555555-5555-4555-8555-555555555555-postgres", network: "ruby-upgrader-55555555-5555-4555-8555-555555555555-network", databaseUrl: "postgresql://postgres@ruby-upgrader-55555555-5555-4555-8555-555555555555-postgres:5432/ruby_upgrade_test", resolvedImageId: `sha256:${"b".repeat(64)}`, preparation: { node: {}, bundler: {}, bundleInstall: {}, rubyVersion: {} } };
  const { app, database } = dockerFixture(root, runtime);
  const spawn = (_command, args) => ({ status: 0, stdout: args[0] === "network" ? networkFixture(runtime, runtime.runId, rootHash(root)) : JSON.stringify([args[1] === runtime.appContainer ? app : database]) });
  assert.throws(() => validateTargetRuntime({ root, runtime, spawn }), /no longer matches/);
});

test("target runtime rejects database image drift", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-database-image-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "77777777-7777-4777-8777-777777777777";
  const runtime = { version: 2, runId: id, reportPath: ".ruby-upgrades/runs/runtime.json", ruby: "3.4.1", database: "postgres", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test`, resolvedImageId: `sha256:${"a".repeat(64)}`, databaseImageId: `sha256:${"b".repeat(64)}`, preparation: { node: {}, bundler: {}, bundleInstall: {}, rubyVersion: {} } };
  const { app, database } = dockerFixture(root, runtime);
  const spawn = (_command, args) => ({ status: 0, stdout: args[0] === "network" ? networkFixture(runtime, runtime.runId, rootHash(root)) : JSON.stringify([args[1] === runtime.appContainer ? app : database]) });
  assert.throws(() => validateTargetRuntime({ root, runtime, spawn }), /no longer matches/);
});

test("validation refuses resources labelled for a different worktree", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-cross-worktree-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "78787878-7878-4787-8787-787878787878";
  const runtime = { version: 2, runId: id, reportPath: ".ruby-upgrades/runs/runtime.json", ruby: "3.4.1", database: "postgres", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test`, resolvedImageId: `sha256:${"a".repeat(64)}`, databaseImageId: `sha256:${"c".repeat(64)}`, preparation: {} };
  const foreign = "f".repeat(64);
  const { app, database } = dockerFixture(root, runtime);
  for (const container of [app, database]) container.Config.Labels["io.opencode-ruby-upgrader.worktree-sha256"] = foreign;
  // The manifest carries no worktree fingerprint, so validation must inspect the
  // live resources and compare their labels against this worktree. A manifest
  // copied from another worktree therefore cannot vouch for foreign containers.
  const spawn = (_command, args) => ({ status: 0, stdout: args[0] === "network" ? networkFixture(runtime, id, foreign) : JSON.stringify([args[1] === runtime.appContainer ? app : database]) });
  assert.throws(() => validateTargetRuntime({ root, runtime, spawn }), /no longer matches/);
});

test("validation rejects container exposure and unexpected runtime shape", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-exposure-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "79797979-7979-4797-8797-797979797979";
  const runtime = { version: 2, runId: id, reportPath: ".ruby-upgrades/runs/runtime.json", ruby: "3.4.1", database: "postgres", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test`, resolvedImageId: `sha256:${"a".repeat(64)}`, databaseImageId: `sha256:${"c".repeat(64)}`, preparation: {} };
  const cases = {
    "extra app network": ({ app }) => { app.NetworkSettings.Networks.other = {}; },
    "published app port": ({ app }) => { app.HostConfig.PortBindings["3000/tcp"] = [{ HostPort: "3000" }]; },
    "privileged database": ({ database }) => { database.HostConfig.Privileged = true; },
    "unexpected app mount": ({ app }) => { app.Mounts.push({ Type: "volume", Destination: "/tmp" }); },
    "unexpected app command": ({ app }) => { app.Config.Cmd = ["bash"]; },
    "database bind mount": ({ database }) => { database.Mounts.push({ Type: "bind", Source: "/tmp", Destination: "/data" }); },
    "unexpected network member": ({ network }) => { network.Containers.foreign = { Name: "foreign" }; }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, () => {
      const fixtures = dockerFixture(root, runtime);
      const [network] = JSON.parse(networkFixture(runtime, runtime.runId, rootHash(root)));
      mutate({ ...fixtures, network });
      const spawn = (_command, args) => ({ status: 0, stdout: args[0] === "network" ? JSON.stringify([network]) : JSON.stringify([args[1] === runtime.appContainer ? fixtures.app : fixtures.database]) });
      assert.throws(() => validateTargetRuntime({ root, runtime, spawn }), /no longer matches/);
    });
  }
});

test("database readiness failure removes the owned unhealthy container and preserves the error", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-readiness-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "76767676-7676-4767-8767-767676767676";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const databaseContainer = `ruby-upgrader-${id}-postgres`;
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" || (args[0] === "network" && args[1] === "inspect")) return { status: 1, stdout: "" };
    if (args[0] === "exec" && args.includes("pg_isready")) throw new Error("original readiness failure");
    if (args[0] === "rm") return { error: new Error("cleanup also failed") };
    return { status: 0, stdout: "ok", stderr: "" };
  };
  assert.throws(() => prepareTargetRuntime({ root, ruby: "3.4.1", spawn }), /original readiness failure/);
  assert.equal(calls.some((args) => args[0] === "rm" && args.includes(databaseContainer)), true);
});

test("preparation refuses a Docker network not owned by the selected run", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-network-label-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "99999999-9999-4999-8999-999999999999";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const runtime = { runId: id, network: `ruby-upgrader-${id}-network` };
  const spawn = (_command, args) => args[0] === "network" && args[1] === "inspect"
    ? { status: 0, stdout: networkFixture(runtime, "another-run", rootHash(root)) }
    : args[0] === "inspect" ? { status: 1, stdout: "" } : { status: 0, stdout: "ok", stderr: "" };
  assert.throws(() => prepareTargetRuntime({ root, ruby: "3.4.1", spawn }), /not owned by this run and worktree/);
});

test("preparation refuses a resource labelled for the same run but another worktree", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-resource-worktree-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "98989898-9898-4989-8989-989898989898";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const runtime = { runId: id, network: `ruby-upgrader-${id}-network` };
  const spawn = (_command, args) => args[0] === "network" && args[1] === "inspect"
    ? { status: 0, stdout: networkFixture(runtime, id, "e".repeat(64)) }
    : { status: 1, stdout: "" };
  assert.throws(() => prepareTargetRuntime({ root, ruby: "3.4.1", spawn }), /not owned by this run and worktree/);
});

test("legacy resources without a root-mounted app fail closed", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-legacy-closed-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "97979797-9797-4979-8797-979797979797";
  const reportPath = ".ruby-upgrades/runs/runtime.json";
  writeRun(root, reportPath, run(id));
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  fs.writeFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), `${JSON.stringify({ version: 2, runId: id, reportPath, ruby: runtime.ruby, database: "postgres", appContainer: runtime.appContainer, databaseContainer: runtime.databaseContainer, network: runtime.network, resolvedImageId: `sha256:${"a".repeat(64)}`, preparation: {} })}\n`);
  const legacyDatabase = dockerFixture(root, runtime).database;
  delete legacyDatabase.Config.Labels["io.opencode-ruby-upgrader.worktree-sha256"];
  const spawn = (_command, args) => {
    if (args[0] === "network") return { status: 1, stdout: "" };
    if (args[0] === "inspect" && args[1] === runtime.databaseContainer) return { status: 0, stdout: JSON.stringify([legacyDatabase]) };
    return { status: 1, stdout: "" };
  };
  assert.throws(() => prepareTargetRuntime({ root, ruby: runtime.ruby, spawn }), /ownership by this worktree cannot be established/);
});

test("target runtime preparation rejects ambiguous active runs and nonnumeric Ruby", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-ambiguous-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRun(root, ".ruby-upgrades/runs/one.json", run("33333333-3333-4333-8333-333333333333"));
  writeRun(root, ".ruby-upgrades/runs/two.json", run("44444444-4444-4444-8444-444444444444", "paused"));
  assert.throws(() => prepareTargetRuntime({ root, ruby: "3.4.1" }), /Multiple active or paused/);
  assert.throws(() => prepareTargetRuntime({ root, ruby: "ruby-3.4.1" }), /exact numeric/);
});

test("prepares an isolated MySQL runtime from a project that declares mysql2", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-mysql-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "66666666-6666-4666-8666-666666666666";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rails"\ngem "mysql2"\n');
  fs.writeFileSync(path.join(root, "config/database.yml"), "test:\n  adapter: mysql2\n  database: ruby_upgrade_test\n");
  const calls = [];
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-mysql`, network: `ruby-upgrader-${id}-network`, databaseUrl: `mysql2://root@ruby-upgrader-${id}-mysql:3306/ruby_upgrade_test` };
  let appStarted = false;
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: networkFixture(runtime, id, rootHash(root)) };
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).app]) : "" };
    if (args[0] === "inspect" && args[1] === runtime.databaseContainer) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).database]) : "" };
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args[0] === "run" && args.includes(runtime.appContainer)) appStarted = true;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "bootstrap output", stderr: "" };
  };
  // No --database flag: the adapter is detected from the project's own gems.
  const prepared = prepareTargetRuntime({ root, ruby: "3.4.1", spawn });
  assert.equal(prepared.database, "mysql");
  assert.equal(prepared.databaseContainer, runtime.databaseContainer);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), "utf8"));
  assert.equal(persisted.database, "mysql");
  assert.equal(JSON.stringify(persisted).includes("DATABASE_URL"), false);
  assert.equal(calls.some(([, args]) => args[0] === "inspect" && args[1]?.endsWith("-postgres")), true);
  assert.equal(calls.some(([, args]) => args[0] === "run" && args.includes(runtime.databaseContainer) && args.includes(`io.opencode-ruby-upgrader.worktree-sha256=${rootHash(root)}`)), true);
  assert.equal(calls.some(([, args]) => args[0] === "run" && args.includes(runtime.appContainer) && args.includes(`DATABASE_URL=${runtime.databaseUrl}`)), true);
  // The test database is created server-side, so preparation never depends on
  // the app's own driver being installed yet.
  const createCall = calls.find(([, args]) => args.some((arg) => typeof arg === "string" && arg.includes("CREATE DATABASE")));
  assert.deepEqual(createCall, ["docker", ["exec", runtime.databaseContainer, "mysql", "-h", "127.0.0.1", "-u", "root", "-e", "CREATE DATABASE IF NOT EXISTS `ruby_upgrade_test` CHARACTER SET utf8mb4"]]);
  assert.equal(calls.some(([, args]) => args.includes("rake") && args.includes("db:create")), false);
});

test("an explicit --database overrides detection and is verified on every reuse", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-mysql-override-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture"], { cwd: root });
  const id = "77777777-7777-4777-8777-777777777777";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  // A PostgreSQL project, but the user explicitly asks for MySQL.
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rails"\ngem "pg"\n');
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-mysql`, network: `ruby-upgrader-${id}-network`, databaseUrl: `mysql2://root@ruby-upgrader-${id}-mysql:3306/ruby_upgrade_test` };
  let appStarted = false;
  const spawn = (command, args) => {
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: networkFixture(runtime, id, rootHash(root)) };
    if (args[0] === "inspect" && args[1]?.endsWith("-app")) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).app]) : "" };
    if (args[0] === "inspect" && args[1] === runtime.databaseContainer) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, runtime).database]) : "" };
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args[0] === "run" && args.includes(runtime.appContainer)) appStarted = true;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "1 example, 0 failures\nFinished in 0.1 seconds\n", stderr: "" };
  };
  const prepared = prepareTargetRuntime({ root, ruby: "3.4.1", database: "mysql", spawn });
  assert.equal(prepared.database, "mysql");
  const receipt = executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec", expectedRuntime: { runId: id, reportPath: ".ruby-upgrades/runs/runtime.json" }, spawn });
  assert.equal(receipt.environment.database, "mysql");
  // The receipt binds the run to an engine, never to the connection string.
  assert.equal(JSON.stringify(receipt).includes(runtime.databaseUrl), false);
  assert.throws(() => prepareTargetRuntime({ root, ruby: "3.4.1", database: "sqlite", spawn }), /--database must be one of/);
});

test("switching the database adapter replaces an interrupted app container without a manifest", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-adapter-switch-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "88888888-8888-4888-8888-888888888888";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const postgres = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  const mysql = { ...postgres, databaseContainer: `ruby-upgrader-${id}-mysql`, databaseUrl: `mysql2://root@ruby-upgrader-${id}-mysql:3306/ruby_upgrade_test` };
  let appStarted = false;
  let current = postgres;
  let appRuntime = postgres;
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: networkFixture(current, id, rootHash(root)) };
    if (args[0] === "inspect" && args[1] === current.databaseContainer) return { status: 0, stdout: JSON.stringify([dockerFixture(root, current).database]) };
    if (args[0] === "inspect" && args[1] === postgres.databaseContainer) return { status: 0, stdout: JSON.stringify([dockerFixture(root, postgres).database]) };
    if (args[0] === "inspect" && args[1] === postgres.appContainer) return { status: appStarted ? 0 : 1, stdout: appStarted ? JSON.stringify([dockerFixture(root, appRuntime).app]) : "" };
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args[0] === "run" && args.includes(current.appContainer)) { appStarted = true; appRuntime = current; }
    if (args[0] === "rm" && args.includes(postgres.appContainer)) appStarted = false;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "ok", stderr: "" };
  };
  prepareTargetRuntime({ root, ruby: "3.4.1", database: "postgres", spawn });
  assert.equal(calls.some(([, args]) => args[0] === "rm"), false);
  fs.rmSync(path.join(root, ".ruby-upgrades", "runtime.json"));
  // The app container's DATABASE_URL points at the old engine, so reusing it
  // would silently validate against PostgreSQL.
  calls.length = 0;
  current = mysql;
  const switched = prepareTargetRuntime({ root, ruby: "3.4.1", database: "mysql", spawn });
  assert.equal(switched.database, "mysql");
  assert.equal(calls.some(([, args]) => args[0] === "rm" && args[1] === "--force" && args[2] === postgres.appContainer), true);
  assert.equal(calls.some(([, args]) => args[0] === "run" && args.includes(mysql.appContainer)), true);
  assert.equal(calls.some(([, args]) => args[0] === "rm" && args[1] === "--force" && args[2] === postgres.databaseContainer), true);
});

test("switching engines removes an owned old database even when the app is absent", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-stale-database-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "89898989-8989-4898-8898-898989898989";
  const reportPath = ".ruby-upgrades/runs/runtime.json";
  writeRun(root, reportPath, run(id));
  const postgres = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  const mysql = { ...postgres, databaseContainer: `ruby-upgrader-${id}-mysql`, databaseUrl: `mysql2://root@ruby-upgrader-${id}-mysql:3306/ruby_upgrade_test` };
  fs.writeFileSync(path.join(root, ".ruby-upgrades", "runtime.json"), `${JSON.stringify({ version: 2, runId: id, reportPath, ruby: "3.4.1", database: "postgres", appContainer: postgres.appContainer, databaseContainer: postgres.databaseContainer, network: postgres.network, resolvedImageId: `sha256:${"a".repeat(64)}`, preparation: {} })}\n`);
  let postgresExists = true; let mysqlExists = false; let appExists = false;
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: networkFixture(mysql, mysql.runId, rootHash(root)) };
    if (args[0] === "inspect" && args[1] === mysql.appContainer) return { status: appExists ? 0 : 1, stdout: appExists ? JSON.stringify([dockerFixture(root, mysql).app]) : "" };
    if (args[0] === "inspect" && args[1] === postgres.databaseContainer) return { status: postgresExists ? 0 : 1, stdout: postgresExists ? JSON.stringify([dockerFixture(root, postgres).database]) : "" };
    if (args[0] === "inspect" && args[1] === mysql.databaseContainer) return { status: mysqlExists ? 0 : 1, stdout: mysqlExists ? JSON.stringify([dockerFixture(root, mysql).database]) : "" };
    if (args[0] === "rm" && args.includes(postgres.databaseContainer)) postgresExists = false;
    if (args[0] === "run" && args.includes(mysql.databaseContainer)) mysqlExists = true;
    if (args[0] === "run" && args.includes(mysql.appContainer)) appExists = true;
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "ok", stderr: "" };
  };
  prepareTargetRuntime({ root, ruby: "3.4.1", database: "mysql", spawn });
  assert.equal(calls.some(([, args]) => args[0] === "rm" && args.includes(postgres.databaseContainer)), true);
});

test("old-engine cleanup refuses a foreign-labelled database", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-foreign-database-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "86868686-8686-4868-8868-868686868686";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const postgres = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  const mysql = { ...postgres, databaseContainer: `ruby-upgrader-${id}-mysql`, databaseUrl: `mysql2://root@ruby-upgrader-${id}-mysql:3306/ruby_upgrade_test` };
  const foreign = dockerFixture(root, postgres).database;
  foreign.Config.Labels["io.opencode-ruby-upgrader.run-id"] = "another-run";
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    if (args[0] === "network") return { status: 0, stdout: networkFixture(mysql, id, rootHash(root)) };
    if (args[0] === "inspect" && args[1] === postgres.databaseContainer) return { status: 0, stdout: JSON.stringify([foreign]) };
    return { status: 1, stdout: "" };
  };
  assert.throws(() => prepareTargetRuntime({ root, ruby: "3.4.1", database: "mysql", spawn }), /not owned by this run and worktree/);
  assert.equal(calls.some((args) => args[0] === "rm"), false);
});

test("preparation replaces stopped owned app and database containers", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-stopped-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  writeRun(root, ".ruby-upgrades/runs/runtime.json", run(id));
  const runtime = { runId: id, ruby: "3.4.1", appContainer: `ruby-upgrader-${id}-app`, databaseContainer: `ruby-upgrader-${id}-postgres`, network: `ruby-upgrader-${id}-network`, databaseUrl: `postgresql://postgres@ruby-upgrader-${id}-postgres:5432/ruby_upgrade_test` };
  let appExists = true; let appRunning = false;
  let databaseExists = true; let databaseRunning = false;
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "network" && args[1] === "inspect") return { status: 0, stdout: networkFixture(runtime, id, rootHash(root)) };
    if (args[0] === "inspect" && args[1] === runtime.appContainer) { const app = dockerFixture(root, runtime).app; app.State.Running = appRunning; return { status: appExists ? 0 : 1, stdout: appExists ? JSON.stringify([app]) : "" }; }
    if (args[0] === "inspect" && args[1] === runtime.databaseContainer) { const database = dockerFixture(root, runtime).database; database.State.Running = databaseRunning; return { status: databaseExists ? 0 : 1, stdout: databaseExists ? JSON.stringify([database]) : "" }; }
    if (args[0] === "inspect") return { status: 1, stdout: "" };
    if (args[0] === "rm" && args.includes(runtime.appContainer)) appExists = false;
    if (args[0] === "rm" && args.includes(runtime.databaseContainer)) databaseExists = false;
    if (args[0] === "run" && args.includes(runtime.appContainer)) { appExists = true; appRunning = true; }
    if (args[0] === "run" && args.includes(runtime.databaseContainer)) { databaseExists = true; databaseRunning = true; }
    if (args.at(-2) === "ruby" && args.at(-1) === "--version") return { status: 0, stdout: "ruby 3.4.1p0\n" };
    return { status: 0, stdout: "ok", stderr: "" };
  };

  prepareTargetRuntime({ root, ruby: runtime.ruby, spawn });
  for (const name of [runtime.appContainer, runtime.databaseContainer]) {
    assert.equal(calls.some(([, args]) => args[0] === "rm" && args.includes(name)), true);
    assert.equal(calls.some(([, args]) => args[0] === "run" && args.includes(name)), true);
  }
});

test("database detection reads the project's own declarations and defaults to PostgreSQL", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-detect-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (files) => { fs.rmSync(path.join(root, "Gemfile"), { force: true }); fs.rmSync(path.join(root, "config"), { recursive: true, force: true }); for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); } };
  write({ Gemfile: 'gem "rails"\ngem "mysql2"\n' });
  assert.equal(detectDatabase(root), "mysql");
  write({ Gemfile: 'gem "rails"\ngem "trilogy", "~> 0.11"\n' });
  assert.equal(detectDatabase(root), "postgres");
  write({ Gemfile: '# gem "mysql2"\ngem "rails"\n' });
  assert.equal(detectDatabase(root), "postgres");
  write({ Gemfile: 'gem "mysql2" # gem "pg" is not active\n' });
  assert.equal(detectDatabase(root), "mysql");
  write({ "config/database.yml": "test:\n  adapter: mysql2\n  database: ruby_upgrade_test\n" });
  assert.equal(detectDatabase(root), "mysql");
  write({ "config/database.yml": "test:\n  adapter: mysql\n  database: ruby_upgrade_test\n" });
  assert.equal(detectDatabase(root), "postgres");
  write({ Gemfile: 'gem "rails"\ngem "pg"\n' });
  assert.equal(detectDatabase(root), "postgres");
  write({ "config/database.yml": "test:\n  adapter: postgresql\n" });
  assert.equal(detectDatabase(root), "postgres");
  // Both engines declared is ambiguous and requires an explicit choice.
  write({ Gemfile: 'gem "mysql2"\ngem "pg"\n' });
  assert.throws(() => detectDatabase(root), /Specify --database mysql or --database postgres/);
  write({ Gemfile: 'gem "rails"\n' });
  assert.equal(detectDatabase(root), "postgres");
  write({});
  assert.equal(detectDatabase(root), "postgres");
});

// Real-project regressions. Each case is the shape of a file from a maintained
// Rails application that the pre-0.1.8 detector got wrong or, worse, silently
// misread. Detection was unit-tested only against hand-written fixtures, which
// is why all of these looked covered.
test("detection matches real-world database declarations, not incidental tokens", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruby-target-real-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (files) => { fs.rmSync(path.join(root, "Gemfile"), { force: true }); fs.rmSync(path.join(root, "Gemfile.lock"), { force: true }); fs.rmSync(path.join(root, "config"), { recursive: true, force: true }); for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); } };

  // rails/rails activerecord/test/config.example.yml. `mysql2:` and `postgresql:`
  // are YAML keys naming a profile under `connections:`; every adapter actually
  // selected is sqlite3. The old bare-token rule matched the `mysql2:` key while
  // requiring `adapter:` for postgres, so this silently detected MySQL.
  write({ "config/database.yml": 'connections:\n  mysql2:\n    arunit:\n      username: rails\n\n  postgresql:\n    arunit:\n      min_messages: warning\n\ntest:\n  adapter: sqlite3\n  database: ":memory:"\n' });
  assert.equal(detectDatabase(root), "postgres", "a YAML key naming a profile is not a declaration");

  // Discourse: PostgreSQL throughout config/database.yml, with `gem "mysql2"`
  // behind an import-mode conditional in the Gemfile. A gem line only says a
  // driver is available, so it must not make the project ambiguous.
  write({ "config/database.yml": "production:\n  adapter: postgresql\n  host: db\ntest:\n  adapter: postgresql\n", Gemfile: 'gem "rails"\n\nif ENV["IMPORT"] == "1"\n  gem "mysql2"\n  gem "redcarpet"\nend\n' });
  assert.equal(detectDatabase(root), "postgres", "an import-mode gem must not outrank the configured adapter");

  // Redmine: config/database.yml.example declares mysql2 for every environment
  // with postgresql commented out, while its Gemfile conditionally declares
  // both engines. The file the app connects to wins.
  write({ "config/database.yml": "production:\n  adapter: mysql2\n  database: redmine\n#  adapter: postgresql\n#  adapter: sqlite3\n", Gemfile: "adapters.each do |adapter|\n  case adapter.strip\n  when /mysql2/\n    gem 'mysql2', '~> 0.5.0'\n  when /postgresql/\n    gem 'pg', '~> 1.6.2'\n  end\nend\n" });
  assert.equal(detectDatabase(root), "mysql", "the configured adapter outranks conditional gem declarations");

  // Spree: no config/database.yml in the tree, and both drivers declared. Still
  // ambiguous -- the fix must not paper over genuine multi-engine projects.
  write({ Gemfile: 'gem "rails"\ngem "mysql2"\ngem "pg"\n' });
  assert.throws(() => detectDatabase(root), /Specify --database mysql or --database postgres/);

  // Gemfile.lock is a real declaration source: a Rails app with a generated or
  // templated Gemfile still names its driver here.
  write({ "Gemfile.lock": "GEM\n  specs:\n    pg (1.6.2)\n    rails (8.0.0)\n" });
  assert.equal(detectDatabase(root), "postgres");
  write({ "Gemfile.lock": "GEM\n  specs:\n    mysql2 (0.5.6)\n    rails (8.0.0)\n" });
  assert.equal(detectDatabase(root), "mysql");
});
