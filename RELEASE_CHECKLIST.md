# v0.1.0 Release Gate

Complete every item before pushing a `v*` tag.

- [ ] Create `github.com/lilla021/opencode-ruby-upgrader`; push the reviewed `main` branch.
- [ ] Configure the GitHub `npm-release` environment with required approval and tag restriction `v*`.
- [ ] Add a granular npm publish token as the `NPM_TOKEN` secret in that environment, or configure npm Trusted Publishing for this repository and workflow.
- [x] Confirm `opencode-ruby-upgrader` currently returns npm registry 404 and is available for first publication.
- [ ] Run `npm test` and `npm pack --dry-run` from the release candidate.
- [ ] Install latest OpenCode, load this package from a local `file://` plugin path, restart OpenCode, and confirm `/ruby-upgrade` plus its permission prompts.
- [ ] Run a supported Ruby fixture in a linked Git worktree: complete one hop, inspect the local commit/report/dashboard, then exercise one risk pause.
- [ ] When releasing Rails bridge support, run a disposable Rails compatibility bridge: review `app:update` evidence, complete one Rails hop, and inspect Rails trailers and dashboard rendering.
- [ ] Review the package metadata, LICENSE, README, SECURITY.md, RELEASING.md, and packed-file list. Confirm no credentials or customer artifacts are present.
- [ ] Create release notes describing scope, supported adapters, known limitations, and rollback (`git revert <hop-sha>`).

Do not publish from a workstation or bypass the protected `npm-release` environment.
