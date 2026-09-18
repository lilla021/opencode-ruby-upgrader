import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function receiptDigest(receipts = []) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(receipts))).digest("hex");
}

export function worktreeFingerprint(root = process.cwd()) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const headSha = git(["rev-parse", "HEAD"]).trim();
  const diff = git(["diff", "--binary", "HEAD", "--", ":(exclude).ruby-upgrades"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ":(exclude).ruby-upgrades"])
    .split("\0").filter(Boolean).map((file) => `${file}\0${git(["hash-object", "--", file]).trim()}`).join("\0");
  return { algorithm: "sha256", headSha, diffSha256: crypto.createHash("sha256").update(`${diff}\0${untracked}`).digest("hex") };
}
