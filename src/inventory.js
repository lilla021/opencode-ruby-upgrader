import fs from "node:fs";
import path from "node:path";

const exists = (root, file) => fs.existsSync(path.join(root, file));
const read = (root, file) => exists(root, file) ? fs.readFileSync(path.join(root, file), "utf8") : "";

export function inventoryProject(root = process.cwd()) {
  const gemfile = read(root, "Gemfile");
  const lockfile = read(root, "Gemfile.lock");
  const rubyFiles = [".ruby-version", ".tool-versions", ".mise.toml", "Gemfile", "Dockerfile"].filter((file) => exists(root, file));
  const rubyDeclarations = rubyFiles.map((file) => {
    const contents = read(root, file);
    const match = contents.match(/(?:^|\s)(?:ruby\s*[= ]\s*["']?|ruby\s+|FROM\s+ruby:)(\d+\.\d+(?:\.\d+)?)/mi) ?? (file === ".ruby-version" ? contents.match(/^\s*(\d+\.\d+(?:\.\d+)?)\s*$/m) : null);
    return { file, value: match?.[1] ?? null };
  });
  const rspec = exists(root, "spec") || /\brspec\b/i.test(gemfile);
  const declaredRails = gemfile.match(/\bgem\s+["']rails["']\s*,?\s*["']?([~<>= ]*\d+\.\d+(?:\.\d+)?)/i)?.[1]?.trim() ?? null;
  const resolvedRails = lockfile.match(/^ {4}rails \((\d+(?:\.\d+)+)\)$/m)?.[1] ?? null;
  const rails = /\bgem\s+["']rails["']/i.test(gemfile) || Boolean(resolvedRails);
  const minitest = exists(root, "test") || /\bminitest\b/i.test(gemfile);
  const commands = rspec ? ["bundle exec rspec"] : rails ? [exists(root, "bin/rails") ? "bin/rails test" : "bundle exec rails test"] : minitest ? ["bundle exec rake test"] : [];
  const ci = [".github/workflows", ".gitlab-ci.yml", ".circleci", "Jenkinsfile", "azure-pipelines.yml"].filter((file) => exists(root, file));
  const deploy = ["Dockerfile", "docker-compose.yml", "Procfile", "app.json", "render.yaml", "fly.toml", "config/deploy.yml"].filter((file) => exists(root, file));
  return {
    root, supported: exists(root, "Gemfile"), framework: rails ? "rails" : "ruby", testFramework: rspec ? "rspec" : minitest ? "minitest" : "unknown",
    rubyDeclarations, rails: rails ? { declaredVersion: declaredRails, resolvedVersion: resolvedRails } : null, recommendedCommands: commands, ci, deploy,
    requiresDecision: !exists(root, "Gemfile") || commands.length === 0,
    reason: !exists(root, "Gemfile") ? "No Gemfile found." : commands.length === 0 ? "No recognized test adapter found." : undefined
  };
}
