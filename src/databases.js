// Adapter-encapsulated database lifecycle for the isolated target runtime.
//
// Each adapter owns its container name suffix, image, health probe, test-database
// creation command, and DATABASE_URL format. target-runtime.js stays
// adapter-agnostic: it only reads `.image`, `.label`, `.port` and calls
// `.readyArgs` / `.createArgs` / `.databaseUrl`.
//
// Every step runs either inside the isolated database container or through the
// verified `docker exec` path, so the app image is never modified to support a
// database engine. The app reaches the database only over the per-run,
// run-id-labelled Docker network.

import fs from "node:fs";
import path from "node:path";

const DB_NAME = "ruby_upgrade_test";
const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

function waitSecond() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); }

// `probe` returns a docker result; a zero status means the database is serving
// the kind of traffic the app will generate.
function readyLoop({ probe, attempts, label }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (probe().status === 0) return;
    waitSecond();
  }
  throw new Error(`Target ${label} did not become ready within ${attempts} seconds. Rerun prepare-target-runtime --ruby <x.y.z>.`);
}

export const databases = Object.freeze({
  postgres: Object.freeze({
    adapter: "postgres",
    label: "PostgreSQL",
    image: "postgres:16-alpine",
    port: 5432,
    requiredEnvironment: Object.freeze({ POSTGRES_HOST_AUTH_METHOD: "trust", POSTGRES_DB: DB_NAME }),
    // `trust` keeps the isolated test database credential-free and unreachable
    // from outside the per-run network.
    startArgs: () => ["--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", `POSTGRES_DB=${DB_NAME}`, "postgres:16-alpine"],
    readyArgs: (container) => ["exec", container, "pg_isready", "-U", "postgres", "-d", DB_NAME],
    // Use the app's own Rails task so framework-specific database setup remains
    // consistent with the project's PostgreSQL adapter. DATABASE_URL is already
    // set on the app container and Rails prefers it over database.yml, so a
    // project pinning `host: localhost` or a socket-only DSN still resolves to
    // the isolated container -- no rewriting of the config under test, which
    // would be a source change to the worktree.
    createArgs: ({ appContainer }) => ["exec", appContainer, "bundle", "exec", "rake", "db:create"],
    databaseUrl: (container) => `postgresql://postgres@${container}:5432/${DB_NAME}`,
    ensureReady: ({ probe }) => readyLoop({ probe, attempts: 30, label: "PostgreSQL" })
  }),
  mysql: Object.freeze({
    adapter: "mysql",
    label: "MySQL",
    image: "mysql:8.4",
    port: 3306,
    requiredEnvironment: Object.freeze({ MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: DB_NAME }),
    // An empty root password keeps the isolated test database credential-free.
    // The official entrypoint also provisions TCP access for that account.
    startArgs: () => ["--env", "MYSQL_ALLOW_EMPTY_PASSWORD=yes", "--env", `MYSQL_DATABASE=${DB_NAME}`, "mysql:8.4"],
    // Probe over TCP, not the unix socket. The entrypoint briefly runs a
    // socket-only bootstrap server: `mysqladmin ping` and a local `SELECT 1`
    // both succeed against it several seconds before the app could actually
    // connect, which would surface later as a misleading connection failure.
    readyArgs: (container) => ["exec", container, "mysqladmin", "ping", "-h", "127.0.0.1", "-u", "root", "--silent"],
    // Created server-side with the container's own client so preparation never
    // depends on the mysql2 native extension being built yet.
    createArgs: ({ databaseContainer }) => ["exec", databaseContainer, "mysql", "-h", "127.0.0.1", "-u", "root", "-e", `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4`],
    databaseUrl: (container) => `mysql2://root@${container}:3306/${DB_NAME}`,
    // First boot initializes the data directory, restarts the server to apply
    // settings, then opens TCP; budget well beyond PostgreSQL's startup.
    ensureReady: ({ probe }) => readyLoop({ probe, attempts: 90, label: "MySQL" })
  })
});

export function resolveDatabase(adapter) {
  const key = adapter ?? "postgres";
  if (!Object.hasOwn(databases, key)) throw new Error(`--database must be one of: ${Object.keys(databases).join(", ")}.`);
  return databases[key];
}

// Declarative forms only. A bare word is not a declaration: real
// `config/database.yml` files carry YAML keys that merely *name* a profile
// (rails/rails ships `connections:` with `mysql2:` and `postgresql:` keys and
// only `adapter: sqlite3` in play), and a Gemfile may carry a driver for an
// unrelated tool. Matching bare tokens made detection asymmetric -- mysql2
// matched anywhere while postgres required `adapter:` -- so the bias could only
// ever produce a false MySQL answer, silently.
const MYSQL = [/\badapter\s*:\s*mysql2\b/i, /\bgem\s*\(?\s*["']mysql2["']/i, /\bmysql2:\/\//i];
const POSTGRES = [/\badapter\s*:\s*(?:postgresql|postgres)\b/i, /\bgem\s*\(?\s*["']pg["']/i, /\b(?:postgresql|postgres):\/\//i];
// Gemfile.lock records resolved specs as `    mysql2 (0.5.6)` / `    pg (1.6.2)`.
const MYSQL_LOCK = /^[ \t]*mysql2 \(/m;
const POSTGRES_LOCK = /^[ \t]*pg \(/m;

// Best-effort adapter detection from the project's own declarations. An
// explicit `--database` always wins; this only fills the gap so the common case
// needs no flag.
export function detectDatabase(root = process.cwd()) {
  const read = (file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
  const uncommented = (contents) => contents.replace(/#.*$/gm, "");
  const declares = (contents, lock) => ({
    mysql: MYSQL.some((re) => re.test(contents)) || (lock && MYSQL_LOCK.test(contents)),
    postgres: POSTGRES.some((re) => re.test(contents)) || (lock && POSTGRES_LOCK.test(contents)),
  });
  const resolve = ({ mysql, postgres }) => {
    if (mysql && postgres) throw new Error("Both MySQL and PostgreSQL were detected. Specify --database mysql or --database postgres.");
    return mysql ? "mysql" : postgres ? "postgres" : null;
  };
  // `config/database.yml` is what the app actually connects to; a `gem` line
  // only says a driver is *available*. Discourse, for instance, is PostgreSQL
  // (`adapter: postgresql` throughout) but carries `gem "mysql2"` behind an
  // import-mode conditional. OR-ing both files reported that as ambiguous and
  // needlessly forced an explicit flag on an unambiguous project.
  const configured = resolve(declares(uncommented(read("config/database.yml")), false));
  if (configured) return configured;
  const gems = resolve(declares(`${uncommented(read("Gemfile"))}\n${uncommented(read("Gemfile.lock"))}`, true));
  return gems ?? "postgres";
}

export { DB_NAME, NAME };
