// Service adapters for isolated target runtime.
//
// Each adapter defines container lifecycle (image, start args, readiness probe)
// and the environment variables the app container needs to reach the service
// over the per-run private Docker network. Only allowlisted adapter images are
// permitted; no user-supplied images or environment values.

import fs from "node:fs";
import path from "node:path";

const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

function waitSecond() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); }

function readyLoop({ probe, attempts, label }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (probe().status === 0) return;
    waitSecond();
  }
  throw new Error(`Target ${label} did not become ready within ${attempts} seconds. Rerun prepare-target-runtime --ruby <x.y.z>.`);
}

export const services = Object.freeze({
  redis: Object.freeze({
    type: "redis",
    label: "Redis",
    image: "redis:7-alpine",
    port: 6379,
    // Start Redis in the foreground with default config; no authentication in
    // the isolated test network.
    startArgs: () => ["redis:7-alpine", "redis-server", "--appendonly", "no"],
    // Probe readiness with redis-cli against localhost.
    readyArgs: (container) => ["exec", container, "redis-cli", "ping"],
    // Expose REDIS_URL so the app reaches Redis over the private network by
    // container name. Use DB 0 for test isolation by convention.
    env: ({ container }) => ({ REDIS_URL: `redis://${container}:6379/0` }),
    ensureReady: ({ probe }) => readyLoop({ probe, attempts: 30, label: "Redis" })
  }),
  chrome: Object.freeze({
    type: "chrome",
    label: "Chrome",
    image: "selenium/standalone-chrome:latest",
    port: 4444,
    startArgs: () => ["--shm-size=2g", "selenium/standalone-chrome:latest"],
    readyArgs: (container) => ["exec", container, "curl", "-s", "--fail", "http://localhost:4444/wd/hub/status"],
    env: ({ container }) => ({
      SELENIUM_URL: `http://${container}:4444/wd/hub`,
      CHROME_REMOTE_URL: `http://${container}:4444`,
      CAPYBARA_SERVER_HOST: "0.0.0.0"
    }),
    ensureReady: ({ probe }) => readyLoop({ probe, attempts: 120, label: "Chrome" })
  }),
  selenium: Object.freeze({
    type: "selenium",
    label: "Selenium",
    image: "selenium/standalone-chrome:latest",
    port: 4444,
    startArgs: () => ["--shm-size=2g", "selenium/standalone-chrome:latest"],
    readyArgs: (container) => ["exec", container, "curl", "-s", "--fail", "http://localhost:4444/wd/hub/status"],
    env: ({ container }) => ({
      SELENIUM_URL: `http://${container}:4444/wd/hub`,
      CHROME_REMOTE_URL: `http://${container}:4444`,
      CAPYBARA_SERVER_HOST: "0.0.0.0"
    }),
    ensureReady: ({ probe }) => readyLoop({ probe, attempts: 120, label: "Selenium" })
  })
});

export function resolveService(type) {
  if (!type || !Object.hasOwn(services, type)) return undefined;
  return services[type];
}

export function resolveServices(types = []) {
  const result = [];
  const seen = new Set();
  for (const type of types) {
    if (seen.has(type)) continue;
    const svc = resolveService(type);
    if (svc) { result.push({ type, adapter: svc }); seen.add(type); }
  }
  return result;
}

const REDIS_EVIDENCE = [
  /\bgem\s*\(?\s*["']redis["']/i,
  /\bgem\s*\(?\s*["']sidekiq["']/i,
  /\bgem\s*\(?\s*["']resque["']/i,
  /\bgem\s*\(?\s*["']redis-rails["']/i,
  /\bredis\.yml\b/i,
  /\bRedis\.new\b/i,
  /\bSidekiq\.configure_server\b/i,
  /\bREDIS_URL\b/i
];
const REDIS_LOCK = /^[ \t]*redis \(/m;
const REDIS_LOCK_SIDEKIQ = /^[ \t]*sidekiq \(/m;
const REDIS_LOCK_RESQUE = /^[ \t]*resque \(/m;

export function detectServices(root = process.cwd()) {
  const read = (file) => {
    try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; }
  };
  const uncommented = (contents) => contents.replace(/#.*$/gm, "");
  const contents = [
    "config/database.yml",
    "Gemfile",
    "Gemfile.lock",
    "config/application.rb",
    "config/environments/test.rb",
    "config/environments/development.rb",
    "config/initializers/sidekiq.rb",
    "config/sidekiq.yml"
  ].map(read).join("\n");
  const text = uncommented(contents);
  const lock = `${uncommented(read("Gemfile.lock"))}\n`;
  const services = [];
  const hasRedis = REDIS_EVIDENCE.some((re) => re.test(text)) ||
    REDIS_LOCK.test(lock) ||
    REDIS_LOCK_SIDEKIQ.test(lock) ||
    REDIS_LOCK_RESQUE.test(lock);
  if (hasRedis) services.push("redis");
  const hasChrome = /driven_by\s*:\s*(?:selenium|cuprite|chrome|apparition)/i.test(text) ||
    /selenium-webdriver|cuprite|apparition|webdrivers/i.test(text + lock) ||
    /js:\s*true|:js|:type\s*=>\s*:system|:type\s*=>\s*:feature/i.test(text + lock);
  if (hasChrome) services.push("chrome");
  // De-duplicate while preserving order
  return [...new Set(services)];
}

export { NAME };
