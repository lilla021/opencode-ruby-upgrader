import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { redact } from "./run-state.js";
import { parseTestEvidence } from "./test-evidence.js";
import { worktreeFingerprint } from "./provenance.js";
import { readTargetRuntime, validateTargetRuntime } from "./target-runtime.js";

const railsAppUpdateSkipExisting = [
  'require "./config/application"',
  'require "rails/generators"',
  'require "rails/generators/rails/app/app_generator"',
  'generator = Rails::Generators::AppGenerator.new(["rails"], { api: !!Rails.application.config.api_only, update: true }, destination_root: Rails.root, behavior: :skip)',
  'File.exist?(Rails.root.join("config", "application.rb")) ? generator.send(:app_const) : generator.send(:valid_const?)',
  '[:create_boot_file, :update_config_files, :create_bin_files, :display_upgrade_guide_info].each { |method| generator.send(method) }',
].join("; ");

const commands = Object.freeze({
  "bundle-rspec": { argv: ["bundle", "exec", "rspec"], kind: "test", expected: "bundle exec rspec" },
  "docker-bundle-rspec": { argv: ["bundle", "exec", "rspec"], kind: "test", expected: "bundle exec rspec", docker: true },
  "bundle-rails-test": { argv: ["bundle", "exec", "rails", "test"], kind: "test", expected: "bundle exec rails test" },
  "bundle-rake-test": { argv: ["bundle", "exec", "rake", "test"], kind: "test", expected: "bundle exec rake test" },
  "bin-rails-test": { argv: ["bin/rails", "test"], kind: "test", expected: "bin/rails test" },
  "rails-app-update": { argv: ["bundle", "exec", "ruby", "-e", railsAppUpdateSkipExisting], kind: "rails_app_update", expected: "bin/rails app:update", docker: true }
});

function dockerContainer(root, spawn) {
  const runtime = readTargetRuntime(root);
  if (!runtime) throw new Error("Prepare the isolated target runtime with prepare-target-runtime --ruby <x.y.z> before Docker validation.");
  return validateTargetRuntime({ root, runtime, spawn });
}

export function executeValidation({ root = process.cwd(), inventory, commandId, timeoutMs = 600000, spawn = spawnSync }) {
  const definition = commands[commandId];
  if (!definition) throw new Error("Unknown validation command ID.");
  if (definition.kind === "rails_app_update" ? inventory.framework !== "rails" : !inventory.recommendedCommands.includes(definition.expected)) throw new Error("Validation command is not supported by this project's detected adapter.");
  const environment = definition.docker ? { type: "docker", ...dockerContainer(root, spawn) } : undefined;
  const argv = definition.docker ? ["docker", "exec", "--env", "DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL=true", environment.name, ...definition.argv] : definition.argv;
  const startedAt = new Date().toISOString(); const started = Date.now();
  const result = spawn(argv[0], argv.slice(1), { cwd: root, shell: false, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 });
  const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`).slice(0, 8192);
  const durationMs = Date.now() - started; const timedOut = result.error?.code === "ETIMEDOUT";
  const receipt = { receiptVersion: 1, id: crypto.randomUUID(), kind: definition.kind, commandId, argv, ...(environment ? { environment } : {}), startedAt, finishedAt: new Date().toISOString(), durationMs, exitCode: typeof result.status === "number" ? result.status : null, timedOut, output: { redactedSha256: crypto.createHash("sha256").update(output).digest("hex"), bytes: Buffer.byteLength(output) }, worktree: worktreeFingerprint(root) };
  if (definition.kind === "test") receipt.testEvidence = parseTestEvidence(output, definition.expected, durationMs / 1000);
  return receipt;
}
