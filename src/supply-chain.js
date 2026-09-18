import fs from "node:fs";
import path from "node:path";
import { redactSourceUrl } from "./run-state.js";

export function inspectSupplyChain(root = process.cwd()) {
  const lockfile = path.join(root, "Gemfile.lock");
  const gemfile = path.join(root, "Gemfile");
  if (!fs.existsSync(lockfile) && !fs.existsSync(gemfile)) return { lockfile: null, sources: [], privateSources: [], dependencyCount: 0, vulnerabilityStatus: "unavailable", licenseStatus: "unavailable" };
  const contents = fs.existsSync(lockfile) ? fs.readFileSync(lockfile, "utf8") : "";
  const gemfileContents = fs.existsSync(gemfile) ? fs.readFileSync(gemfile, "utf8") : "";
  const sources = [...contents.matchAll(/^\s*remote:\s*(.+)$/gm)].map((match) => redactSourceUrl(match[1].trim()));
  const declaredSources = [...gemfileContents.matchAll(/(?:git|github|path)\s*:\s*["']([^"']+)["']/g), ...gemfileContents.matchAll(/\bsource\s*["']([^"']+)["']/g)].map((match) => redactSourceUrl(match[1]));
  const privateSources = [...sources, ...declaredSources].filter((source) => !/^https:\/\/rubygems\.org\/?$/i.test(source));
  const dependencyCount = (contents.match(/^    [\w.-]+ \(/gm) ?? []).length;
  return { lockfile: fs.existsSync(lockfile) ? "Gemfile.lock" : null, sources, declaredSources, privateSources, dependencyCount, vulnerabilityStatus: "requires_bundle_audit_review", licenseStatus: "requires_bundle_license_review" };
}
