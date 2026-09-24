import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configuredDefaultBranch(cwd) {
  try { return git(cwd, ["config", "--get", "opencode-ruby-upgrader.defaultBranch"]); }
  catch { return undefined; }
}

export function inspectWorktree(cwd = process.cwd()) {
  try {
    try { git(cwd, ["--version"]); }
    catch (error) { return { ok: false, reason: "git-unavailable", detail: error.message }; }
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
      return { ok: true, mode: "non-git", root: cwd };
    }
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    const gitDir = git(cwd, ["rev-parse", "--git-dir"]);
    const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
    const linkedWorktree = path.resolve(root, gitDir) !== path.resolve(root, commonDir);
    const branch = git(cwd, ["branch", "--show-current"]);
    const sha = git(cwd, ["rev-parse", "HEAD"]);
    const dirty = Boolean(git(cwd, ["status", "--porcelain", "--", ".", ":(exclude).ruby-upgrades"]));
    const defaultBranch = configuredDefaultBranch(cwd);
    if (!linkedWorktree) return { ok: false, reason: "primary-checkout", root, branch, sha, defaultBranch };
    if (!branch) return { ok: false, reason: "detached-head", root, sha, defaultBranch };
    if (!defaultBranch) return { ok: false, reason: "default-branch-unconfigured", root, branch, sha };
    if (branch === defaultBranch) return { ok: false, reason: "default-branch", root, branch, sha, defaultBranch };
    if (dirty) return { ok: false, reason: "dirty-worktree", root, branch, sha, defaultBranch };
    return { ok: true, mode: "linked-worktree", root, branch, sha, gitDir, commonDir };
  } catch (error) {
    if (/not a git repository/i.test(error.message)) return { ok: true, mode: "non-git", root: cwd };
    return { ok: false, reason: "git-preflight-failed", detail: error.message };
  }
}

export function setupInstructions(result) {
  const repo = result.root ? path.basename(result.root) : "your-repository";
  return [
    "Ruby upgrades run only in a user-created linked Git worktree.",
    "Configure the repository default branch before starting:",
    "  git config opencode-ruby-upgrader.defaultBranch <default-branch>",
    "From your primary checkout, create a branch and linked worktree yourself:",
    `  git branch ruby-upgrade/ruby-<target>`,
    `  git worktree add ../${repo}-ruby-<target> ruby-upgrade/ruby-<target>`,
    `  cd ../${repo}-ruby-<target> && opencode`,
    "The agent will not create, switch, merge, push, or otherwise manage branches/remotes."
  ].join("\n");
}

export function inspectGitCapabilities(cwd = process.cwd()) {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    const value = (args, fallback = false) => { try { return git(cwd, args); } catch { return fallback; } };
    const submodules = fs.existsSync(path.join(root, ".gitmodules"));
    return {
      supported: true,
      shallow: value(["rev-parse", "--is-shallow-repository"]) === "true",
      sparseCheckout: value(["config", "--bool", "core.sparseCheckout"]) === "true",
      submodules,
      lfsConfigured: value(["config", "--get-regexp", "^filter\\.lfs\\."]) !== false,
      recommendation: submodules || value(["rev-parse", "--is-shallow-repository"]) === "true" || value(["config", "--bool", "core.sparseCheckout"]) === "true" ? "Pause for repository-topology review before migration." : "Standard Git topology."
    };
  } catch { return { supported: false, recommendation: "Not a Git repository." }; }
}
