# v0.1.0 Release Gate

Complete every item before pushing a `v*` tag.

- [x] Create `github.com/lilla021/opencode-ruby-upgrader`; push the reviewed `main` branch.
- [ ] Configure the GitHub `npm-release` environment with required approval and tag restriction `v*`.
- [x] First-publish bootstrap plan: publish `v0.1.0` manually from the workstation once with 2FA (npm policy requires the package to exist before OIDC trusted publishing or staged publishing can be configured — see `npm/cli#8544`). No long-lived token is needed for this bootstrap.
- [x] After v0.1.0 exists: configure npm Trusted Publishing (OIDC) for `opencode-ruby-upgrader` bound to `.github/workflows/release.yml` + `npm-release` environment; CI then publishes with `npm publish --provenance` using no stored secret. Optionally restrict the trusted publisher to stage-only for later versions.
- [x] Confirm `opencode-ruby-upgrader` currently returns npm registry 404 and is available for first publication.
- [x] Run `npm test` and `npm pack --dry-run` from the release candidate.
- [x] Install latest OpenCode, load this package from a local `file://` plugin path, restart OpenCode, and confirm `/ruby-upgrade` plus its permission prompts.
- [x] Run a supported Ruby fixture in a linked Git worktree: complete one hop, inspect the local commit/report/dashboard, then exercise one risk pause.
- [x] When releasing Rails bridge support, run a disposable Rails compatibility bridge: review `app:update` evidence, complete one Rails hop, and inspect Rails trailers and dashboard rendering.
- [x] Review the package metadata, LICENSE, README, SECURITY.md, RELEASING.md, and packed-file list. Confirm no credentials or customer artifacts are present.
- [x] Create release notes describing scope, supported adapters, known limitations, and rollback (`git revert <hop-sha>`) — see [RELEASE_NOTES.md](RELEASE_NOTES.md).

One-time exception: the very first publish (v0.1.0) is done manually from the workstation with 2FA, because npm requires the package to exist before OIDC trusted publishing or staging can be configured. All subsequent publishes go through the protected `npm-release` environment with OIDC trusted publishing; do not bypass it with token-based direct publishing.
