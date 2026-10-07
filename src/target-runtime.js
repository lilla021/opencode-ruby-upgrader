import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RunStateError, readRun } from "./run-state.js";
import { NAME, databases, detectDatabase, resolveDatabase } from "./databases.js";
import { services as serviceAdapters, detectServices, resolveServices } from "./services.js";

const RUNTIME_FILE = "runtime.json";
const LABEL = "io.opencode-ruby-upgrader.run-id";
const WORKTREE_LABEL = "io.opencode-ruby-upgrader.worktree-sha256";
const rubyVersion = /^\d+\.\d+\.\d+$/;
const NODE_INSTALL = "set -eu; . /etc/os-release; codename=${VERSION_CODENAME:-stretch}; printf '%s\\n' \"deb http://deb.debian.org/debian ${codename} main\" > /etc/apt/sources.list; printf '%s\\n' 'Acquire::Check-Valid-Until \"false\";' > /etc/apt/apt.conf.d/99archive; if ! apt-get update; then printf '%s\\n' \"deb http://archive.debian.org/debian ${codename} main\" > /etc/apt/sources.list; apt-get update; fi; apt-get install -y --no-install-recommends nodejs; if [ ! -x /usr/bin/node ]; then ln -sf /usr/bin/nodejs /usr/local/bin/node; fi; node --version";

