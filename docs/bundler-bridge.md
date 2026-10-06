# Bundler bridge lifecycle

A Bundler bridge is the mirror image of a [Rails bridge](rails-bridge.md). Where a Rails hop is blocked because the framework lags the Ruby, a Bundler hop is blocked because the project's own pinned Bundler lags the Ruby it must now run on.

## Why this exists

`Gemfile.lock` records the Bundler that wrote it under `BUNDLED WITH`, and Bundler switches to that version automatically. It is therefore the most reliable available signal for which Bundler will actually run in your project — more reliable than scanning for an installed gem.

The official compatibility guide at <https://guides.rubygems.org/bundler-compatibility/> is a table of **minimum floors**, not fixed pairings:

| Bundler | Requires Ruby | Requires RubyGems |
| --- | --- | --- |
| 4.0 | >= 3.2.0 | >= 3.4.1 |
| 2.7 | >= 3.2.0 | >= 3.4.1 |
| 2.6 | >= 3.1.0 | >= 3.3.3 |
| 2.5 | >= 3.0.0 | >= 3.2.3 |

A higher Bundler supports a *wider* range of Rubies, so moving Ruby forward essentially never forces a Bundler upgrade. Each Ruby release simply ships a matching pair as its default. The compatibility risk runs the other way: an **existing Bundler pin breaks when the Ruby moves forward**.

Two corrections worth stating plainly, because the intuitive version of this is wrong:

- "Ruby 4 requires Bundler 4" is not a constraint. Bundler 2.7 and 4.0 both support Ruby >= 3.2.
- Ruby 4.0 ships Bundler 4.0 as its bundled default. That is a convenience pairing, not a compatibility requirement.

## No hardcoded table

`src/bundler-compat.js` deliberately stores no versions. This tool performs no network requests, so it cannot look up which Bundler supports which Ruby, and a baked-in table would silently rot at the next series release.

The minimum floor arrives the same way Rails and Ruby compatibility facts already enter this system: supplied as cited research at the moment the bridge is approved, and recorded in the run report so it can be re-verified later. Only the comparison arithmetic — version ordering, contiguity, floor checks — lives locally, because that has to be deterministic for an approval to be defensible.

## Lifecycle

### 1. Approve the bridge on the blocked Ruby run

```bash
opencode-ruby-upgrader record-bundler-bridge --report <run>.json \
  --ruby-from 3.3 --ruby-to 3.4 \
  --bundler-from 2.4.17 --bundler-to 2.5.22 \
  --minimum-bundler 2.5 \
  --rationale "Bundler 2.4 predates Ruby 3.4 support." \
  --citation "Bundler compatibility with Ruby|https://guides.rubygems.org/bundler-compatibility/"

opencode-ruby-upgrader transition --report <run>.json --phase blocked
```

The bridge records the floor, the rationale, the citation, and the compatibility source URL. The Ruby run becomes **terminal**: it cannot be resumed, because resuming would skip the prerequisite change and leave the project on a Bundler that cannot run the target Ruby.

Before approving the bridge, present the user with candidate Bundler targets that satisfy the researched minimum (minimum required, a conservative intermediate, latest stable in the relevant line), each with rationale and citations from official sources. Ask the user to choose a target; record that target as `bundlerTo` and ensure it is >= minimum. The ladder must end at the user-chosen researched target.

Approval is refused when the recorded pin already clears the floor. Blocking a hop that the pin already satisfies would be wrong as often as it is right.

For Bundler compatibility and commands, consult official sources: [Bundler command reference](https://guides.rubygems.org/command-reference/bundle/) and [Bundler on GitHub](https://github.com/rubygems/bundler). Verify gem dependencies against [RubyGems.org](https://rubygems.org/) and [Rails Guides](https://guides.rubyonrails.org/) when relevant; prefer official gem documentation when available.

### 2. Begin the separate bridge run

```bash
opencode-ruby-upgrader begin-bundler-bridge --ruby-report <blocked-ruby-report>.json
```

This creates a `reportType: "bundler_bridge"` report linked back to the blocked Ruby run through `bridge.rubyReportPath` and `bridge.rubyRunId`.

### 3. Research a contiguous ladder

```bash
opencode-ruby-upgrader record-bundler-research --report <bridge>.json \
  --ladder 2.4.17,2.5.22,2.6.9,2.7.2,4.0.11 \
  --citation "Bundler compatibility with Ruby|https://guides.rubygems.org/bundler-compatibility/"
```

The ladder must begin at the recorded `BUNDLED WITH` pin and advance one series at a time (each step is its own hop recorded with `record-executed-bundler-iteration`). Research once with the full contiguous ladder to the **user-chosen researched target**, then execute each hop sequentially in order until you reach the final ladder element. A direct **2.7 → 4.0** hop is valid because Bundler never had a 3.x series; without that boundary rule a project on 2.4 could never reach 4.0 through a reviewed ladder. The bridge runs stepwise to the researched target Bundler.

### 4. Raise the pin and validate

Rewrite the pin inside the isolated runtime, then record the hop:

```bash
opencode-ruby-upgrader record-executed-bundler-iteration --report <bridge>.json \
  --iteration '<json>' --validation-command-id docker-bundle-rspec
```

This is where a Bundler bridge differs from a Rails bridge. A Rails hop produces a reviewable `app:update` receipt; a Bundler hop produces a **file change**, and a lockfile edit is weak evidence — anyone can hand-write `BUNDLED WITH 2.5.22`.



Inspect deprecation warnings in validation receipts (test output) between hops. Address them if they cause failures; otherwise record them as evidence/follow-ups in research notes.

So the hop is accepted only when **two independent facts agree**:

1. The rewritten `BUNDLED WITH` pin in `Gemfile.lock` matches the hop target.
2. The Bundler version that actually executed the tests matches the hop target, attested by the isolated runtime.

A mismatch is refused explicitly, for example: `Validation executed Bundler 2.4.22, not 2.5.22. Re-prepare the target runtime on the new Bundler before recording this hop.`

The recorded pin is stored on the iteration as `lockfilePin`, and report validation rejects any hop whose pin disagrees with its target.

### 5. Checkpoint

```bash
opencode-ruby-upgrader transition --report <bridge>.json --phase hop_validated
opencode-ruby-upgrader commit-bundler-hop --report <bridge>.json
```

The checkpoint message carries `Bundler-Upgrade-Report`, `Bundler-Upgrade-Hop`, and `Bundler-Bridge-Ruby-Report` trailers, so the linkage back to the blocked Ruby run survives in Git history and can be verified later.

### 6. Restart the Ruby upgrade

Only after the bridge is complete should a fresh Ruby run begin.

## Rollback

Use the reviewable local history: `git revert <hop-sha>`. Do not use reset, rebase, or force-push as routine migration recovery.

## Reporting to the user

Advisory findings about the `BUNDLED WITH` pin appear in every report's **Infrastructure review (advisory)** section and on the dashboard. They are read-only and never gate a hop: an intentional version pin that lags the app is legitimate in many repositories. Where a value cannot be read with confidence, the tool stays silent rather than guessing.