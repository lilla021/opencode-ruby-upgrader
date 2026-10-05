// Read-only advisory findings about infrastructure the upgrade may have made
// inconsistent.
//
// Everything here is advisory by design and never blocks a commit. The agent
// runs the app in an isolated container; it does not have your CI config, your
// deploy host, or your platform's build process. A finding says "this file
// disagrees with the version you just moved to, confirm it" -- never "you must
// change this". A deliberate version pin that lags the app is legitimate in many
// repos, and blocking on it would be wrong as often as right.
//
// Each finding carries the evidence it was derived from so the reader can judge
// it. `confidence` distinguishes a value read out of a file ("observed") from a
// judgment about what that value implies ("review").

import fs from "node:fs";
import path from "node:path";

const exists = (root, file) => fs.existsSync(path.join(root, file));
const read = (root, file) => (exists(root, file) ? fs.readFileSync(path.join(root, file), "utf8") : "");

function finding(severity, area, title, detail, evidence, confidence = "observed") {
  return { severity, area, title, detail, evidence, confidence };
}

// `BUNDLED WITH` is the project's own record of which Bundler wrote its
// lockfile, and Bundler auto-switches to it. That makes it the most reliable
// available signal for "which Bundler will actually run here" -- more reliable
// than scanning for an installed gem, and the value a Ruby hop can invalidate.
export function bundledWith(root = process.cwd()) {
  const lockfile = read(root, "Gemfile.lock");
  const match = /^BUNDLED WITH\s*\r?\n\s+(\d+(?:\.\d+)+)/m.exec(lockfile);
  return match?.[1] ?? null;
}

// Ruby version declarations, read from the files that actually pin one. Values
// are reported verbatim: an odd but intentional pin is still worth showing.
export function rubyPins(root = process.cwd()) {
  const pins = [];
  const versionFiles = [".ruby-version", ".tool-versions", ".mise.toml"];
  for (const file of versionFiles) {
    if (!exists(root, file)) continue;
    const contents = read(root, file);
    const value = contents.match(/^\s*(\d+\.\d+(?:\.\d+)?)\s*$/m)?.[1]
      ?? contents.match(/^\s*ruby\s+(\d+\.\d+(?:\.\d+)?)\s*$/m)?.[1]
      ?? contents.match(/ruby\s*=\s*["'](\d+\.\d+(?:\.\d+)?)/)?.[1]
      ?? null;
    if (value) pins.push({ file, value });
  }
  if (exists(root, "Dockerfile")) {
    const match = read(root, "Dockerfile").match(/^\s*FROM\s+ruby:(\d+\.\d+(?:\.\d+)?)/im);
    if (match) pins.push({ file: "Dockerfile", value: match[1] });
  }
  if (exists(root, "Gemfile")) {
    const match = read(root, "Gemfile").match(/^\s*ruby\s+["']([\d.]+)["']/m);
    if (match) pins.push({ file: "Gemfile", value: match[1] });
  }
  return pins;
}

// CI workflows are inspected conservatively. YAML matrix shapes vary far too
// much to parse reliably, so this only reports Ruby versions it can see as plain
// scalars and stays silent otherwise. Reporting nothing is better than guessing
// at a matrix it only partly understood.
export function ciRubyVersions(root = process.cwd()) {
  const found = [];
  const workflows = exists(root, ".github/workflows")
    ? fs.readdirSync(path.join(root, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f))
    : [];
  for (const file of workflows) {
    const contents = read(root, path.join(".github/workflows", file));
    const seen = new Set();
    for (const match of contents.matchAll(/(?:ruby[-_]?version|ruby|RUBY_VERSION)["'\s:=]+(\d+\.\d+(?:\.\d+)?)/gi)) {
      seen.add(match[1]);
    }
    if (seen.size) found.push({ file: path.join(".github/workflows", file), versions: [...seen].sort() });
  }
  return found;
}

const series = (version) => (version ?? "").split(".").slice(0, 2).join(".");
const sameSeries = (a, b) => series(a) === series(b) && series(a) !== "";

// `advisoryFindings` is intentionally read-only and dependency-free so it can be
// called from report writing without pulling in the Docker runtime machinery.
export function advisoryFindings({ root = process.cwd(), run = {}, inventory = {} } = {}) {
  const findings = [];
  const target = run.targetRuby;
  const targetSeries = series(target);
  const pins = rubyPins(root);
  const ciVersions = ciRubyVersions(root);
  const bundler = bundledWith(root);

  for (const pin of pins) {
    if (!target || sameSeries(pin.value, target)) continue;
    findings.push(finding(
      "review",
      "version-pin",
      `${pin.file} pins Ruby ${pin.value}, but this run targeted ${target}`,
      `Update this if the deploy platform reads it, or leave it if it intentionally lags the app. Confirm which one your production runtime actually honours.`,
      `${pin.file}: ${pin.value}`
    ));
  }

  const pinFiles = new Set(pins.map((p) => p.file));
  if (!pinFiles.has("Dockerfile") && exists(root, "Dockerfile")) {
    findings.push(finding("review", "version-pin", "Dockerfile has no parseable Ruby base image", "The base image tag could not be read, so its Ruby version was not compared against this run.", "Dockerfile: unparsed", "review"));
  }

  for (const workflow of ciVersions) {
    const behind = workflow.versions.filter((version) => targetSeries && series(version) < targetSeries);
    if (!behind.length) continue;
    findings.push(finding(
      "review",
      "ci",
      `${workflow.file} does not test Ruby ${target}`,
      `It references ${behind.join(", ")}. If CI keeps testing the older version, a regression on the new one would not be caught before merge.`,
      `${workflow.file}: ${workflow.versions.join(", ")}`
    ));
  }

  if (bundler && target) {
    findings.push(finding(
      "review",
      "bundler",
      `Gemfile.lock pins Bundler ${bundler}`,
      `This run validated the app inside a container. Bundler switches to the version in \`BUNDLED WITH\`, so confirm your deploy host and CI resolve ${bundler} and that it supports Ruby ${target}. If it does not, the hop needs a Bundler upgrade scoped as its own run.`,
      `Gemfile.lock BUNDLED WITH: ${bundler}`
    ));
  }

  if (inventory.deploy?.length && !exists(root, ".ruby-version") && !exists(root, "Dockerfile")) {
    findings.push(finding("review", "platform", "No shared Ruby version file", `Deploy files exist (${inventory.deploy.join(", ")}) but there is no \`.ruby-version\`, \`.tool-versions\`, \`.mise.toml\`, or \`Dockerfile\`. The Ruby version may then be defined only inside a platform dashboard or base image you cannot see from here.`, `deploy: ${inventory.deploy.join(", ")}`));
  }

  if (exists(root, "Gemfile.lock") && !fs.statSync(path.join(root, "Gemfile.lock")).isFile()) {
    findings.push(finding("review", "lockfile", "Gemfile.lock is not a regular file", "Its BUNDLED WITH value was not read, so no Bundler finding is reported.", "Gemfile.lock", "review"));
  }

  return findings;
}