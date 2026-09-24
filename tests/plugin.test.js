import test from "node:test";
import assert from "node:assert/strict";
import RubyUpgradePlugin from "../src/index.js";

test("registers a Ruby upgrade agent and command without overwriting user configuration", async () => {
  const plugin = await RubyUpgradePlugin();
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.agent["ruby-upgrade"].mode, "primary");
  assert.match(cfg.agent["ruby-upgrade"].prompt, /Non-negotiable safety contract/);
  assert.match(cfg.agent["ruby-upgrade"].prompt, /node .*bin\/opencode-ruby-upgrader\.mjs preflight --json/);
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["git push*"], "deny");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["git *"], "deny");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader commit-hop --report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["bundle install*"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader resume --report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader record-framework-bridge --report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader begin-rails-bridge --ruby-report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader commit-rails-hop --report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader discard-pending-app-update --report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader discard-last-rails-iteration --report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["opencode-ruby-upgrader record-dependency-review --report *"], "ask");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["*&&*"], "deny");
  assert.equal(cfg.agent["ruby-upgrade"].permission.bash["*"], "ask");
  assert.equal(cfg.command["ruby-upgrade"].agent, "ruby-upgrade");
});
