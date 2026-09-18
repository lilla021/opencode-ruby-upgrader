import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SECRET_VALUE = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:xox[baprs]-|npm_|glpat-)[A-Za-z0-9_-]{16,})/g;
const SECRET_KEY = /(?:password|secret|token|api[_-]?key|credential|authorization)/i;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/ig;
const URL_SECRET_QUERY = /([?&](?:password|secret|token|api[_-]?key|credential|authorization)=)[^&#\s]*/ig;
const statuses = new Set(["in_progress", "paused", "blocked", "complete"]);
const phases = new Set(["initialized", "inventory_complete", "research_complete", "hop_validated", "committed", "paused", "blocked", "complete"]);
const reportName = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export class RunStateError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function redact(value, key = "") {
  if (/^(?:root|worktreeRoot)$/i.test(key)) return "[LOCAL PATH]";
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactSourceUrl(value).replace(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function redactSourceUrl(value) {
  return typeof value === "string" ? value.replace(URL_CREDENTIALS, "$1[REDACTED]@").replace(URL_SECRET_QUERY, "$1[REDACTED]") : value;
}

function validVersion(value) { return typeof value === "string" && /^\d+\.\d+(?:\.(?:\d+|x))?$/.test(value); }
function validRailsVersion(value) { return typeof value === "string" && /^\d+(?:\.\d+)+$/.test(value); }
function validCitation(value) { return value && typeof value.title === "string" && /^https:\/\//.test(value.url ?? ""); }
function safeFiles(files) { return Array.isArray(files) && files.every((file) => typeof file === "string" && !path.isAbsolute(file) && !file.includes("..")); }
function validAppUpdateReview(review) { return review && review.command === "bin/rails app:update" && typeof review.receiptId === "string" && !Number.isNaN(Date.parse(review.executedAt ?? "")) && !Number.isNaN(Date.parse(review.reviewedAt ?? "")) && validFingerprint(review.worktree) && ["no_changes", "changes_applied", "changes_deferred"].includes(review.outcome) && safeFiles(review.files) && typeof review.summary === "string" && Boolean(review.summary); }
function validFingerprint(fingerprint) { return fingerprint && fingerprint.algorithm === "sha256" && /^[a-f0-9]{40}$/i.test(fingerprint.headSha ?? "") && /^[a-f0-9]{64}$/i.test(fingerprint.diffSha256 ?? ""); }
function validReceipt(receipt) { return receipt && receipt.receiptVersion === 1 && typeof receipt.id === "string" && /^[a-f0-9-]{36}$/i.test(receipt.id) && ["test", "rails_app_update"].includes(receipt.kind) && typeof receipt.commandId === "string" && Array.isArray(receipt.argv) && !Number.isNaN(Date.parse(receipt.startedAt ?? "")) && !Number.isNaN(Date.parse(receipt.finishedAt ?? "")) && typeof receipt.durationMs === "number" && (typeof receipt.exitCode === "number" || receipt.exitCode === null) && typeof receipt.timedOut === "boolean" && /^[a-f0-9]{64}$/i.test(receipt.output?.redactedSha256 ?? "") && Number.isSafeInteger(receipt.output?.bytes) && receipt.output.bytes >= 0 && receipt.output.summary === undefined && validFingerprint(receipt.worktree); }
function receiptErrors(iteration, index, rails, required, errors) {
  const receipts = iteration?.validationReceipts;
  if (!required && receipts === undefined) return;
  if (!Array.isArray(receipts) || !receipts.length || receipts.some((receipt) => !validReceipt(receipt))) errors.push(`${rails ? "Rails " : ""}iteration ${index + 1} requires valid executed validation receipts.`);
  if (iteration?.tests?.passed === true && !receipts?.some((receipt) => receipt.kind === "test" && receipt.exitCode === 0 && receipt.testEvidence?.passed === true)) errors.push(`${rails ? "Rails " : ""}iteration ${index + 1} requires a passing executed test receipt.`);
  if (rails && !receipts?.some((receipt) => receipt.kind === "rails_app_update" && receipt.exitCode === 0)) errors.push(`Rails iteration ${index + 1} requires a successful executed app:update receipt.`);
  if (rails) {
    const update = receipts?.[0];
    const test = receipts?.at(-1);
    const review = iteration?.appUpdateReview;
    if (receipts?.length !== 2 || update?.kind !== "rails_app_update" || update.exitCode !== 0 || test?.kind !== "test" || test.exitCode !== 0 || test.testEvidence?.passed !== true || !review || review.receiptId !== update.id || review.executedAt !== update.startedAt || review.worktree.headSha !== update.worktree.headSha || review.worktree.diffSha256 !== update.worktree.diffSha256 || Date.parse(update.finishedAt) > Date.parse(review.reviewedAt) || Date.parse(review.reviewedAt) > Date.parse(test.startedAt)) errors.push(`Rails iteration ${index + 1} must execute app:update, review its receipt and diff, then run final passing tests.`);
  }
}

function validateRailsBridge(run, errors) {
  for (const key of ["runId", "title", "startedAt", "targetRails", "targetRailsPinnedAt", "phase", "status", "bridge"]) if (!run[key]) errors.push(`Rails bridge report requires ${key}.`);
  if (!validRailsVersion(run.targetRails)) errors.push("targetRails must be a Rails version.");
  if (typeof run.runId !== "string" || !/^[a-f0-9-]{36}$/i.test(run.runId ?? "")) errors.push("runId must be a UUID.");
  if (run.startedAt && Number.isNaN(Date.parse(run.startedAt))) errors.push("startedAt must be ISO-8601.");
  if (!statuses.has(run.status) || !phases.has(run.phase)) errors.push("Rails bridge has invalid status or phase.");
  if (run.lockNonce !== undefined && (typeof run.lockNonce !== "string" || !/^[a-f0-9-]{36}$/i.test(run.lockNonce))) errors.push("lockNonce must be a UUID.");
  if (run.targetRailsPinnedAt && Number.isNaN(Date.parse(run.targetRailsPinnedAt))) errors.push("targetRailsPinnedAt must be ISO-8601.");
  if (!run.bridge || typeof run.bridge !== "object" || typeof run.bridge.rubyReportPath !== "string" || !/^[a-f0-9-]{36}$/i.test(run.bridge.rubyRunId ?? "") || !validVersion(run.bridge.rubyFrom) || !validVersion(run.bridge.rubyTo) || !validRailsVersion(run.bridge.railsFrom) || !validRailsVersion(run.bridge.railsTo)) errors.push("Rails bridge report has invalid Ruby-run linkage.");
  if (!Array.isArray(run.research?.ladder) || run.research.ladder.some((version) => !validRailsVersion(version))) errors.push("Rails bridge research.ladder must contain Rails versions.");
  if (!Array.isArray(run.research?.citations) || run.research.citations.some((citation) => !validCitation(citation))) errors.push("research.citations must contain HTTPS citations.");
  if (!Array.isArray(run.iterations)) errors.push("iterations must be an array.");
  if (run.pendingAppUpdate !== undefined && (!validReceipt(run.pendingAppUpdate) || run.pendingAppUpdate.kind !== "rails_app_update" || run.pendingAppUpdate.exitCode !== 0 || !["research_complete", "committed"].includes(run.phase))) errors.push("Rails bridge pending app:update receipt is invalid.");
  for (const [index, iteration] of (run.iterations ?? []).entries()) {
    if (!validRailsVersion(iteration?.from) || !validRailsVersion(iteration?.to) || iteration?.status !== "complete") errors.push(`Rails iteration ${index + 1} is invalid.`);
    if (!safeFiles(iteration?.files) || iteration?.tests?.passed !== true || !iteration.tests?.command || !iteration.tests?.smoke || !Array.isArray(iteration?.citations) || !iteration.citations.length || !Array.isArray(iteration?.fixes) || iteration.fixes.some((fix) => !safeFiles(fix.files) || !fix.explanation)) errors.push(`Rails iteration ${index + 1} lacks required evidence.`);
    if (!validAppUpdateReview(iteration?.appUpdateReview)) errors.push(`Rails iteration ${index + 1} requires reviewed bin/rails app:update evidence.`);
    if (iteration?.appUpdateReview?.outcome === "changes_applied" && iteration.appUpdateReview.files.some((file) => !iteration.files.includes(file))) errors.push(`Rails iteration ${index + 1} must declare applied app:update files.`);
    if (iteration?.checkpointSha !== undefined && !/^[a-f0-9]{40}$/i.test(iteration.checkpointSha)) errors.push(`Rails iteration ${index + 1} checkpointSha must be a Git SHA.`);
    receiptErrors(iteration, index, true, run.validationReceiptsRequired === true, errors);
  }
}

export function validateRun(run) {
  const errors = [];
  if (!run || typeof run !== "object" || Array.isArray(run)) return { valid: false, errors: ["Report must be a JSON object."] };
  if (run.schemaVersion !== 2) errors.push("Report schemaVersion must be 2.");
  if (run.validationReceiptsRequired !== undefined && run.validationReceiptsRequired !== true) errors.push("validationReceiptsRequired must be true when present.");
  if (run.reportType === "rails_bridge") { validateRailsBridge(run, errors); return { valid: errors.length === 0, errors }; }
  if (run.reportType !== undefined && run.reportType !== "ruby") errors.push("Unknown reportType.");
  for (const key of ["runId", "title", "startedAt", "targetRuby", "targetPinnedAt", "phase", "status"]) if (!run[key]) errors.push(`Report requires ${key}.`);
  if (run.lockNonce !== undefined && (typeof run.lockNonce !== "string" || !/^[a-f0-9-]{36}$/i.test(run.lockNonce))) errors.push("lockNonce must be a UUID.");
  if (typeof run.runId !== "string" || !/^[a-f0-9-]{36}$/i.test(run.runId ?? "")) errors.push("runId must be a UUID.");
  if (run.startedAt && Number.isNaN(Date.parse(run.startedAt))) errors.push("startedAt must be ISO-8601.");
  if (!validVersion(run.targetRuby)) errors.push("targetRuby must be a Ruby version.");
  if (run.targetPinnedAt && Number.isNaN(Date.parse(run.targetPinnedAt))) errors.push("targetPinnedAt must be ISO-8601.");
  if (!statuses.has(run.status)) errors.push("Invalid run status.");
  if (!phases.has(run.phase)) errors.push("Invalid run phase.");
  if (!Array.isArray(run.iterations)) errors.push("iterations must be an array.");
  if (!Array.isArray(run.research?.ladder) || run.research.ladder.some((version) => !validVersion(version))) errors.push("research.ladder must be Ruby versions.");
  if (!Array.isArray(run.research?.citations) || run.research.citations.some((citation) => !validCitation(citation))) errors.push("research.citations must contain HTTPS citations.");
  if (!Array.isArray(run.riskDecisions)) errors.push("riskDecisions must be an array.");
  if (run.requiredRisks !== undefined && (!Array.isArray(run.requiredRisks) || run.requiredRisks.some((risk) => typeof risk !== "string"))) errors.push("requiredRisks must be string identifiers.");
  if (run.frameworkBridge !== undefined && run.frameworkBridge !== null) {
    const bridge = run.frameworkBridge;
    if (!bridge || typeof bridge !== "object" || bridge.status !== "approved") errors.push("frameworkBridge must be an approved compatibility decision.");
    if (!validVersion(bridge?.rubyFrom) || !validVersion(bridge?.rubyTo) || !validRailsVersion(bridge?.railsFrom) || !validRailsVersion(bridge?.railsTo)) errors.push("frameworkBridge requires Ruby and Rails from/to versions.");
    if (typeof bridge?.rationale !== "string" || !bridge.rationale) errors.push("frameworkBridge requires a rationale.");
    if (!Array.isArray(bridge?.citations) || !bridge.citations.length || bridge.citations.some((citation) => !validCitation(citation))) errors.push("frameworkBridge requires HTTPS citations.");
  }
  for (const [index, iteration] of (run.iterations ?? []).entries()) {
    if (!validVersion(iteration?.from) || !validVersion(iteration?.to)) errors.push(`Iteration ${index + 1} requires Ruby from/to versions.`);
    if (iteration?.status !== "complete") errors.push(`Iteration ${index + 1} must be complete.`);
    if (!safeFiles(iteration?.files)) errors.push(`Iteration ${index + 1} files must be safe relative paths.`);
    if (iteration?.tests?.passed !== true || typeof iteration.tests.command !== "string" || !iteration.tests.command) errors.push(`Iteration ${index + 1} requires passing test evidence.`);
    if (typeof iteration.tests.smoke !== "string" || !iteration.tests.smoke) errors.push(`Iteration ${index + 1} requires smoke evidence.`);
    if (!Array.isArray(iteration.citations) || iteration.citations.length === 0 || iteration.citations.some((citation) => !validCitation(citation))) errors.push(`Iteration ${index + 1} requires HTTPS citations.`);
    if (!Array.isArray(iteration.fixes) || iteration.fixes.some((fix) => !Array.isArray(fix.files) || typeof fix.explanation !== "string" || !fix.explanation)) errors.push(`Iteration ${index + 1} requires explained fixes.`);
    if (iteration.dependencyReview && (iteration.dependencyReview.completed !== true || typeof iteration.dependencyReview.compatibility !== "string" || typeof iteration.dependencyReview.licenses !== "string")) errors.push(`Iteration ${index + 1} dependency review is incomplete.`);
    if (iteration.checkpointSha !== undefined && !/^[a-f0-9]{40}$/i.test(iteration.checkpointSha)) errors.push(`Iteration ${index + 1} checkpointSha must be a Git SHA.`);
    receiptErrors(iteration, index, false, run.validationReceiptsRequired === true, errors);
  }
  return { valid: errors.length === 0, errors };
}

function canonicalRoot(root) { return fs.realpathSync(root); }
function runsDirectory(root, create = false) {
  const canonical = canonicalRoot(root);
  let current = canonical;
  for (const component of [".ruby-upgrades", "runs"]) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) {
      if (!create) return current;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunStateError("Upgrade evidence directories must be real directories inside the worktree.", "unsafe-report-path");
  }
  return current;
}

function reportPath(root, relativePath, create = false) {
  if (typeof relativePath !== "string" || relativePath !== path.join(".ruby-upgrades", "runs", path.basename(relativePath)) || !reportName.test(path.basename(relativePath))) throw new RunStateError("Report must be a generated JSON basename under .ruby-upgrades/runs/.", "invalid-report-path");
  const directory = runsDirectory(root, create);
  const file = path.join(directory, path.basename(relativePath));
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new RunStateError("Report must be a regular file inside the worktree.", "unsafe-report-path");
  }
  return file;
}

export function readRun(root, relativePath) {
  try {
    const run = JSON.parse(fs.readFileSync(reportPath(root, relativePath), "utf8"));
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
  const file = reportPath(root, relativePath, true);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(redact(run), null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  const markdown = file.replace(/\.json$/, ".md");
  if (fs.existsSync(markdown) && (!fs.lstatSync(markdown).isFile() || fs.lstatSync(markdown).isSymbolicLink())) throw new RunStateError("Markdown evidence must be a regular file inside the worktree.", "unsafe-report-path");
  const safe = redact(run);
  const target = safe.reportType === "rails_bridge" ? `- **Target Rails:** ${safe.targetRails}` : `- **Target Ruby:** ${safe.targetRuby}`;
  const markdownBody = `# ${safe.title}\n\n- **Status:** ${safe.status}\n- **Phase:** ${safe.phase}\n${target}\n- **Started:** ${safe.startedAt}\n\n## Durable evidence\n\n\`\`\`json\n${JSON.stringify(safe, null, 2)}\n\`\`\`\n`;
  const markdownTemporary = path.join(path.dirname(markdown), `.${path.basename(markdown)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(markdownTemporary, markdownBody, { mode: 0o600, flag: "wx" });
  fs.renameSync(markdownTemporary, markdown);
}

function lockPath(root) {
  try { return execFileSync("git", ["rev-parse", "--git-path", "opencode-ruby-upgrade.lock"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return path.join(runsDirectory(root, true), ".run.lock"); }
}
export function acquireRunLock(root, relativePath) {
  reportPath(root, relativePath, true);
  const file = lockPath(root);
  const payload = { pid: process.pid, nonce: crypto.randomUUID(), report: relativePath, acquiredAt: new Date().toISOString() };
  try { fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 }); return payload; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let current = {}; try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* explicit recovery only */ }
    throw new RunStateError(`An upgrade lock exists for ${current.report ?? "an unknown run"}. Inspect it, then explicitly release it if the prior session is gone.`, "run-locked");
  }
}
export function assertRunLock(root, relativePath, expectedNonce) {
  try {
    const current = JSON.parse(fs.readFileSync(lockPath(root), "utf8"));
    if (current.report !== relativePath || !current.nonce || (expectedNonce && current.nonce !== expectedNonce)) throw new RunStateError("Another upgrade run owns the worktree lock.", "lock-owner-mismatch");
    return current;
  } catch (error) { if (error instanceof RunStateError) throw error; throw new RunStateError("No active run lock exists. Resume the recorded run before continuing.", "run-lock-missing"); }
}
export function releaseRunLock(root, relativePath, expectedNonce) {
  const file = lockPath(root); const current = assertRunLock(root, relativePath, expectedNonce);
  const latest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (latest.nonce !== current.nonce) throw new RunStateError("Lock changed while releasing; refusing to remove it.", "lock-raced");
  fs.rmSync(file);
}