function canonicalRoot(root) { return fs.realpathSync(root); }
function worktreeHash(root) { return crypto.createHash("sha256").update(root).digest("hex"); }
// Ownership is asserted against a freshly computed hash of the canonical root
// rather than a hash persisted in runtime.json. The Docker resources carry the
// label, so binding to the live containers is both stronger (a copied manifest
// cannot vouch for a foreign worktree) and keeps a dictionary-attackable
// fingerprint of the user's filesystem path out of a file meant to be committed.
function identity(runId, canonical) { return { runId, worktreeHash: worktreeHash(canonical) }; }
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
function preparationResult(result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { sha256: crypto.createHash("sha256").update(output).digest("hex"), bytes: Buffer.byteLength(output) };
}
function bootstrap(spawn, runtime, db, rails) {
  const labels = ["Node.js setup", "Bundler installation", "dependency installation", ...(rails ? [`${db.label} test database initialization`] : []), "Ruby version attestation", "Bundler version attestation"];
  const commands = [
    ["exec", runtime.appContainer, "sh", "-c", NODE_INSTALL],
    ["exec", runtime.appContainer, "gem", "install", "bundler", "-v", runtime.bundlerToInstall ?? "2.4.22", "--no-document"],
    ["exec", runtime.appContainer, "bundle", `_${runtime.bundlerToInstall ?? "2.4.22"}_`, "install"],
    ...(rails ? [db.createArgs({ appContainer: runtime.appContainer, databaseContainer: runtime.databaseContainer })] : []),
    ["exec", runtime.appContainer, "ruby", "--version"],
    // Attest the Bundler version actually installed, so the report can warn when
    // CI/host bundler differs. `gem install` output is advisory; `--version` is
    // authoritative for what `bundle exec` will actually resolve.
    ["exec", runtime.appContainer, "bundle", `_${runtime.bundlerToInstall ?? "2.4.22"}_`, "--version"]
  ];
  const results = commands.map((args, index) => {
    const result = docker(spawn, args);
    if (result.status !== 0) throw new Error(`Target runtime bootstrap failed during ${labels[index]}. Rerun prepare-target-runtime --ruby <x.y.z>.`);
    return result;
  });
  // Index the attestations explicitly rather than from the end of the array:
  // `ruby --version` is no longer the final command, and an off-by-one here would
  // validate the Bundler banner against the Ruby regex.
  const rubyIndex = 3 + (rails ? 1 : 0);
  const rubyOutput = `${results[rubyIndex].stdout ?? ""}${results[rubyIndex].stderr ?? ""}`;
  if (!new RegExp(`^ruby ${runtime.ruby.replaceAll(".", "\\.")}(?:p\\d+|\\s|$)`).test(rubyOutput.trim())) throw new Error("Target runtime did not execute the requested Ruby version.");
  return {
    node: preparationResult(results[0]),
    bundler: preparationResult(results[1]),
    bundleInstall: preparationResult(results[2]),
    ...(rails ? { databaseCreate: preparationResult(results[3]) } : {}),
    rubyVersion: preparationResult(results[rubyIndex]),
    bundlerVersion: `${results.at(-1).stdout ?? ""}${results.at(-1).stderr ?? ""}`.trim()
  };
}
function railsProject(root) {
  const gemfile = path.join(root, "Gemfile");
  return fs.existsSync(gemfile) && /^\s*gem\s+["']rails["']/m.test(fs.readFileSync(gemfile, "utf8"));
}
function inspect(spawn, name, message) {
  const result = docker(spawn, ["inspect", name]);
  if (result.status !== 0) throw new Error(message);
  return parseInspection(result);
}
function inspectNetwork(spawn, name, message) {
  const result = docker(spawn, ["network", "inspect", name]);
  if (result.status !== 0) throw new Error(message);
  return parseInspection(result);
}
function parseInspection(result) {
  try { const parsed = JSON.parse(result.stdout); return parsed[0]; } catch { throw new Error("Docker inspection returned invalid JSON."); }
}
function environment(container) {
  return Object.fromEntries((container?.Config?.Env ?? []).map((entry) => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }));
}
function labels(resource) { return resource?.Config?.Labels ?? resource?.Labels ?? {}; }
function hasOwnership(resource, identity) {
  const owned = labels(resource);
  return owned[LABEL] === identity.runId && owned[WORKTREE_LABEL] === identity.worktreeHash;
}
function mountedFromRoot(container, root) {
  return container?.Mounts?.some((mount) => mount.Type === "bind" && mount.Source === root && mount.Destination === "/app");
}
function onlyNetwork(container, network) {
  const networks = Object.keys(container?.NetworkSettings?.Networks ?? {});
  return networks.length === 1 && networks[0] === network;
}
function isolatedContainer(container) {
  return container?.HostConfig?.Privileged !== true && Object.keys(container?.HostConfig?.PortBindings ?? {}).length === 0;
}
function appMatches(container, root, runtime, db) {
  const env = environment(container);
  const mounts = container?.Mounts ?? [];
  const command = container?.Config?.Cmd ?? [];
    const servicesMatch = !runtime.services || runtime.services.every((svc) => {
    const expected = serviceAdapters[svc.type]?.env?.({ container: svc.container }) || {};
    return Object.entries(expected).every(([k, v]) => env[k] === v);
  });
  return container?.State?.Running && container?.Config?.Image === `ruby:${runtime.ruby}` && container?.Config?.WorkingDir === "/app" && mounts.length === 1 && mountedFromRoot(container, root) && command.length === 2 && command[0] === "sleep" && command[1] === "infinity" && onlyNetwork(container, runtime.network) && isolatedContainer(container) && env.RAILS_ENV === "test" && env.DATABASE_URL === db.databaseUrl(runtime.databaseContainer) && servicesMatch;
}
function databaseMatches(container, runtime, db) {
  const env = environment(container);
  const expectedEnvironment = Object.entries(db.requiredEnvironment).every(([key, value]) => env[key] === value);
  const hasBindMount = (container?.Mounts ?? []).some((mount) => mount.Type === "bind");
  return container?.State?.Running && container?.Config?.Image === db.image && onlyNetwork(container, runtime.network) && isolatedContainer(container) && !hasBindMount && expectedEnvironment;
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
function names(runId, db, serviceList = []) {
  const prefix = `ruby-upgrader-${runId}`;
  const out = { appContainer: `${prefix}-app`, databaseContainer: `${prefix}-${db.adapter}`, network: `${prefix}-network` };
  for (const svc of serviceList) {
    out[`${svc.type}Container`] = `${prefix}-${svc.type}`;
  }
  return out;
}
function writeRuntime(root, runtime) {
  const file = runtimePath(root, true);
  const temporary = path.join(path.dirname(file), `.${RUNTIME_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

export function readTargetRuntime(root = process.cwd()) {
  const canonical = canonicalRoot(root);
  const file = runtimePath(canonical);
  if (!fs.existsSync(file)) return undefined;
  try {
    let runtime = JSON.parse(fs.readFileSync(file, "utf8"));
    if (runtime?.version === 2 && runtime.database === undefined && runtime.databaseContainer === undefined && NAME.test(runtime.postgresContainer ?? "")) {
      const { postgresContainer, ...legacy } = runtime;
      runtime = { ...legacy, database: "postgres", databaseContainer: postgresContainer };
    }
    if (runtime?.version !== 2 || typeof runtime.runId !== "string" || !rubyVersion.test(runtime.ruby ?? "") || !/^sha256:[a-f0-9]{64}$/i.test(runtime.resolvedImageId ?? "") || (runtime.databaseImageId !== undefined && !/^sha256:[a-f0-9]{64}$/i.test(runtime.databaseImageId)) || !runtime.preparation || !Object.hasOwn(databases, runtime.database) || ![runtime.appContainer, runtime.databaseContainer, runtime.network].every((name) => NAME.test(name ?? ""))) throw new Error();
    if (runtime.services && !Array.isArray(runtime.services)) throw new Error();
    return runtime;
  } catch { throw new Error("Target runtime metadata is invalid. Rerun prepare-target-runtime --ruby <x.y.z>."); }
}

export function prepareTargetRuntime({ root = process.cwd(), reportPath, ruby, database, bundler, spawn = spawnSync }) {
  if (!rubyVersion.test(ruby ?? "")) throw new Error("--ruby must be an exact numeric Ruby version such as 3.4.1.");
  const canonical = canonicalRoot(root);
  const db = resolveDatabase(database ?? detectDatabase(canonical));
  const detectedServices = detectServices(canonical);
  const serviceList = resolveServices(detectedServices);
  const selected = selectedRun(canonical, reportPath);
  const run = readRun(canonical, selected.reportPath);
  let bundlerToInstall = bundler || (run.reportType === "bundler_bridge" ? run.targetBundler : (run.bundlerBridge ? run.bundlerBridge.bundlerTo : undefined)) || "2.4.22";
  const runtimeNames = names(selected.run.runId, db, serviceList);
  const runtime = { version: 2, runId: selected.run.runId, reportPath: selected.reportPath, ruby, database: db.adapter, bundlerToInstall, services: [], ...runtimeNames };
  const owner = identity(runtime.runId, canonical);
  const existing = readTargetRuntime(canonical);
  let forceRecreateApp = false;
  if (existing && existing.runId !== runtime.runId) {
    const prior = readRun(canonical, existing.reportPath);
    if (!["blocked", "complete"].includes(prior.status)) throw new Error("Target runtime metadata belongs to another resumable run. Pause and resolve that run before preparing this one.");
  } else if (existing && bundler && bundlerVersion.test(bundler) && existing.bundlerToInstall !== bundler) {
    forceRecreateApp = true;
  }

  const databaseNames = [...new Set([...Object.values(databases).map((candidate) => names(runtime.runId, candidate).databaseContainer), existing?.databaseContainer].filter(Boolean))];
  let app = docker(spawn, ["inspect", runtime.appContainer]);
  if (forceRecreateApp && app.status === 0) {
    if (docker(spawn, ["rm", "--force", runtime.appContainer]).status !== 0) throw new Error("Could not replace the prior target Ruby app container.");
    app = { status: 1 };
  }
  let network = docker(spawn, ["network", "inspect", runtime.network]);
  const databaseInspections = new Map(databaseNames.map((name) => [name, docker(spawn, ["inspect", name])]));
  const serviceNames = serviceList.map((svc) => runtimeNames[`${svc.type}Container`]).filter(Boolean);
  const serviceInspections = new Map(serviceNames.map((name) => [name, docker(spawn, ["inspect", name])]));
  const resources = [app.status === 0 && parseInspection(app), network.status === 0 && parseInspection(network), ...[...databaseInspections.values()].filter((result) => result.status === 0).map(parseInspection), ...[...serviceInspections.values()].filter((result) => result.status === 0).map(parseInspection)].filter(Boolean);
for (const resource of resources) {
    const resourceLabels = labels(resource);
    if (resourceLabels[LABEL] !== owner.runId || (resourceLabels[WORKTREE_LABEL] !== undefined && resourceLabels[WORKTREE_LABEL] !== owner.worktreeHash)) throw new Error("Refusing to use or replace a Docker resource not owned by this run and worktree.");
  }
  const legacy = resources.some((resource) => labels(resource)[WORKTREE_LABEL] === undefined);
  if (legacy && resources.length) {
    if (app.status !== 0 || !mountedFromRoot(parseInspection(app), canonical)) throw new Error("Refusing to migrate legacy Docker resources because ownership by this worktree cannot be established.");
    for (const [name, result] of [[runtime.appContainer, app], ...databaseInspections, ...serviceInspections]) {
      if (result.status === 0 && docker(spawn, ["rm", "--force", name]).status !== 0) throw new Error("Could not remove a legacy target-runtime container.");
    }
    if (network.status !== 0 && docker(spawn, ["network", "rm", runtime.network]).status !== 0) throw new Error("Could not remove the legacy target-runtime Docker network.");
    app = { status: 1 };
    network = { status: 1 };
    for (const name of databaseNames) databaseInspections.set(name, { status: 1 });
  } else {
    for (const resource of resources) {
      if (!hasOwnership(resource, owner)) throw new Error("Refusing to use or replace a Docker resource without both ownership labels.");
    }
  }
  const ownershipArgs = ["--label", `${LABEL}=${owner.runId}`, "--label", `${WORKTREE_LABEL}=${owner.worktreeHash}`];
  if (network.status !== 0 && docker(spawn, ["network", "create", ...ownershipArgs, runtime.network]).status !== 0) throw new Error("Could not create the isolated target-runtime Docker network.");
  for (const [name, result] of databaseInspections) {
    if (name !== runtime.databaseContainer && result.status === 0 && docker(spawn, ["rm", "--force", name]).status !== 0) throw new Error("Could not remove the prior target-runtime database container.");
  }
  let databaseContainer = databaseInspections.get(runtime.databaseContainer) ?? { status: 1 };
  if (databaseContainer.status === 0) {
    const container = parseInspection(databaseContainer);
    if (!databaseMatches(container, runtime, db)) {
      if (docker(spawn, ["rm", "--force", runtime.databaseContainer]).status !== 0) throw new Error(`Could not replace the prior target-runtime ${db.label} container.`);
      databaseContainer = docker(spawn, ["inspect", runtime.databaseContainer]);
    }
  }
  if (databaseContainer.status !== 0 && docker(spawn, ["run", "--detach", "--name", runtime.databaseContainer, ...ownershipArgs, "--network", runtime.network, ...db.startArgs()]).status !== 0) throw new Error(`Could not start the isolated target-runtime ${db.label} container.`);
  try {
    db.ensureReady({ probe: () => docker(spawn, db.readyArgs(runtime.databaseContainer)) });
  } catch (error) {
    try { docker(spawn, ["rm", "--force", runtime.databaseContainer]); } catch {}
    throw error;
  }
  // Provision additional service containers (evidence-based)
  const serviceStates = [];
  for (const svc of serviceList) {
    const svcContainer = runtimeNames[`${svc.type}Container`];
    let svcResult = serviceInspections.get(svcContainer) ?? { status: 1 };
    if (svcResult.status === 0) {
      const c = parseInspection(svcResult);
      const expectedEnv = (serviceAdapters[svc.type]?.env?.({ container: svcContainer }) || {});
      const env = environment(c);
      const hasBindMount = (c?.Mounts ?? []).some((mount) => mount.Type === "bind");
      const owned = hasOwnership(c, owner);
      const matches = c?.State?.Running && c?.Config?.Image === svc.adapter.image && onlyNetwork(c, runtime.network) && isolatedContainer(c) && !hasBindMount && owned && Object.entries(expectedEnv).every(([k, v]) => env[k] === v);
      if (!matches) {
        if (docker(spawn, ["rm", "--force", svcContainer]).status !== 0) throw new Error(`Could not replace the prior target-runtime ${svc.adapter.label} container.`);
        svcResult = docker(spawn, ["inspect", svcContainer]);
      }
    }
    if (svcResult.status !== 0) {
      if (docker(spawn, ["run", "--detach", "--name", svcContainer, ...ownershipArgs, "--network", runtime.network, ...svc.adapter.startArgs()]).status !== 0) throw new Error(`Could not start the isolated target-runtime ${svc.adapter.label} container.`);
    }
    try {
      svc.adapter.ensureReady({ probe: () => docker(spawn, svc.adapter.readyArgs(svcContainer)) });
    } catch (error) {
      try { docker(spawn, ["rm", "--force", svcContainer]); } catch {}
      throw error;
    }
    const svcInspection = inspect(spawn, svcContainer, `Target ${svc.adapter.label} container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.`);
    if (!/^sha256:[a-f0-9]{64}$/i.test(svcInspection?.Image ?? "")) throw new Error(`Target ${svc.adapter.label} image ID is unavailable.`);
    serviceStates.push({ type: svc.type, container: svcContainer, imageId: svcInspection.Image });
    runtime.services = serviceStates;
  }
  if (app.status === 0) {
    const container = parseInspection(app);
    if (!appMatches(container, canonical, runtime, db)) {
      if (docker(spawn, ["rm", "--force", runtime.appContainer]).status !== 0) throw new Error("Could not replace the prior target Ruby app container.");
      app = docker(spawn, ["inspect", runtime.appContainer]);
    }
  }
  const appEnv = ["--env", "RAILS_ENV=test", "--env", `DATABASE_URL=${db.databaseUrl(runtime.databaseContainer)}`];
  for (const svc of serviceList) {
    const svcContainer = runtimeNames[`${svc.type}Container`];
    const envs = serviceAdapters[svc.type]?.env?.({ container: svcContainer }) || {};
    for (const [k, v] of Object.entries(envs)) appEnv.push("--env", `${k}=${v}`);
  }
  if (app.status !== 0 && docker(spawn, ["run", "--detach", "--name", runtime.appContainer, ...ownershipArgs, "--network", runtime.network, "--mount", `type=bind,src=${canonical},dst=/app`, "--workdir", "/app", ...appEnv, `ruby:${ruby}`, "sleep", "infinity"]).status !== 0) throw new Error("Could not start the target Ruby app container.");
  const prepared = bootstrap(spawn, runtime, db, railsProject(canonical));
  const appInspection = inspect(spawn, runtime.appContainer, "Target Ruby app container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.");
  const databaseInspection = inspect(spawn, runtime.databaseContainer, `Target ${db.label} container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(appInspection?.Image ?? "")) throw new Error("Target Ruby image ID is unavailable.");
  if (!/^sha256:[a-f0-9]{64}$/i.test(databaseInspection?.Image ?? "")) throw new Error(`Target ${db.label} image ID is unavailable.`);
  runtime.resolvedImageId = appInspection.Image;
  runtime.databaseImageId = databaseInspection.Image;
  runtime.preparation = prepared;
  validateTargetRuntime({ root: canonical, runtime, spawn });
  writeRuntime(canonical, runtime);
  return runtime;
}

export function validateTargetRuntime({ root = process.cwd(), runtime = readTargetRuntime(root), spawn = spawnSync }) {
  if (!runtime) return undefined;
  const canonical = canonicalRoot(root);
  const owner = identity(runtime.runId, canonical);
  const db = resolveDatabase(runtime.database);
  const app = inspect(spawn, runtime.appContainer, "Target Ruby app container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.");
  const database = inspect(spawn, runtime.databaseContainer, `Target ${db.label} container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.`);
  const network = inspectNetwork(spawn, runtime.network, "Target runtime Docker network is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.");
  const env = environment(app);
  const connectedIds = Object.keys(network?.Containers ?? {}).sort();
  const serviceContainers = [];
  const runtimeServices = runtime.services || [];
  for (const svc of runtimeServices) {
    try {
      const sc = inspect(spawn, svc.container, "Target service container is unavailable. Rerun prepare-target-runtime --ruby <x.y.z>.");
      serviceContainers.push(sc);
    } catch (e) {
      throw e;
    }
  }
  const expectedIds = [app?.Id, database?.Id, ...serviceContainers.map((c) => c.Id)].filter(Boolean).sort();
  const valid = appMatches(app, canonical, runtime, db) && databaseMatches(database, runtime, db) &&
    hasOwnership(network, owner) && hasOwnership(app, owner) && hasOwnership(database, owner) &&
    serviceContainers.every((c) => hasOwnership(c, owner)) &&
    connectedIds.length === expectedIds.length && connectedIds.every((id, index) => id === expectedIds[index]) &&
    app?.Image === runtime.resolvedImageId && (!runtime.databaseImageId || database?.Image === runtime.databaseImageId) &&
    env.RAILS_ENV === "test" && env.DATABASE_URL === db.databaseUrl(runtime.databaseContainer);
  if (!valid) throw new Error("Target runtime no longer matches its prepared run. Rerun prepare-target-runtime --ruby <x.y.z>.");
  // bundlerVersion is surfaced so the generated report can warn that the deploy
  // host and CI may resolve a different Bundler than this container pinned. It
  // comes from `bundle --version` in the prepared container, not from the
  // bootstrap log, so it reflects what `bundle exec` actually resolved.
  const bundlerVersion = /Bundler version (\d+(?:\.\d+)+)/.exec(runtime.preparation?.bundlerVersion ?? "")?.[1] ?? undefined;
  return { runId: runtime.runId, reportPath: runtime.reportPath, name: runtime.appContainer, id: app.Id, imageId: app.Image, imageRef: app.Config.Image, ruby: runtime.ruby, ...(bundlerVersion ? { bundlerVersion } : {}), database: runtime.database, databaseContainer: runtime.databaseContainer, databaseContainerId: database.Id, databaseImageId: database.Image, databaseImageRef: database.Config.Image, network: runtime.network, networkId: network.Id };
}
