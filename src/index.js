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
              "bundle install*": "allow",
              "bundle update *": "allow",
              "bundle exec rspec*": "allow",
              "bundle exec rails test*": "allow",
              "bundle exec rake test*": "allow",
              "bundle exec rake db:*": "deny",
              "bin/rails test*": "allow",
              "./bin/rails test*": "allow",
              "ruby --version*": "allow",
              "opencode-ruby-upgrader preflight*": "allow",
              "opencode-ruby-upgrader begin --target *": "allow",
              "opencode-ruby-upgrader begin --target * --allow-non-git*": "ask",
              "opencode-ruby-upgrader status --report *": "allow",
              "opencode-ruby-upgrader transition --report *": "allow",
              "opencode-ruby-upgrader inventory": "allow",
              "opencode-ruby-upgrader supply-chain": "allow",
              "opencode-ruby-upgrader git-capabilities": "allow",
              "opencode-ruby-upgrader commit-hop --report *": "allow",
              "opencode-ruby-upgrader resume --report *": "allow",
              "opencode-ruby-upgrader release-lock --report *": "allow",
              "opencode-ruby-upgrader commit-hop --report * --allow-hooks*": "ask",
              "opencode-ruby-upgrader commit-hop --report * --allow-broad-lockfile*": "ask",
              "opencode-ruby-upgrader commit-hop --report * --allow-private-sources*": "ask",
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
