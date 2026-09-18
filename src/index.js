import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readAgentPrompt() {
  return fs.readFileSync(path.join(packageRoot, "agents", "ruby-upgrade.md"), "utf8")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .trim();
}

export default async function RubyUpgradePlugin() {
  return {
    config: async (cfg) => {
      cfg.agent ??= {};
      if (!cfg.agent["ruby-upgrade"]) {
        cfg.agent["ruby-upgrade"] = {
          mode: "primary",
          color: "#cc342d",
          description: "Principal-level, evidence-driven Ruby and Rails runtime migration specialist.",
          prompt: readAgentPrompt(),
          permission: {
            read: "allow", edit: "allow", glob: "allow", grep: "allow",
            webfetch: "allow", question: "allow", todowrite: "allow",
            bash: {
              "*": "ask",
              "git *": "deny",
              "git status*": "allow",
              "git diff*": "allow",
              "git log*": "allow",
              "git show*": "allow",
              "git rev-parse*": "allow",
              "git branch --show-current": "allow",
              "git worktree list*": "allow",
              "git push*": "deny",
              "git -C * push*": "deny",
              "git fetch*": "deny",
              "git remote*": "deny",
              "git checkout*": "deny",
              "git switch*": "deny",
              "git reset*": "deny",
              "git clean*": "deny",
              "git rebase*": "deny",
              "git merge*": "deny",
              "bundle --version*": "allow",
              "bundle check*": "allow",
               "bundle install*": "ask",
               "bundle update *": "ask",
               "bundle exec rspec*": "ask",
               "bundle exec rails test*": "ask",
               "bundle exec rake test*": "ask",
              "bundle exec rake db:*": "deny",
                "bin/rails test*": "ask",
                "./bin/rails test*": "ask",
                "bin/rails app:update": "ask",
              "ruby --version*": "allow",
              "opencode-ruby-upgrader preflight*": "allow",
                "opencode-ruby-upgrader begin --target *": "ask",
                "opencode-ruby-upgrader begin-rails-bridge --ruby-report *": "ask",
              "opencode-ruby-upgrader status --report *": "allow",
               "opencode-ruby-upgrader transition --report *": "ask",
              "opencode-ruby-upgrader inventory": "allow",
              "opencode-ruby-upgrader supply-chain": "allow",
              "opencode-ruby-upgrader git-capabilities": "allow",
                "opencode-ruby-upgrader record-research --report *": "ask",
                "opencode-ruby-upgrader record-rails-research --report *": "ask",
                "opencode-ruby-upgrader record-risk --report *": "ask",
                "opencode-ruby-upgrader record-framework-bridge --report *": "ask",
                "opencode-ruby-upgrader record-iteration --report *": "ask",
                "opencode-ruby-upgrader record-rails-iteration --report *": "ask",
                "opencode-ruby-upgrader record-executed-iteration --report *": "ask",
                "opencode-ruby-upgrader record-executed-rails-iteration --report *": "ask",
                "opencode-ruby-upgrader commit-hop --report *": "ask",
                "opencode-ruby-upgrader commit-rails-hop --report *": "ask",
               "opencode-ruby-upgrader resume --report *": "ask",
               "opencode-ruby-upgrader release-lock --report *": "ask",
              "*;*": "deny",
              "*&&*": "deny",
              "*||*": "deny",
              "*|*": "deny",
              "*$(*": "deny",
              "*`*": "deny",
              "git push*": "deny",
              "gh *": "deny",
              "npm publish*": "deny",
              "gem push*": "deny",
              "bundle exec rake release*": "deny"
            }
          }
        };
      }

      cfg.command ??= {};
      if (!cfg.command["ruby-upgrade"]) {
        cfg.command["ruby-upgrade"] = {
          description: "Safely migrate this Ruby project to the latest stable Ruby release.",
          agent: "ruby-upgrade",
          template: "Begin the Ruby migration preflight. User context: $ARGUMENTS"
        };
      }
    }
  };
}
