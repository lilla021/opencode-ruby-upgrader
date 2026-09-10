import fs from "node:fs";
import path from "node:path";

const exists = (root, file) => fs.existsSync(path.join(root, file));
const read = (root, file) => exists(root, file) ? fs.readFileSync(path.join(root, file), "utf8") : "";

export function inventoryProject(root = process.cwd()) {
  const gemfile = read(root, "Gemfile");
  const rubyFiles = [".ruby-version", ".tool-versions", ".mise.toml", "Gemfile", "Dockerfile"].filter((file) => exists(root, file));
  const rubyDeclarations = rubyFiles.map((file) => ({ file, value: read(root, file).match(/(?:^|\s)(?:ruby\s*[= ]\s*["']?|ruby\s+)(\d+\.\d+(?:\.\d+)?)/mi)?.[1] ?? null }));
  const rspec = exists(root, "spec") || /\brspec\b/i.test(gemfile);
  const rails = /\bgem\s+["']rails["']/i.test(gemfile);
  const minitest = exists(root, "test") || /\bminitest\b/i.test(gemfile);
  const commands = rspec ? ["bundle exec rspec"] : rails ? [exists(root, "bin/rails") ? "bin/rails test" : "bundle exec rails test"] : minitest ? ["bundle exec rake test"] : [];
  const ci = [".github/workflows", ".gitlab-ci.yml", ".circleci", "Jenkinsfile", "azure-pipelines.yml"].filter((file) => exists(root, file));
  const deploy = ["Dockerfile", "docker-compose.yml", "Procfile", "app.json", "render.yaml", "fly.toml", "config/deploy.yml"].filter((file) => exists(root, file));
  return {
    root, supported: exists(root, "Gemfile"), framework: rails ? "rails" : "ruby", testFramework: rspec ? "rspec" : minitest ? "minitest" : "unknown",
    rubyDeclarations, recommendedCommands: commands, ci, deploy,
    requiresDecision: !exists(root, "Gemfile") || commands.length === 0,
    reason: !exists(root, "Gemfile") ? "No Gemfile found." : commands.length === 0 ? "No recognized test adapter found." : undefined
  };
}
