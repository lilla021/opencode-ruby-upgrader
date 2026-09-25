# End-to-End Fixture Evidence

This file records reproducible validation of the packaged plugin against a disposable, publicly licensed Rails fixture. It is not a claim that arbitrary Ruby or Rails upgrades are safe.

## At a glance

- **Outcome:** the fixture now runs at the pinned target **Ruby 3.4.10 / Rails 7.1.6** (from Ruby 2.4.10 / Rails 4.2.11.3).
- **How:** 15 receipt-backed hops (8 Ruby, 7 Rails-bridge), each validated with `bundle exec rspec` in an isolated Docker container before its local checkpoint commit.
- **Where:** branch `ruby-upgrade/e2e-3.4` of the fixture repo, as [pull request #1](https://github.com/lilla021/ruby2-rails4-bootstrap-heroku/pull/1) — GitHub Actions lint and Ruby-spec checks currently pass.
- **Baseline:** fixture commit `bad95e2be88687f5d185c29a2361526fa05b8f54` (BSD-2-Clause).

The sections below record each stage of that work, including the deliberate stops, defects found in the agent itself, and the fixes. What this does and does not prove is summarised in [Evidence limits](#evidence-limits).

## Fixture contract

- **Repository:** `https://github.com/lilla021/ruby2-rails4-bootstrap-heroku` (fork of `diowa/ruby2-rails4-bootstrap-heroku`)
- **Fixture commit:** `bad95e2be88687f5d185c29a2361526fa05b8f54`
- **License:** BSD-2-Clause
- **Baseline:** Ruby `2.4.10`, Rails `4.2.11.3`, Bundler lockfile `1.17.3`
- **Disposable worktree branch:** `ruby-upgrade/e2e-3.4`
- **Plugin under test:** record the reviewed plugin commit SHA and packed tarball integrity before each run.

## 2026-09-17 host preflight

| Check | Result |
| --- | --- |
| Linked-worktree preflight | Passed after configuring `opencode-ruby-upgrader.defaultBranch=main` locally in the fixture repository. |
| Plugin dry-run inventory | Passed: Rails/RSpec detected; Ruby `2.4.10`; Rails `4.2.11.3`; 118 locked dependencies; no detected private sources. |
| Host runtime | Blocked as expected: host Ruby is `2.6.10`, but fixture requires `2.4.10`; installed Bundler is `1.17.2`, while the lockfile specifies `1.17.3`. |
| Dependency install / test suite | Not run. A container or version manager providing the exact historical runtime is required. |
| Container runtime | Blocked: Docker CLI was installed, but the local Docker daemon was unavailable; no containers or fixture code were started. |

## 2026-09-18 container baseline

| Check | Result |
| --- | --- |
| Ruby container | In progress using the pinned `ruby:2.4.10` image against the disposable fixture worktree. |
| Bundler | `1.17.3` was installed in the container and dependency setup proceeded to the database task. |
| `bundle exec rake db:create` | Blocked before database creation: Rails/ExecJS reported `Could not find a JavaScript runtime.` The fixture has asset gems that require ExecJS but declares no JavaScript runtime. |
| Runtime-package setup | Initial `apt-get update` failed as expected for the end-of-life Debian Buster base: the former `security.debian.org` and `deb.debian.org` Buster release endpoints returned HTTP 404. No packages were installed. |
| Remediation | Pending: point APT in this disposable container only at Debian's signed Buster archive, install a JavaScript runtime (Node.js), record its exact version, then rerun the unchanged database command. No fixture source or lockfile change is authorized for this environment prerequisite. |

Do not treat this as an application or plugin failure until the pinned runtime prerequisite has been supplied and the command has been rerun. Record the command result, timestamps, exit code, sanitized output digest, and worktree fingerprint after the rerun.

## 2026-09-18 baseline RSpec

| Check | Result |
| --- | --- |
| Initial RSpec execution | Reached RSpec after the JavaScript-runtime remediation, then stopped in `before(:suite)` before any examples ran. |
| DatabaseCleaner safeguard | Blocked truncation because the container database URL uses the Docker service hostname rather than `localhost`/`127.0.0.1`. Result: 0 examples, 0 example failures, 1 setup error. This is an expected topology-recognition safeguard, not a test assertion result. |
| Scoped remediation | The database hostname was verified as the expected isolated Docker service. RSpec was rerun for that process only with `DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL=true`; fixture specs and persistent configuration were unchanged. |
| Baseline RSpec result | Passed: 1 example, 0 failures; randomized seed `26029`; total execution 26.17 seconds after 18.04 seconds of file loading. The `Welcome Index has application name in title` feature example took 25.98 seconds. |
| Coverage result | SimpleCov generated `/app/coverage` and reported 100.0% line coverage (8/8) for the exercised fixture code. |

The terminal transcript did not preserve start/finish timestamps or a sanitized-output SHA-256 for this manually executed baseline. Treat the result as successful baseline evidence with that metadata gap; capture the complete receipt metadata through the plugin executor before any checkpoint.

## Receipt-executor environment gap

The current plugin executor intentionally permits only fixed, host-executed argv such as `bundle exec rspec`; it does not support Docker execution. The host Ruby/Bundler do not satisfy this fixture's pinned Ruby `2.4.10` / Bundler `1.17.3` baseline, while the passing baseline command ran inside an isolated container. Therefore this manual baseline must not be represented as a plugin-generated validation receipt and cannot authorize a checkpoint. A completed package E2E must either provide a constrained, receipt-producing container executor or run the fixed executor in a host environment that exactly satisfies the fixture runtime contract.

The local package worktree now contains a constrained `docker-bundle-rspec` executor and regression coverage. It inspects a named running container, requires the fixture worktree to be bind-mounted at `/app`, requires `RAILS_ENV=test` plus `DATABASE_URL`, and executes only fixed Docker argv ending in `bundle exec rspec`. It records container image metadata and a redacted output digest in the receipt. `npm test` passed 32/32 after this change. This is implementation evidence only; the adapter has not yet been exercised against the fixture through the OpenCode runtime, so no plugin-generated fixture receipt exists yet.

## 2026-09-18 OpenCode preflight — blocked, recoverable

An explicit local-plugin preflight returned `ok: false` with `reason: "dirty-worktree"` for branch `ruby-upgrade/e2e-3.4` at fixture commit `bad95e2be88687f5d185c29a2361526fa05b8f54`; its configured default branch was correctly detected as `main`. The only observed change was an unrelated ignored local note, not fixture work. After removing that file, preflight was rerun before any plugin lifecycle action. The package was also corrected so its injected agent invokes the package-local Node CLI rather than assuming the package binary is globally on `PATH`; `npm test` remained 32/32 and `git diff --check` passed after that correction.

## Fixture reset attempt

The disposable worktree was recreated at the pinned baseline and the PostgreSQL/Ruby containers were recreated. The first rerun of `bundle exec rake db:create` again stopped at `ExecJS::RuntimeUnavailable`. This is not yet evidence of a fixture change or database failure: the container must first prove that the installed Node.js package exposes an executable name discoverable by ExecJS (`node`). The next diagnostic records only runtime command availability/version; no Gemfile, lockfile, or application configuration change is authorized.

After installing Node.js in the recreated container, `bundle exec rake db:create` completed. Rails emitted the legacy `PGconn`, `PGresult`, and `PGError` deprecation warning from the pinned Rails 4.2 / PostgreSQL adapter stack; the test database `ruby2-rails4-bootstrap-heroku_test` was confirmed to already exist. Treat this as a successful environment/database prerequisite with a known historical dependency warning, not as an application test result.

The rebuilt baseline RSpec command then passed with the Docker-only DatabaseCleaner safeguard override: 1 example, 0 failures, seed `10316`, 25.08 seconds total after 17.49 seconds loading files. The `Welcome Index has application name in title` feature example took 24.89 seconds. SimpleCov generated `/app/coverage` and reported 100.0% line coverage (8/8) for the exercised fixture code. The Rails 4.2 PostgreSQL-constant deprecation warning repeated during test loading; no test assertion failed.

After the reset, local plugin preflight passed with `ok: true` in linked-worktree mode for `ruby-upgrade/e2e-3.4` at `bad95e2be88687f5d185c29a2361526fa05b8f54`. The fixture worktree was clean; its Git worktree metadata was distinct from the primary checkout's common Git directory.

## 2026-09-18 plugin no-write plan

The `/ruby-upgrade --dry-run --target 3.4` workflow completed without creating files, locks, or commits. It detected Rails `4.2.11.3`, Ruby `2.4.10`, RSpec (`bundle exec rspec`), 118 Rubygems-only dependencies, and standard Git topology (no shallow clone, sparse checkout, submodules, or LFS). It pinned Ruby `3.4.10` for the requested Ruby 3.4 target and planned contiguous Ruby series `2.5 → 2.6 → 2.7 → 3.0 → 3.1 → 3.2 → 3.3 → 3.4`. The plan correctly requires official Rails/Ruby compatibility research and warns that Rails 4.2 may require a separately approved Rails bridge. This is no-write planning evidence, not a validation receipt or checkpoint.

## Research lifecycle defect and correction

A durable research-only run was created and safely paused without fixture edits, dependency changes, tests, or checkpoints. It correctly retained official Ruby/Rails citations but exposed a state-machine defect: the Ruby ladder validator rejected the valid published `2.7 → 3.0` transition by assuming every hop increments only the minor number. The package now permits the known Ruby major-series boundaries `2.7 → 3.0` and `3.4 → 4.0`, while retaining rejection of an invalid `2.6 → 3.0` skip. A regression test covers both the valid and invalid cases; `npm test` passed 33/33 and `git diff --check` passed. The paused fixture report must be resumed under the reloaded local plugin before recording its ladder.

The first resume attempt exposed a second lifecycle defect: preflight treated the plugin's own uncommitted `.ruby-upgrades/runs/...` durable report as a dirty worktree and therefore prevented resume. Preflight now excludes only `.ruby-upgrades` from its worktree-dirt check, matching the evidence exclusion already used by the receipt fingerprint. It continues to reject ordinary project or unrelated untracked changes. A regression test proves both behaviors; `npm test` again passed 33/33 with `git diff --check` clean. Reload the local plugin before resuming the paused fixture report.

After reload, the fixture run resumed successfully and was paused again at `research_complete`. Its durable report is `.ruby-upgrades/runs/2026-09-19T02-11-30-339Z-e27e872c-89d8-45e6-912a-246275fc00fc.json`; it records the full Ruby ladder `2.4 → 2.5 → 2.6 → 2.7 → 3.0 → 3.1 → 3.2 → 3.3 → 3.4`, official Ruby release citations, and the endoflife.date cross-check. No project file edits, test executions, or checkpoints occurred in this research-only lifecycle.

The paused run then recorded a Rails compatibility decision for Ruby `2.4 → 2.5`: Rails `4.2.11.3` does not declare an upper Ruby bound and its gemspec declares Ruby `>= 1.9.3`, so no Rails bridge is required for this first hop. Evidence links the Rails 4.2.11.3 gemspec, Rails 4.2 release notes, and Rails maintenance policy. Rails 4.2 end-of-life remains a later migration risk. No application files, tests, or checkpoints were created by this decision.

When authorized to begin the first hop, the agent paused before edits because the selected validation container was still pinned to Ruby `2.4.10`, not the proposed target Ruby `2.5.9`. It correctly refused to use the baseline runtime as target-runtime validation evidence. No project files, dependency changes, validation receipts, or checkpoints were created. A separate Ruby 2.5.9 test container, bound to the same fixture worktree and isolated PostgreSQL service, is required before the hop can proceed.

## Guided Docker runtime preparation — implementation verified

Manual target-container setup was identified as unacceptable normal-user UX. The local package now provides a confirmation-gated `prepare-target-runtime --ruby <x.y.z>` path that derives the single active/paused run, creates per-run labelled Docker network, PostgreSQL, and Ruby containers with fixed argv, bootstraps Node.js, Bundler `1.17.3`, dependencies, and the isolated Rails test database, then persists only non-secret runtime identity and preparation digests in `.ruby-upgrades/runtime.json`. It attests the exact Ruby version and resolved image ID, and the Docker RSpec executor revalidates that manifest rather than accepting container names or environment variables from the user. Regression coverage covers provisioning, secret exclusion, Ruby/image attestation, mutable-image drift, manifest-backed validation, ambiguity, and removal of the environment-variable route. `npm test` passed 37/37; both staged and unstaged diff checks passed. This feature has not yet been exercised in the fixture runtime.

After reset, the normal `/ruby-upgrade --target 3.4` entry point completed preflight, inventory, target pinning, and ladder planning, then paused with a single plain-language approval request for isolated Ruby `2.5.9` runtime preparation. It created report `.ruby-upgrades/runs/2026-09-19T03-01-16-089Z-b8999214-ad0e-4cea-abb1-8f3501e4f1c7.json`; no user-supplied report path, container name, or Docker environment variable was required. Guided runtime preparation remains pending fixture execution.

The first guided preparation attempt paused safely before fixture edits when PostgreSQL startup and historical dependency bootstrap exceeded the agent's default 120-second command limit. This exposed a UX defect: preparation must own long-running readiness/bootstrap behavior rather than delegate Docker troubleshooting to the user. The local implementation now derives the image Debian codename for its archived Node.js setup instead of assuming Stretch, and directs the agent to use a preparation timeout of at least 15 minutes. `npm test` remained 37/37 with a clean diff check. The fixture preparation must be retried under the reloaded local plugin.

A later retry session found no durable report under `.ruby-upgrades/runs/`, so preparation correctly made no Docker or fixture change but incorrectly asked the user to restore/provide an internal report path. Agent guidance now treats absent local evidence as a normal restart condition: it directs the user to the public `/ruby-upgrade --target <version>` entry point instead of exposing internal state-management details.

On the subsequent normal entry-point retry, preflight, version pinning, exact patch ladder, research, and a new paused durable report succeeded. The agent then incorrectly treated the report it had just created under `.ruby-upgrades` as an untracked-worktree blocker. Agent guidance now explicitly excludes only this plugin-owned evidence directory from its clean-tree review and continues to stop for all other project changes.

When preparation was approved, multiple paused reports caused another internal-state leak. Target-runtime preparation now accepts the report path held by the agent internally and validates it is active/paused; agent guidance retains stale evidence but selects the most recently started paused report matching the current branch and target. The user is never asked to identify a report, run ID, container, or manifest. Package regression tests passed 37/37 after this correction.

## Receipt-backed Ruby 2.5.9 hop — validated, not committed

The newest paused run was resumed and selected internally. Real fixture execution exposed and corrected four preparation defects: PostgreSQL readiness was checked only once; retry without a manifest replaced the app container and discarded native-gem build progress; dependency bootstrap ran before changing the mounted Gemfile's Ruby declaration; and Docker RSpec omitted the process-scoped DatabaseCleaner override required for the verified isolated database hostname. Regression coverage now includes retry reuse; the package suite passes 38/38 with a clean diff check.

After changing only `Gemfile` (`2.4.10` → `2.5.9`) and the lockfile `RUBY VERSION` (`ruby 2.4.10p364` → `ruby 2.5.9p229`), guided preparation completed. It attested image `ruby:2.5.9` at `sha256:ecc3e4f5da13d881a415c9692bb52d2b85b090f38f4ad99ae94f932b3598444b`; Node, Bundler 1.17.3, dependency installation, database creation, and Ruby-version outputs are represented only by SHA-256 and byte-count metadata in `.ruby-upgrades/runtime.json`.

Plugin-generated validation receipt `8fbc107c-ed9f-4324-800d-10856a57a114` passed with fixed command ID `docker-bundle-rspec`: 1 example, 0 failures, 33.977 seconds, exit code 0, no timeout, redacted-output SHA-256 `7377bab5fb106b6c2fb5069e9dba35a3330a11fa1a4f2a3f60c54733c481aeaf`, and worktree diff fingerprint `1f2d8c27dce4994cffa4b02419e7933b8605e53bac5d6cdec59d9cf90ebef12d`. The existing browser-backed Welcome feature supplied the smoke coverage. The report reached `hop_validated` and was paused; no checkpoint commit was created.

The user then approved a local checkpoint. Real gate execution exposed two further defects: unrelated local `.ruby-upgrades` artifacts were staged alongside active evidence, and the official `https://rubygems.org/` lockfile remote was falsely classified as private due to regex backtracking. The gate now unstages machine-local/stale evidence while retaining the active report and still rejecting undeclared project changes; lockfile remotes are explicitly extracted and exactly allowlisted. Regression coverage raised the package suite to 40/40. The guarded checkpoint succeeded at `e0fb0d2f7494d10cf22a73512efa1b7584bf89d0` with validation receipt digest `c77987568ea05855e451b179892376f0ec751ff459c0dba53588edfd47e11821`; no push occurred.

The next Ruby `2.5.9 → 2.6.10` hop then prepared image `ruby:2.6.10` at `sha256:a79c8ddb7f3d3748427e2d3a45dcae6d42f1d80d9ae3b98959b3a27b220bf434`. Only `Gemfile` and lockfile Ruby-version metadata changed. Receipt `a34b712a-beba-40d5-ac14-0ced29f24221` passed: 1 example, 0 failures, 38.87 seconds, exit code 0, no timeout, redacted-output SHA-256 `f79604368abd773589f733c5a408f73a4eab37ddf99c93a81dd79ebc1ee78db5`, and worktree diff fingerprint `2c2f9b3a8c0609c4f0b3562bbfd91826c699ab9c3724fa5a5b7fc9c7f95a75dc`. The run is paused at `hop_validated`; this second hop is not committed.

After approval, the second guarded checkpoint succeeded at `e8e1ce821033336c7ac68dc9082f595ff43453e5` with validation receipt digest `e55f6f03c0c34891e74e8f305ddba05149255c907cd9ea20ee78d9500eed34ab`; no push occurred. The next Ruby `2.6.10 → 2.7.8` preparation installed dependencies but failed during Rails test-database initialization: Rails `4.2.11.3` invokes removed `BigDecimal.new` while booting under Ruby 2.7.8. No validation receipt or checkpoint was created for Ruby 2.7.8. The attempted Gemfile and lockfile runtime declarations were reverted to checkpointed Ruby 2.6.10, and the run was safely paused pending an explicitly scoped Rails bridge decision.

The user approved a separate Rails `4.2.11.3 → 5.2.8.1` bridge through `5.0.7.2` and `5.1.7`. The Ruby report was marked terminal `blocked`, and Rails bridge report `.ruby-upgrades/runs/2026-09-23T04-47-06-275Z-e4485288-4c7f-4271-9345-e6dd7066618f.json` was initialized with the official Rails upgrade guide and Rails 5.2.8.1 gemspec citations. Package lifecycle changes allowing post-checkpoint bridge creation and Docker-executed `app:update` passed 41/41 tests.

For the first Rails hop, focused `bundle update rails` resolved Rails `5.0.7.2` but also updated expected transitive framework dependencies. Receipt `53b0e092-d6a4-43af-88b6-6df300535bfa` records successful Docker execution of `bin/rails app:update` in 13.99 seconds, output digest `c288def7b0293a656dafec571d3a4a6413c72ec02042ca466403a47e96ee732a`, and worktree fingerprint `85214e8f9bed2f509fb7cc136890da453c1171e188f64e008e46d142e2d9846c`. Review found unsafe noninteractive overwrites across routes, production SSL/logging, secrets, Puma, environments, initializers, and generated framework files (24 tracked files plus new files). No app-update review approval, final test receipt, or Rails checkpoint exists. This demonstrates that noninteractive conflict handling must be redesigned before Rails bridge automation can be considered safe.

The unsafe project diff was fully reverted, and the bridge report durably retained that receipt under `discardedAppUpdates` with the review reason rather than silently replacing the evidence. The package now exposes a confirmation-gated discard command. Rails 5.0 implements `app:update` as a Rake task and rejects a generic `--skip` option, so the executor now invokes the same Rails app generator directly with Thor `behavior: :skip`. This preserves every existing application file while generating only missing framework files. Regression assertions cover the fixed Docker argv, skip behavior, discard permission, and package suite; `npm test` passes 41/41 and `git diff --check` is clean.

The clean Rails `4.2.11.3 → 5.0.7.2` retry produced app-update receipt `da7a0510-6cac-4ac4-9a83-a6b517f140d9`, exit code 0, 7.363 seconds, redacted-output SHA-256 `db58f370856adee17daa5cf88a85855a7f9e0774714e56e4862f5a0041761edf`, and review fingerprint `aefd04b0f1ea83f6b191cb5e865108b5879a175b82eb1c7f47646091036e5f5b`. Review accepted only five missing Rails 5 files: `bin/update`, `config/cable.yml`, `config/spring.rb`, `config/initializers/application_controller_renderer.rb`, and `config/initializers/new_framework_defaults.rb`; no existing application configuration was overwritten. Because the newly resolved Sprockets 4 requires an explicit asset graph that the older Rails 5.0 template predates, the hop also adds `app/assets/config/manifest.js`.

Final receipt `faff9f6d-5771-4cf9-9d68-7e138a6b0504` then passed in the attested Ruby `2.6.10` container: 1 example, 0 failures, 57.247 seconds, exit code 0, no timeout, redacted-output SHA-256 `e09e7eeaa0e55f9e2204046ddce004933d906140b5a8ab3e40243f92c2b4c257`, and final worktree fingerprint `7e2c0cd085e3ba91bf9a058b5a4282c6b3ca57b5c99564ff34eb18c5ee68031b`.

The first commit attempt was correctly blocked because compatibility and license findings for the changed lockfile had not been durably recorded. The package now provides a lock-bound `record-dependency-review` operation that is valid only for the latest validated, uncommitted hop; regression coverage raised the suite to 42/42. After recording fixture-scoped compatibility findings, the public Rubygems-only source review, and the absence of an automated license-audit adapter, the guarded local checkpoint succeeded at `44f92460c11c05a4e907c9960cb65fbbe72debc5` with validation receipt digest `91ed1c19bd7bb5d6ff90a43c8312918aea6d15b7b37ae7b295a493c4427995a3`. The bridge is now at `committed`; no push occurred.

The Rails `5.0.7.2 → 5.1.7` hop resolved the contiguous framework set and ran conflict-skipping app update receipt `8485c0d2-b62c-4f7e-b6e7-95656a47c60d`: exit code 0, 7.510 seconds, output digest `2da549a660f7e340732998573f4fa2df663a241cb142a4faf40b7131d102cd9d`, and review fingerprint `cd240f05337001bd7a8f3bb596aa65c52e9ec8e24f19e01a8feb6676f23178bf`. Review accepted only the missing `bin/yarn` and `config/initializers/new_framework_defaults_5_1.rb`; all existing configuration was preserved. The first final test exposed the Rails 5.1 removal of `ActiveRecord::Base.raise_in_transactional_callbacks=`. Removing that obsolete fixture setting from `config/application.rb` restored boot.

Final receipt `3a207665-b8dd-4f9b-8343-8607f4a12e61` passed: 1 example, 0 failures, 69.413 seconds, exit code 0, no timeout, output digest `f3a91b6d4fec5e9e22e4e77c277e22782c68d033391deccf50b2b5d22ee185ff`, and final fingerprint `253a03fc5ef01166f73668793c9bea730fe7554fd522f06544880ca2a55c7e9a`. Dependency compatibility and fixture-scoped license findings were recorded. The guarded local checkpoint succeeded at `a7225de6a5daed2137da51277248ace2eced3872` with receipt digest `411552bed8bb71e809fde666def39889931edea812aef37bfde00ffe3d33c945`; no push occurred.

The Rails `5.1.7 → 5.2.8.1` app-update receipt `53e7bed3-7590-49df-8ef1-e05a876a1ead` completed in 10.169 seconds with output digest `27c41213cbfd9bb86ec11ddf3fb69cbe7fba21c7cc31f2fd405827d649d0d6e9` and review fingerprint `34dd27ab4bb00fab5b2ec940754d24d1dc98388e06343e6f7c6574eb414e3c1b`. Review accepted only new CSP, Rails 5.2 defaults, and Active Storage templates. Initial final tests exposed and then removed two obsolete Rails 5.0 compatibility settings: `halt_callback_chains_on_return_false` and `raise_on_unfiltered_parameters`. No existing configuration was overwritten by the generator.

Final receipt `89309588-9032-428d-b05a-895f2c54445d` passed: 1 example, 0 failures, 44.382 seconds, exit code 0, no timeout, output digest `085418c713d7941e6bf4b2b9456bb4a17baa98b3c9f9cb376a7d8396e09a7ca7`, and final fingerprint `f3a755912c3bd311d067d74017822a067e18ddafcc79b9296afdda6a34ece969`. Dependency findings were recorded. The final guarded checkpoint succeeded at `9cc80923ea7a08fcaa8bcf8cf627ca38a72324b5` with receipt digest `b71e2c9f82cc7b4b7d3ff12eb640843d8adffa005a3cc2357cfae531e6822f53`. The Rails bridge is terminal `complete` at Rails `5.2.8.1`; no push occurred.

## 2026-09-24 Rails bridge completion: 5.2.8.1 → 7.1.6

The Ruby run previously blocked at Ruby 3.0.7 because Rails 5.2 cannot boot on Ruby 3.0. A separate Rails bridge run (`2026-09-24T02-48-20-249Z-3047fe86-7e3d-4d49-9226-2836c7418441.json`, runId `41f40bc2-9321-483a-afc7-3e1266a5e99d`) carried the framework set to `7.1.6` in four receipt-backed hops, all validated in the Ruby 2.7.8 container.

**Hop 5.2.8.1 → 6.0.6.1** (checkpoint `cbb0805dc037ad3f40fb8e157ac543768a623b25`): `app:update` exposed a real Rails-6 load-order defect — `ActiveSupport::LoggerThreadSafeLevel` evaluates `Logger::Severity` before `require "logger"`. Fixed via `gem "logger", "~> 1.4"` plus `require "logger"` in `config/application.rb` (Rails 7.1 later made `logger` a permanent default). Only `new_framework_defaults_6_0.rb` was added; app-update review receipt `89dc71f7-8fc4-4b39-8b63-b04d1c09f3dc`.

**Hop 6.0.6.1 → 6.1.7.10** (checkpoint `d3cbd3bc89d72581aeb9d86a5519f24d40534d16`): Rails 6.1's pg adapter requires `pg ~> 1.1`; the fixture pinned `0.21.0`. Bumped to `~> 1.5.0` (1.6.x needs Ruby ≥ 3.0, correctly rejected). Receipts `c09af52b…` and final `e398645d-4768-491d-a1f4-13386e74a4fb` (35.445s PASS).

**Hop 6.1.7.10 → 7.0.10** (checkpoint `8aeac2a4bb8b`): forced a theme-gem swap. `twbs_sass_rails` caps at `rails < 6.2` and is unmaintained; replaced with `bootstrap-sass 3.4.1` (no Rails cap, needs `sassc ≥ 2.0`) plus `font-awesome-rails 4.7`, renaming imports (`twbs/` → bootstrap-sass conventions) and fixing an `@import "bootstrap"` self-loop by naming the local manifest `bootstrap-manifest.scss`. Rubygems.org retired its legacy Dependency API, so Bundler was raised from `1.17.3` to `2.4.22` in the container (compact-index resolution of the new gems). Final receipt c291 / `…` PASS 43.0s.

**Hop 7.0.10 → 7.1.6** (checkpoint `1579d1073c21`, final): final bridge target. `app:update` added only `new_framework_defaults_7_1.rb`. Rails 7.1 removed `ActiveRecord::SchemaMigration.table_name`, breaking `database_cleaner` 1.99; replaced with `database_cleaner-active_record 2.2.2` and explicit `require "database_cleaner/active_record"` in spec support. loofah pin loosened `~> 2.20.0` → `~> 2.25` per rails-html-sanitizer 1.6. Final receipt PASS 37.8s.

**Two genuine gate recoveries this run (both required plugin fixes, not workarounds):**
1. A stale `font-awesome-rails-4.7.0.9.gem` fetch artifact was removed from the worktree after final validation, tripping `validation-fingerprint-mismatch` — correctly, since the tree no longer matched the attested state. The state machine previously had no way back from `hop_validated` with a recorded-but-uncommitted iteration. Added a confirmation-gated, evidence-preserving `discard-last-rails-iteration` command that moves the iteration into a `discardedIterations` log and returns to `committed`; re-executing the hop re-validated cleanly and committed. Test coverage raised the suite to 43/43.
2. The `stagedSecretPaths` gate misclassified staged *deletions* as credential material (it scanned deletion entries, whose blobs no longer exist, as hits) — a false positive that would have blocked any hop deleting a file. The scanner now parses `--name-status` tokens, skips deletions, and scans only the surviving path of renames.

The Rails bridge run is terminal `complete` at Rails `7.1.6` with 4 committed checkpoints; no push occurred.

## 2026-09-24 E2E completion: Ruby 2.7.8 → 3.4.10

With Rails 7.1.6 committed, a fresh Ruby run (`2026-09-24T04-45-54-774Z-8c1fffdf-e098-4f8d-b8de-acb4dc5bf1e0.json`, runId `2cedd40f-8746-4762-9a4d-4a5557877993`) resumed the blocked ladder from the committed Ruby 2.7.8 checkpoint and carried it to the pinned E2E target **Ruby 3.4.10** in five receipt-backed hops. Every hop prepared a fresh attested container (`ruby:<ver>`, exact resolved image ID, Node.js, Bundler 2.4.22, dependency bootstrap, Rails test-database creation) and ran the Docker RSpec validation in the bind-mounted worktree.

- **2.7.8 → 3.0.7** (`ec9a1074`): no gem-set change; lockfile Ruby declaration only. Final receipt PASS.
- **3.0.7 → 3.1.7** (`f83fa8e6`): Ruby 3.1 demoted the `matrix` default gem; Capybara's `selector_query` requires it, so `matrix ~> 0.4` (0.4.3) was added to the test group.
- **3.1.7 → 3.2.11** (`1933961f`): Ruby 3.2 broke `Pry::Code`'s `=~` operator; dev/test group moved to the maintained `pry 0.14.2` line (pry-byebug 3.10.1, pry-rails 0.3.11).
- **3.2.11 → 3.3.12** (`8c30cf21`): no gem-set change; lockfile Ruby declaration only.
- **3.3.12 → 3.4.10** (`64c0b0b2`, final): Ruby 3.4 removed the `observer` default gem; `factory_bot 5.2.0` evaluation requires it, so `observer ~> 0.1` (0.1.2) was added to the dev/test group. Final Docker RSpec PASS 42.0s on the pinned target.

**Runtime-adapter fixes required during this run (with regression coverage, suite 43/43):** `prepare-target-runtime` still pinned Bundler `1.17.3`, which cannot resolve the modern compact index under Ruby 3.x; the bootstrap now installs and invokes `bundler 2.4.22` explicitly (`bundle _2.4.22_ install`). Its Debian Node.js setup hardcoded `archive.debian.org`, which serves only EOL releases; bookworm-based Ruby images (3.1.7+) fail against it, so the script now tries the live `deb.debian.org` mirror first and falls back to the archive.

The fresh Ruby run is terminal `complete` at **Ruby 3.4.10 / Rails 7.1.6** with 5 committed checkpoints; no push occurred. The E2E fixture has reached its pinned target.

## Required proof for a completed fixture run

1. Use an isolated container/VM with Ruby `2.4.10`, Bundler `1.17.3`, PostgreSQL, and the browser dependencies required by the fixture.
2. Record image digest, OS, Ruby, Bundler, Node, PostgreSQL, and plugin tarball SHA-512.
3. Run plugin preflight, inventory, supply-chain inspection, and the no-write plan.
4. Capture a baseline executed validation receipt.
5. Complete one reviewed, receipt-backed checkpoint hop; retain its report path, receipt digest, commit SHA, and trailers.
6. For a Rails bridge, retain `app:update` receipt, reviewed diff manifest, final test receipt, bridge report, and Rails checkpoint SHA.
7. Run the dashboard and confirm it renders Ruby/Rails targets, receipt metadata, and local commits without exposing sensitive values.
8. Attach only sanitized report excerpts and command metadata here. Never commit fixture credentials, raw validation output, database dumps, or browser artifacts.

## Evidence limits

The fixture proves only the recorded workflow against this pinned source tree and environment. It does not certify production behavior, security, dependency trust, deployment safety, or outcomes for another application.
