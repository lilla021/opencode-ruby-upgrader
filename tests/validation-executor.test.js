import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { executeValidation } from "../src/validation-executor.js";

test("docker RSpec validation requires a prepared runtime manifest", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruby-docker-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Gemfile"), 'gem "rspec-rails"\n');
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["add", "Gemfile"], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"], { cwd: root });
  assert.throws(() => executeValidation({ root, inventory: { framework: "rails", recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec" }), /Prepare the isolated target runtime/);
});

test("docker validation no longer uses an environment-variable container selection", () => {
  const previous = process.env.OPENCODE_RUBY_UPGRADER_DOCKER_CONTAINER;
  process.env.OPENCODE_RUBY_UPGRADER_DOCKER_CONTAINER = "ruby-upgrade-e2e-ruby";
  assert.throws(() => executeValidation({ inventory: { recommendedCommands: ["bundle exec rspec"] }, commandId: "docker-bundle-rspec" }), /Prepare the isolated target runtime/);
  if (previous === undefined) delete process.env.OPENCODE_RUBY_UPGRADER_DOCKER_CONTAINER;
  else process.env.OPENCODE_RUBY_UPGRADER_DOCKER_CONTAINER = previous;
});
