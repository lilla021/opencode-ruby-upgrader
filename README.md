# opencode-ruby-upgrader

An evidence-driven, principal-level Ruby and Rails migration agent for [OpenCode](https://opencode.ai). It upgrades a project one Ruby minor series at a time to the latest stable Ruby, researches official compatibility guidance, updates affected code and dependencies, and leaves a reviewable migration trail.

## Safety model

For Git repositories, the agent runs **only** from a linked Git worktree created by the user. This keeps your normal checkout free for other work. In a non-Git project, it asks for confirmation before proceeding without worktree isolation or Git checkpoints. It never creates, switches, deletes, merges, pushes, or reconfigures branches/remotes. It also never publishes, deploys, or runs destructive database commands.

Before the first change it shows copyable instructions when invoked from a primary checkout:

```bash
git branch ruby-upgrade/ruby-<target>
git worktree add ../<repo>-ruby-<target> ruby-upgrade/ruby-<target>
cd ../<repo>-ruby-<target>
opencode
```

After every routine Ruby minor-version hop with passing validation, the agent creates a **local** checkpoint commit through a guarded commit gate. The gate verifies the linked worktree and non-default branch, expected Git history, an empty initial staging area, a complete passing report iteration, and scans staged content for likely credentials. It cannot push, fetch, alter remotes, switch branches, merge, rebase, reset, or amend history. You review local commits and are the only person who pushes the final branch.

The agent pauses—not guesses—when a migration involves data changes, authentication/authorization, payments, secrets, production configuration, framework-major upgrades, private dependencies, native extensions, or failed validation. Each pause includes evidence and practical options for continuing safely.

Every hop declares its expected changed files before commit. The commit gate blocks undeclared changes, credential-like material, executable Git hooks, non-RubyGems dependency sources, and large lockfile churn unless the user has explicitly reviewed and permitted that specific concern. Any changed lockfile also requires a recorded compatibility and license review. The target Ruby version is pinned with the research timestamp at run start, so a new upstream release cannot silently change the target mid-run. If Git author or commit-signing configuration prevents a commit, the agent reports the exact local setup issue and stops; it never changes Git configuration for you.

## Install

During development:

```json
{ "plugin": ["file:///absolute/path/to/opencode-ruby-upgrader"] }
```

After publishing:

```json
{ "plugin": ["opencode-ruby-upgrader"] }
```

Restart OpenCode, then run `/ruby-upgrade` or select `@ruby-upgrade`.

Git 2.5 or newer is required for the linked-worktree safety model. Before publishing, set the real `author`, `repository`, `bugs`, and `homepage` fields in `package.json`; they are intentionally not guessed by this starter package.

## Evidence and dashboard

Every run is recorded under `.ruby-upgrades/runs/` as Markdown and JSON. Reports contain citations, version hops, dependency and code fixes, test/coverage metrics, smoke-test evidence, risks, and approved local commits. The directory is intentionally versionable and can be opened directly as an Obsidian vault.

Launch the local-only dashboard from the repository worktree:

```bash
npx opencode-ruby-upgrader dashboard
```

It binds exclusively to `127.0.0.1` and reads repository artifacts; it never uploads code or reports.

The dashboard identifies local checkpoint commits from trailers embedded in those commits. Before the final push, inspect them locally with `git log`, `git show`, and the dashboard; after you push, the same individual commits are available for GitHub review.

## Controls and recovery

Use `/ruby-upgrade --dry-run` to receive an inventory, citations, compatibility plan, and Ruby ladder without changing the project. Use `/ruby-upgrade --target 3.4` to pin an explicit final Ruby version, or `/ruby-upgrade --stop-after-hop` to validate and commit one hop before stopping.

Each active run holds a local lock. If a session is interrupted, resume the existing report rather than starting a second migration:

```bash
opencode-ruby-upgrader resume --report .ruby-upgrades/runs/<run>.json
```

After resolving or intentionally abandoning a blocked run, release its lock with `release-lock` using the same report path. To undo a completed hop, use the reviewable local history: `git revert <hop-sha>`. Do not use reset, rebase, or force-push as routine migration recovery.

## Security boundaries

The agent defaults unknown shell commands to an OpenCode confirmation prompt. It has narrow allowances for Git inspection, common Bundler/Ruby test commands, preflight, and the guarded `commit-hop` command; direct Git mutation is denied. This protects against accidental agent actions, not malicious project code: dependency installation and tests execute project-controlled code with your local user permissions. Use an isolated environment for repositories you do not trust, and review any command OpenCode asks you to approve.

## Product limits

The upgrader automates evidence collection and compatibility-oriented edits; it cannot prove production behavior, security correctness, deployment safety, or semantic equivalence. It intentionally pauses instead of modifying database behavior, authorization, payments, secrets, and production configuration without a user decision. Supported automatic adapters currently recognize Bundler projects using Rails, RSpec, or Minitest; other stacks receive an inventory and require a user-supplied validation command.

Run the self-contained test suite with `npm test`. A CI environment that installs a supported OpenCode CLI can also run `OPENCODE_RUNTIME_E2E=1 npm run test:opencode`; this verifies the installed runtime is available and the plugin registers its agent/command contract before release.

## Disclaimer

**Use at your own risk.** This tool can modify source code, dependency locks, runtime configuration, and local Git history. It provides automated migration assistance only. You are solely responsible for reviewing changes, maintaining backups, validating tests, and approving any deployment or remote push. The authors provide no warranty and accept no liability for data loss, downtime, broken builds, or other damage arising from its use.

Ruby, Rails, GitHub, and Obsidian are trademarks of their respective owners. The agent cites official documentation and does not redistribute it.
