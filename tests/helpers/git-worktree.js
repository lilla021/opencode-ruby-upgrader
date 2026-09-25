import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function createLinkedWorktree(t, { prefix = "ruby-upgrade-", files = { "README.md": "test\n" }, directories = [], configureDefaultBranch = true } = {}) {
  const primary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const linked = `${primary}-worktree`;
  t.after(() => {
    fs.rmSync(linked, { recursive: true, force: true });
    fs.rmSync(primary, { recursive: true, force: true });
  });

  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Test"]);
  if (configureDefaultBranch) git(primary, ["config", "opencode-ruby-upgrader.defaultBranch", "main"]);
  for (const directory of directories) fs.mkdirSync(path.join(primary, directory), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(primary, name)), { recursive: true });
    fs.writeFileSync(path.join(primary, name), contents);
  }
  git(primary, ["add", "."]);
  git(primary, ["commit", "-m", "initial"]);
  git(primary, ["worktree", "add", "-b", "ruby-upgrade/test", linked]);
  for (const directory of directories) fs.mkdirSync(path.join(linked, directory), { recursive: true });
  return { primary, linked };
}
