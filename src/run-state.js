import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SECRET_VALUE = /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g;
const SECRET_KEY = /(?:password|secret|token|api[_-]?key|credential|authorization)/i;
const allowedStatuses = new Set(["in_progress", "blocked", "complete"]);

export class RunStateError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function redact(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function validateRun(run) {
  const errors = [];
  if (!run || typeof run !== "object" || Array.isArray(run)) errors.push("Report must be a JSON object.");
  else {
    if (run.status && !allowedStatuses.has(run.status)) errors.push("Invalid run status.");
    if (run.startedAt && Number.isNaN(Date.parse(run.startedAt))) errors.push("startedAt must be ISO-8601.");
    if (run.iterations !== undefined && !Array.isArray(run.iterations)) errors.push("iterations must be an array.");
    for (const [index, iteration] of (run.iterations ?? []).entries()) {
      if (!iteration?.from || !iteration?.to) errors.push(`Iteration ${index + 1} requires from and to versions.`);
      if (!allowedStatuses.has(iteration?.status)) errors.push(`Iteration ${index + 1} has an invalid status.`);
      if (iteration?.tests?.passed !== undefined && typeof iteration.tests.passed !== "boolean") errors.push(`Iteration ${index + 1} test result must be boolean.`);
      if (iteration?.files !== undefined && (!Array.isArray(iteration.files) || iteration.files.some((file) => typeof file !== "string"))) errors.push(`Iteration ${index + 1} files must be string paths.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function reportPath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const directory = path.join(root, ".ruby-upgrades", "runs");
  if (!resolved.startsWith(`${directory}${path.sep}`) || path.extname(resolved) !== ".json") throw new RunStateError("Report must be JSON under .ruby-upgrades/runs/.", "invalid-report-path");
  return resolved;
}

function lockPath(root) {
  try { return execFileSync("git", ["rev-parse", "--git-path", "opencode-ruby-upgrade.lock"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return path.join(root, ".ruby-upgrades", "run.lock"); }
}

export function readRun(root, relativePath) {
  const file = reportPath(root, relativePath);
  try {
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    const validation = validateRun(run);
    if (!validation.valid) throw new RunStateError(validation.errors.join(" "), "invalid-report");
    return redact(run);
  } catch (error) {
    if (error instanceof RunStateError) throw error;
    throw new RunStateError("The upgrade report is missing or invalid JSON.", "invalid-report");
  }
}

export function writeRun(root, relativePath, run) {
  const validation = validateRun(run);
  if (!validation.valid) throw new RunStateError(validation.errors.join(" "), "invalid-report");
  const file = reportPath(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(redact(run), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function acquireRunLock(root, relativePath) {
  const file = lockPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { pid: process.pid, report: relativePath, acquiredAt: new Date().toISOString() };
  try { fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 }); return payload; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let current = {};
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* corrupt locks require an explicit manual decision */ }
    throw new RunStateError(`An upgrade lock exists for ${current.report ?? "an unknown run"}. Do not override it automatically; inspect the report, then explicitly release the lock if the prior session is gone.`, "run-locked");
  }
}

export function assertRunLock(root, relativePath) {
  try {
    const current = JSON.parse(fs.readFileSync(lockPath(root), "utf8"));
    if (current.report !== relativePath) throw new RunStateError("Another upgrade run owns the worktree lock.", "lock-owner-mismatch");
  } catch (error) {
    if (error instanceof RunStateError) throw error;
    throw new RunStateError("No active run lock exists. Resume the recorded run before committing.", "run-lock-missing");
  }
}

export function releaseRunLock(root, relativePath) {
  const file = lockPath(root);
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    if (current.report !== relativePath) throw new RunStateError("The active lock belongs to another run.", "lock-owner-mismatch");
    fs.rmSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
