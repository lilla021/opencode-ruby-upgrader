# opencode-ruby-upgrader — v0.1.0 release notes

## What this is

An evidence-driven Ruby and Rails upgrade agent for [OpenCode](https://opencode.ai). It upgrades a project one Ruby minor series at a time toward a researched latest-stable or explicitly pinned Ruby target, with every hop validated before it is committed and a reviewable trail left behind.

## What's new in this release

- **Guided migration loop:** inventory the project, research an official-source compatibility ladder, validate each hop in an isolated Docker container running the project's real test command, and propose a local checkpoint commit with the validation receipt digest embedded in the commit message.
- **Rails bridge support:** for Rails apps, each hop runs `bin/rails app:update` with conflict-skipping behaviour, presents every generated file for review before it is accepted, and records dependency-compatibility and license findings for every lockfile change.
- **Evidence trail:** JSON and Markdown reports under `.ruby-upgrades/runs/` (openable as an Obsidian vault), a local-only read-only dashboard on `127.0.0.1`, and receipt digests in every checkpoint commit trailer.
- **Safety model:** the agent runs only in a user-created linked Git worktree, fails closed unless the default branch is configured explicitly, and pauses — with evidence and options — before anything sensitive: data changes, authentication/authorization, payments, secrets, production configuration, framework-major upgrades, private dependencies, native extensions, or failed validation. It never pushes, merges, reconfigures branches, or runs destructive commands.

## Proof of work

The agent completed a full end-to-end migration against the public `lilla021/ruby2-rails4-bootstrap-heroku` fixture (BSD-2-Clause): **Ruby 2.4.10 / Rails 4.2.11.3 → Ruby 3.4.10 / Rails 7.1.6** in 15 receipt-backed hops. Each hop was validated by `bundle exec rspec` in an isolated Docker container before its local checkpoint commit. The full migration is visible in [pull request #1](https://github.com/lilla021/ruby2-rails4-bootstrap-heroku/pull/1) with lint and spec checks passing on GitHub Actions. Per-hop receipts and fixes are recorded in [E2E_EVIDENCE.md](E2E_EVIDENCE.md).

## Getting started

See [README.md](README.md#quick-start): from a linked Git worktree with `opencode-ruby-upgrader.defaultBranch` configured, launch OpenCode and run `/ruby-upgrade`. Use `--dry-run` for a no-write assessment first.

Requirements: Git 2.5+; Docker for legacy Ruby hops (used for the isolated validation container).

## Supported projects

Bundler projects using Rails, RSpec, or Minitest get the full automatic flow (inventory, ladder, validated hops, checkpoints). Other stacks receive an inventory and require a user-supplied validation command.

## Known limitations

- The credential scanner is heuristic; it recognises common token formats but may miss unusual forms.
- Run reports are local mutable JSON evidence; their integrity is bounded by your local filesystem permissions, not a tamper-proof store.
- The agent validates tests and compatibility, not production behavior, security correctness, or deployment safety — review and push are always your step.
- Gemfile source detection is static and may not resolve dynamically computed sources; private sources require explicit review and approval.

## Rollback

Every validated hop is a separate local commit carrying its validation receipt digest. Undo one hop with `git revert <hop-sha>`; inspect the trail with `git log` and the dashboard before any push. Do not use reset, rebase, or force-push as routine recovery.

## License

MIT.