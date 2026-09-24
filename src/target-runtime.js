import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RunStateError, readRun } from "./run-state.js";

const RUNTIME_FILE = "runtime.json";
const LABEL = "io.opencode-ruby-upgrader.run-id";
const rubyVersion = /^\d+\.\d+\.\d+$/;
const NODE_INSTALL = "set -eu; . /etc/os-release; codename=${VERSION_CODENAME:-stretch}; printf '%s\\n' \"deb http://deb.debian.org/debian ${codename} main\" > /etc/apt/sources.list; printf '%s\\n' 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99archive; if ! apt-get update; then printf '%s\\n' \"deb http://archive.debian.org/debian ${codename} main\" > /etc/apt/sources.list; apt-get update; fi; apt-get install -y --no-install-recommends nodejs; if [ ! -x /usr/bin/node ]; then ln -sf /usr/bin/nodejs /usr/local/bin/node; fi; node --version";

function canonicalRoot(root) { return fs.realpathSync(root); }
function upgradesDirectory(root, create = false) {
  const directory = path.join(canonicalRoot(root), ".ruby-upgrades");
  if (!fs.existsSync(directory) && create) fs.mkdirSync(directory, { mode: 0o700 });
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(".ruby-upgrades must be a real directory inside the worktree.");
  }
  return directory;
}
function runtimePath(root, create = false) {
  const file = path.join(upgradesDirectory(root, create), RUNTIME_FILE);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Target runtime metadata must be a regular file.");
  }
  return file;
}
function docker(spawn, args) {
  const result = spawn("docker", args, { shell: false, encoding: "utf8", maxBuffer: 256 * 1024 });
  if (result.error) throw new Error(`Docker command failed: ${result.error.message}`);
  return result;
}
function waitForPostgres(spawn, runtime) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (docker(spawn, ["exec", runtime.postgresContainer, "pg_isready", "-U", "postgres", "-d", "ruby_upgrade_test"]).status === 0) return;
    Atomics.wait(sleeper, 0, 0, 1000);
  }
  throw new Error("Target PostgreSQL did not become ready within 30 seconds. Rerun prepare-target-runtime --ruby <x.y.z>.");
}
function preparationResult(result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { sha256: crypto.createHash("sha256").update(output).digest("hex"), bytes: Buffer.byteLength(output) };
}
function bootstrap(spawn, runtime, rails) {
  const labels = ["Node.js setup", "Bundler installation", "dependency installation", ...(rails ? ["Rails test database initialization"] : []), "Ruby version attestation"];
  const commands = [
    ["exec", runtime.appContainer, "sh", "-c", NODE_INSTALL],
    ["exec", runtime.appContainer, "gem", "install", "bundler", "-v", "2.4.22", "--no-document"],
    ["exec", runtime.appContainer, "bundle", "_2.4.22_", "install"],
    ...(rails ? [["exec", runtime.appContainer, "bundle", "exec", "rake", "db:create"]] : []),
    ["exec", runtime.appContainer, "ruby", "--version"]
  ];
  const results = commands.map((args, index) => {
    const result = docker(spawn, args);
    if (result.status !== 0) throw new Error(`Target runtime bootstrap failed during ${labels[index]}. Rerun prepare-target-runtime --ruby <x.y.z>.`);
    return result;
  });
  const rubyOutput = `${results.at(-1).stdout ?? ""}${results.at(-1).stderr ?? ""}`;
  if (!new RegExp(`^ruby ${runtime.ruby.replaceAll(".", "\\.")}(?:p\\d+|\\s|$)`).test(rubyOutput.trim())) throw new Error("Target runtime did not execute the requested Ruby version.");
  return {
    node: preparationResult(results[0]),
    bundler: preparationResult(results[1]),
    bundleInstall: preparationResult(results[2]),
    ...(rails ? { databaseCreate: preparationResult(results[3]) } : {}),
    rubyVersion: preparationResult(results.at(-1))
  };
}
function railsProject(root) {
  const gemfile = path.join(root, "Gemfile");
  return fs.existsSync(gemfile) && /^\s*gem\s+["']rails["']/m.test(fs.readFileSync(gemfile, "utf8"));
}
function inspect(spawn, name, message) {
  const result = docker(spawn, ["inspect", name]);
  if (result.status !== 0) throw new Error(message);
  try { const parsed = JSON.parse(result.stdout); return parsed[0]; } catch { throw new Error("Docker inspection returned invalid JSON."); }
}
function activeRun(root) {
  const directory = path.join(upgradesDirectory(root), "runs");
  if (!fs.existsSync(directory)) throw new RunStateError("No active or paused upgrade run exists. Start or resume a run first.", "no-active-run");
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(entry.name))
    .map((entry) => `.ruby-upgrades/runs/${entry.name}`)
    .map((reportPath) => ({ reportPath, run: readRun(root, reportPath) }))
    .filter(({ run }) => ["in_progress", "paused"].includes(run.status));
  if (candidates.length !== 1) throw new RunStateError(candidates.length ? "Multiple active or paused upgrade runs exist. Resolve them before preparing a target runtime." : "No active or paused upgrade run exists. Start or resume a run first.", candidates.length ? "ambiguous-active-run" : "no-active-run");
  return candidates[0];
}
function selectedRun(root, reportPath) {
  if (!reportPath) return activeRun(root);
  const run = readRun(root, reportPath);
  if (!["in_progress", "paused"].includes(run.status)) throw new RunStateError("Target runtime preparation requires an active or paused upgrade run.", "run-not-resumable");
  return { reportPath, run };
}
function names(runId) {
  const prefix = `ruby-upgrader-${runId}`;
  return { appContainer: `${prefix}-app`, postgresContainer: `${prefix}-postgres`, network: `${prefix}-network` };
}
function writeRuntime(root, runtime) {
  const file = runtimePath(root, true);
  const temporary = path.join(path.dirname(file), `.${RUNTIME_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

export function readTargetRuntime(root = process.cwd()) {
  const file = runtimePath(root);
  if (!fs.existsSync(file)) return undefined;
  try {
    const runtime = JSON.parse(fs.readFileSync(file, "utf8"));
    if (runtime?.version !== 2 || typeof runtime.runId !== "string" || !rubyVersion.test(runtime.ruby ?? "") || !/^sha256:[a-f0-9]{64}$/i.test(runtime.resolvedImageId ?? "") || !runtime.preparation || ![runtime.appContainer, runtime.postgresContainer, runtime.network].every((name) => /^[a-z0-9][a-z0-9-]{0,127}$/.test(name ?? ""))) throw new Error();
    return runtime;
  } catch { throw new Error("Target runtime metadata is invalid. Rerun prepare-target-runtime --ruby <x.y.z>."); }
}

export function prepareTargetRuntime({ root = process.cwd(), reportPath, ruby, spawn = spawnSync }) {
  if (!rubyVersion.test(ruby ?? "")) throw new Error("--ruby must be an exact numeric Ruby version such as 3.4.1.");
  const canonical = canonicalRoot(root);
  const selected = selectedRun(canonical, reportPath);
  const runtime = { version: 2, runId: selected.run.runId, reportPath: selected.reportPath, ruby, ...names(selected.run.runId) };
  const existing = readTargetRuntime(canonical);
  if (existing && existing.runId !== runtime.runId) {
    const prior = readRun(canonical, existing.reportPath);
    if (!["blocked", "complete"].includes(prior.status)) throw new Error("Target runtime metadata belongs to another resumable run. Pause and resolve that run before preparing this one.");
  }

  const network = docker(spawn, ["network", "inspect", runtime.network]);
  if (network.status !== 0 && docker(spawn, ["network", "create", "--label", `${LABEL}=${selected.run.runId}`, runtime.network]).status !== 0) throw new Error("Could not create the isolated target-runtime Docker network.");
  const postgres = docker(spawn, ["inspect", runtime.postgresContainer]);
  if (postgres.status !== 0 && docker(spawn, ["run", "--detach", "--name", runtime.postgresContainer, "--label", `${LABEL}=${selected.run.runId}`, "--network", runtime.network, "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=ruby_upgrade_test", "postgres:16-alpine"]).status !== 0) throw new Error("Could not start the isolated target-runtime PostgreSQL container.");
  waitForPostgres(spawn, runtime);
  let app = docker(spawn, ["inspect", runtime.appContainer]);
  if (app.status === 0 && existing && existing.ruby !== ruby) {
    let container;
    try { [container] = JSON.parse(app.stdout); } catch { throw new Error("Docker validation container inspection returned invalid JSON."); }
    if (container?.Config?.Labels?.[LABEL] !== selected.run.runId) throw new Error("Refusing to replace an app container not labelled for this run.");
    if (docker(spawn, ["rm", "--force", runtime.appContainer]).status !== 0) throw new Error("Could not replace the prior target Ruby app container.");
    app = docker(spawn, ["inspect", runtime.appContainer]);
  }
  if (app.status !== 0 && docker(spawn, ["run", "--detach", "--name", runtime.appContainer, "--label", `${LABEL}=${selected.run.runId}`, "--network", runtime.network, "--mount", `type=bind,src=${canonical},dst=/app`, "--workdir", "/app", "--env", "RAILS_ENV=test", "--env", `DATABASE_URL=postgresql://postgres@${runtime.postgresContainer}:5432/ruby_upgrade_test`, `ruby:${ruby}`, "sleep", "infinity"]).status !== 0) throw new Error("Could not start the target Ruby app container.");
  const prepared = bootstrap(spawn, runtime, railsProject(canonical));
  const appInspection = inspect(spawn, runtime.appContainer, "Target Ruby app container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.");
  if (!/^sha256:[a-f0-9]{64}$/i.test(appInspection?.Image ?? "")) throw new Error("Target Ruby image ID is unavailable.");
  runtime.resolvedImageId = appInspection.Image;
  runtime.preparation = prepared;
  validateTargetRuntime({ root: canonical, runtime, spawn });
  writeRuntime(canonical, runtime);
  return runtime;
}

export function validateTargetRuntime({ root = process.cwd(), runtime = readTargetRuntime(root), spawn = spawnSync }) {
  if (!runtime) return undefined;
  const canonical = canonicalRoot(root);
  const app = inspect(spawn, runtime.appContainer, "Target Ruby app container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.");
  const postgres = inspect(spawn, runtime.postgresContainer, "Target PostgreSQL container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.");
  const env = Object.fromEntries((app?.Config?.Env ?? []).map((entry) => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }));
  const mountedRoot = app?.Mounts?.some((mount) => mount.Type === "bind" && mount.Source === canonical && mount.Destination === "/app");
  const appNetwork = app?.NetworkSettings?.Networks?.[runtime.network];
  const postgresNetwork = postgres?.NetworkSettings?.Networks?.[runtime.network];
  const valid = app?.State?.Running && postgres?.State?.Running && app?.Config?.Labels?.[LABEL] === runtime.runId && postgres?.Config?.Labels?.[LABEL] === runtime.runId && app?.Config?.Image === `ruby:${runtime.ruby}` && app?.Image === runtime.resolvedImageId && app?.Config?.WorkingDir === "/app" && mountedRoot && appNetwork && postgresNetwork && env.RAILS_ENV === "test" && env.DATABASE_URL === `postgresql://postgres@${runtime.postgresContainer}:5432/ruby_upgrade_test`;
  if (!valid) throw new Error("Target runtime no longer matches its prepared run. Rerun prepare-target-runtime --ruby <x.y.z>.");
  return { name: runtime.appContainer, id: app.Id, imageId: app.Image, imageRef: app.Config.Image, ruby: runtime.ruby };
}
