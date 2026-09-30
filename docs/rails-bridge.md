# Rails bridge lifecycle

Reference for the rare case where the next Ruby hop is blocked by the resolved Rails version. The Ruby run is **not** repaired in place: it transitions to `blocked` and becomes terminal, and a separate Rails-bridge run takes over. See [Recovery](../README.md#recovery) in the README for the general pause/resume/revert path.

## When this applies

If the Ruby version you want to reach is incompatible with the Rails version your app currently pins, the agent will not edit Rails as part of a Ruby hop. Rails changes are a framework-major migration and require an explicit, evidence-backed decision from you.

The bridge exists to keep one concern per report: the blocked Ruby report records *why* it stopped, the Rails report records *how* the framework moved.

## 1. Record the bridge, then block the Ruby run

Cite the official compatibility evidence and state the required Rails from/to versions before anything runs. Approval is required; the agent does not infer it.

```bash
opencode-ruby-upgrader record-framework-bridge \
  --report .ruby-upgrades/runs/<ruby-report>.json \
  --ruby-from <from> --ruby-to <to> \
  --rails-from <from> --rails-to <to> \
  --rationale "<why this Rails version is required>" \
  --citation 'title|https://...'
```

Then transition the Ruby run:

```bash
opencode-ruby-upgrader transition \
  --report .ruby-upgrades/runs/<ruby-report>.json \
  --phase blocked
```

**That Ruby report is terminal.** Do not attempt to resume it. Complete the Rails bridge, then start a fresh Ruby run.

## 2. Begin the Rails bridge

```bash
opencode-ruby-upgrader begin-rails-bridge \
  --ruby-report .ruby-upgrades/runs/<blocked-ruby-report>.json
```

This creates a separate report for the framework migration.

## 3. Research contiguous Rails-minor hops

```bash
opencode-ruby-upgrader record-rails-research \
  --report .ruby-upgrades/runs/<rails-report>.json \
  --ladder <version>,<version>,<version> \
  --citation 'title|https://...'
```

Each hop is one contiguous minor version. Rails does not support skipping minor series the way Ruby hops do, so the ladder is denser.

## 4. Run `app:update`, then validate

Every Rails iteration executes `bin/rails app:update` **first**, records its receipt, and reviews that exact working-tree fingerprint before final tests run.

`app:update` runs with conflict-skipping semantics, so your existing application configuration is never overwritten non-interactively. **Review every generated file** before accepting the hop.

Record the iteration with its validation ID:

```bash
opencode-ruby-upgrader record-executed-rails-iteration \
  --report .ruby-upgrades/runs/<rails-report>.json \
  --json '<iteration payload>' \
  --validation <test-id>
```

Accepted validation IDs are the fixed no-shell commands, including `bundle-rails-test`, `bin-rails-test`, `bundle-rake-test`, and `rails-app-update` for the update step itself. Asserted results cannot be recorded.

Then transition and checkpoint:

```bash
opencode-ruby-upgrader transition \
  --report .ruby-upgrades/runs/<rails-report>.json \
  --phase hop_validated

opencode-ruby-upgrader commit-rails-hop \
  --report .ruby-upgrades/runs/<rails-report>.json
```

`commit-rails-hop` is the only permitted commit path for a Rails hop. It is mutually exclusive with `commit-hop`, which is Ruby-only — the gate rejects the wrong one rather than producing a mislabelled checkpoint.

## Discarding a bad hop

If a pending `app:update` result is unsafe or superseded, revert only that unvalidated hop and discard it:

```bash
opencode-ruby-upgrader discard-pending-app-update \
  --report .ruby-upgrades/runs/<rails-report>.json \
  --reason "<review finding>"
```

The discarded digest remains durable evidence, so the report still accounts for the attempt. Use `discard-last-rails-iteration --reason "<finding>"` for a recorded iteration that turned out to be wrong.

## After the bridge completes

Start a fresh Ruby run. The new run picks up the upgraded Rails version and continues the original migration path from there.
