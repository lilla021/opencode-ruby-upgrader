# opencode-ruby-upgrader — release notes

## v0.1.5 — registry visuals

No functional change. The npm package page now renders its README images: the dashboard and vault-view screenshots moved from relative paths to absolute GitHub URLs, so they display on the registry in addition to GitHub.

Published through the same protected-CI gate.

## v0.1.4 — showcase polish

No functional change. Attribution and presentation updates:

- The npm package page now bears the maintainer's full name with a profile link instead of a bare handle.
- The README acknowledges [opencode-craft](https://github.com/pauloralves/opencode-craft), the skill pack this agent was built with.
- A dashboard screenshot example (captured headlessly from a real completed fixture run) is added under the Evidence section.

Published through the same protected-CI gate.

## v0.1.3 — documentation refresh

No functional change. The public documentation is tightened so the package reads cleanly on the registry and in the repository:

- Quick-start examples use `<target>` placeholders instead of a hardcoded Ruby version.
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) is now a reusable Release Gate rather than the one-time v0.1.0 audit.
- The v0.1.2 notes describe what that release actually changed.
- Stale "in progress" section headings in the evidence ledger were resolved; the receipts themselves are unchanged.

Published through the same protected-CI gate as v0.1.2.

## v0.1.2 — first fully automated release

The first release published entirely through protected CI with npm trusted publishing (OIDC) and signed provenance. It also ships the fixes that made that pipeline reliable:

- **npm 11 install-script gate:** the release-time runtime test now installs the pinned `opencode-ai@1.18.30` package as a real dependency, since npm 11 blocks dependency install scripts by default. `v0.1.1` was tagged but never published because its gate correctly stopped on exactly this.
- **Hermetic safety gates:** Git capability detection reads repository-local state only, so machine-specific Git config on a runner or host cannot add phantom approval requirements to a migration.
- **Cleaner run control:** durable migrations require a user-created linked Git worktree; outside a Git repo only the no-write dry-run inventory is offered. Risk decisions now honor the latest recorded verdict, so a paused or blocked risk that is later approved resumes without a fresh run.
- **Docs and metadata hygiene:** public docs use placeholder syntax for user-supplied values, wording is tightened, and package metadata is scrubbed of personal details.

## v0.1.0 — initial public release

## What this is

An evidence-driven Ruby and Rails upgrade agent for [OpenCode](https://opencode.ai). It upgrades a project one Ruby minor series at a time toward a researched latest-stable or explicitly pinned Ruby target, with every hop validated before it is committed and a reviewable trail left behind.

## What's new in this release

- **Guided migration loop:** inventory the project, research an official-source compatibility ladder, validate each hop in an isolated Docker container running the project's real test command, and propose a local checkpoint commit with the validation receipt digest embedded in the commit message.
- **Rails bridge support:** for Rails apps, each hop runs `bin/rails app:update` with conflict-skipping behavior, presents every generated file for review before it is accepted, and records dependency-compatibility and license findings for every lockfile change.
- **Evidence trail:** JSON and Markdown reports under `.ruby-upgrades/runs/` (openable as an Obsidian vault), a local-only read-only dashboard on `127.0.0.1`, and receipt digests in every checkpoint commit trailer.
- **Safety model:** the agent runs only in a user-created linked Git worktree, fails closed unless the default branch is configured explicitly, and pauses — with evidence and options — before anything sensitive: data changes, authentication/authorization, payments, secrets, production configuration, framework-major upgrades, private dependencies, native extensions, or failed validation. It never pushes, merges, reconfigures branches, or runs destructive commands.

## Proof of work

The agent completed a full end-to-end migration against the public `lilla021/ruby2-rails4-bootstrap-heroku` fixture (BSD-2-Clause): **Ruby 2.4.10 / Rails 4.2.11.3 → Ruby 3.4.10 / Rails 7.1.6** in 15 receipt-backed hops. Each hop was validated by `bundle exec rspec` in an isolated Docker container before its local checkpoint commit. The full migration is visible in [pull request #1](https://github.com/lilla021/ruby2-rails4-bootstrap-heroku/pull/1) with lint and spec checks passing on GitHub Actions. Per-hop receipts and fixes are recorded in [E2E_EVIDENCE.md](E2E_EVIDENCE.md).

## Getting started

See [README.md](README.md#quick-start): from a linked Git worktree with `opencode-ruby-upgrader.defaultBranch` configured, launch OpenCode and run `/ruby-upgrade`. Use `--dry-run` for a no-write assessment first.

Requirements: Git 2.5+; Docker when your host cannot run the Ruby version being upgraded (used for the isolated validation container).

## Supported projects

Bundler projects using Rails, RSpec, or Minitest get the full automatic flow (inventory, ladder, validated hops, checkpoints). Other stacks receive an inventory and require a user-supplied validation command.

## Known limitations

- The credential scanner is heuristic; it recognizes common token formats but may miss unusual forms.
- Run reports are local mutable JSON evidence; their integrity is bounded by your local filesystem permissions, not a tamper-proof store.
- The agent validates tests and compatibility, not production behavior, security correctness, or deployment safety — review and push are always your step.
- Gemfile source detection is static and may not resolve dynamically computed sources; private sources require explicit review and approval.

## Rollback

Every validated hop is a separate local commit carrying its validation receipt digest. Undo one hop with `git revert <hop-sha>`; inspect the trail with `git log` and the dashboard before any push. Do not use reset, rebase, or force-push as routine recovery.

## License

MIT.
