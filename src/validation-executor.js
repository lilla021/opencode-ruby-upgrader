import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { redact } from "./run-state.js";
import { parseTestEvidence } from "./test-evidence.js";
import { worktreeFingerprint } from "./provenance.js";

const commands = Object.freeze({
  "bundle-rspec": { argv: ["bundle", "exec", "rspec"], kind: "test", expected: "bundle exec rspec" },
  "bundle-rails-test": { argv: ["bundle", "exec", "rails", "test"], kind: "test", expected: "bundle exec rails test" },
  "bundle-rake-test": { argv: ["bundle", "exec", "rake", "test"], kind: "test", expected: "bundle exec rake test" },
  "bin-rails-test": { argv: ["bin/rails", "test"], kind: "test", expected: "bin/rails test" },
  "rails-app-update": { argv: ["bin/rails", "app:update"], kind: "rails_app_update", expected: "bin/rails app:update" }
});

export function executeValidation({ root = process.cwd(), inventory, commandId, timeoutMs = 600000 }) {
  const definition = commands[commandId];
  if (!definition) throw new Error("Unknown validation command ID.");
  if (definition.kind === "rails_app_update" ? inventory.framework !== "rails" : !inventory.recommendedCommands.includes(definition.expected)) throw new Error("Validation command is not supported by this project's detected adapter.");
  const startedAt = new Date().toISOString(); const started = Date.now();
  const result = spawnSync(definition.argv[0], definition.argv.slice(1), { cwd: root, shell: false, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 });
  const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`).slice(0, 8192);
  const durationMs = Date.now() - started; const timedOut = result.error?.code === "ETIMEDOUT";
  const receipt = { receiptVersion: 1, id: crypto.randomUUID(), kind: definition.kind, commandId, argv: definition.argv, startedAt, finishedAt: new Date().toISOString(), durationMs, exitCode: typeof result.status === "number" ? result.status : null, timedOut, output: { redactedSha256: crypto.createHash("sha256").update(output).digest("hex"), bytes: Buffer.byteLength(output) }, worktree: worktreeFingerprint(root) };
  if (definition.kind === "test") receipt.testEvidence = parseTestEvidence(output, definition.expected, durationMs / 1000);
  return receipt;
}
