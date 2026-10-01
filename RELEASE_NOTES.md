# opencode-ruby-upgrader — release notes

## v0.1.7 — isolated MySQL runtime

The isolated validation runtime can now prepare MySQL as well as PostgreSQL.

**Scope**

- `prepare-target-runtime` accepts `--database postgres|mysql`. Without it, the engine is detected from `Gemfile`, `Gemfile.lock`, and `config/database.yml`; `mysql2` selects MySQL, PostgreSQL declarations select PostgreSQL, no declaration defaults to PostgreSQL, and a project declaring both engines stops and asks for an explicit choice instead of guessing.
- MySQL uses `mysql:8.4` with an empty root password inside the per-run network. Readiness is probed over TCP, because the official entrypoint briefly runs a socket-only server that answers `ping` before the network path works. The test database is created by the container's own client, so preparation never depends on a driver being compiled first.
- Only `mysql2` is supported. The legacy `mysql` adapter and `trilogy` are deliberately not recognized: this runtime emits `mysql2://` URLs, and claiming other drivers would produce a runtime that provisions successfully and then fails to load the adapter.
- The runtime manifest now records the selected engine, the database container, and a second image ID for the database alongside the Ruby image ID. Validation attests both, and Docker receipts record the run identity, container IDs, image IDs, and network ID.
- Ownership is bound to the worktree: resources carry the run ID and a SHA-256 hash of the canonical worktree path, and validation recomputes that hash to compare against the live container labels instead of trusting a value persisted in `runtime.json`. Binding to the running resources is the stronger check — a copied manifest cannot vouch for a foreign worktree — and it keeps a guessable fingerprint of the user's filesystem path out of a file intended to be committed. Legacy version-2 PostgreSQL manifests migrate in place when the existing app container proves the mount, and resources from another run or worktree are refused rather than reused or deleted.
- Isolation checks are now fail-closed. Validation rejects extra network attachments, published ports, privileged mode, unexpected mounts or commands, unexpected containers on the run network, and database containers with bind mounts — the properties that make a credential-free database safe to expose only to the app container.

**Evidence**

`npm run test:docker:mysql` provisions a real MySQL container, prepares the runtime, connects from a throwaway Rails app through its own `mysql2` driver, asserts a passing RSpec receipt and a secret-free persisted manifest, and verifies it left no resources behind. This is real container evidence, not a mocked unit test; the fixture is generated and deleted by the script. CI runs it on every pull request via the `mysql-runtime` job, and `release.yml` runs it again before publishing.

**Known limitations**

- Prepared containers, networks, and images are not torn down when a run completes or is paused. They persist for reproducibility and are removed manually; the names are recorded in `.ruby-upgrades/runtime.json`.
- Detection is static text matching. A dynamically computed adapter, or a project whose test environment differs from its other environments, may need an explicit `--database`.
- No teardown command exists yet; cleanup is documented rather than automated.

## v0.1.6 — reader path and CI coverage

No runtime change. The agent's commands, permission policy, commit gate, and report format are untouched. This release restructures the public documentation and closes a CI coverage gap.

**Scope**

The README was reordered into a reader-state funnel — install, run it small, does it work, what it refuses, what backs that, what you get, how to recover, what it cannot prove — so each section answers the question a reader has at that point:

- `Install` is now first and reads as three numbered steps. It previously arrived fifth, with nothing earlier stating that this package is an OpenCode plugin.
- `Security boundaries` now sits directly after `Safety model`. Intent and enforcement are halves of one argument and had been separated by two unrelated sections.
- The pre-flight flags split out of the recovery material into `Before you run it`, immediately after Quick start where `--dry-run` is first mentioned.
- A new `Requirements` section carries the Node/Git/Docker floors and moves the supported-adapter qualification from position ten to before a reader creates a worktree.
- A new `Troubleshooting` section collects the `EBADENGINE` warning, a missing `/ruby-upgrade` command, and uninstall.
- A new `Privacy` section gives the previously unlinked `PRIVACY.md` and `SECURITY.md` an entry point in the packaged README.
- `Contributing` is separated from `Product limits`, so maintainer test instructions no longer sit inside an end-user section.
- Install now covers the OpenCode prerequisite and config registration for readers new to OpenCode, verified against the current plugin documentation.
- `Proof of work` is renamed `Validated end-to-end run`.
- Long paragraphs in `Safety model` and `Security boundaries` are split, and the agent's prohibitions are now a list.
- The Rails-bridge lifecycle moves to a standalone [`docs/rails-bridge.md`](docs/rails-bridge.md) reference, so `Recovery` ends on the `git revert` guidance instead of burying it.
- README links to companion documents and both screenshots are now pinned to the release tag instead of resolving against `main`. The registry page previously showed whatever `main` happened to contain, which could drift ahead of the installed version. The release gate now repoints them each release.

**CI**

`ci.yml` runs the test suite, pack check, and pinned-runtime smoke test across Node 22, 24, and 26. CI previously exercised Node 22 only while `engines.node` declared `>=22.5.0`, leaving most of the advertised support range untested. Both workflows pin `npm@11.16.0` so the matrix varies Node rather than npm. Publishing remains a single Node 22 job in `release.yml`, since every matrix leg would attempt the same version.

**Supported adapters:** unchanged — Bundler projects using Rails, RSpec, or Minitest; other stacks receive an inventory and require a user-supplied validation command.

**Known limitations:** unchanged. The credential scanner remains heuristic and reports remain local mutable JSON, bounded by the user and local filesystem permissions. See Product limits in the README.

**Rollback:** `npm install opencode-ruby-upgrader@0.1.5`. The command surface and on-disk format are identical across this release, so no report conversion is required.

Published through the same protected-CI gate.

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
