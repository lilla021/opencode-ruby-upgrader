import fs from "node:fs";
import path from "node:path";

export function inspectSupplyChain(root = process.cwd()) {
  const lockfile = path.join(root, "Gemfile.lock");
  if (!fs.existsSync(lockfile)) return { lockfile: null, sources: [], privateSources: [], dependencyCount: 0, vulnerabilityStatus: "unavailable", licenseStatus: "unavailable" };
  const contents = fs.readFileSync(lockfile, "utf8");
  const sources = [...contents.matchAll(/^\s*remote:\s*(.+)$/gm)].map((match) => match[1].trim());
  const privateSources = sources.filter((source) => !/^https:\/\/rubygems\.org\/?$/i.test(source));
  const dependencyCount = (contents.match(/^    [\w.-]+ \(/gm) ?? []).length;
  return { lockfile: "Gemfile.lock", sources, privateSources, dependencyCount, vulnerabilityStatus: "requires_bundle_audit_review", licenseStatus: "requires_bundle_license_review" };
}
