# Release Gate

Complete every item before pushing a `v*` tag. The protected `npm-release` environment enforces the required review; CI runs `npm test`, the pinned runtime smoke test, and `npm publish --provenance`.

## Before every release

- [ ] Bump the version and update [RELEASE_NOTES.md](RELEASE_NOTES.md): scope, supported adapters, known limitations, rollback.
- [ ] Repoint the README's tag-pinned links to the new version tag: `E2E_EVIDENCE.md`, `PRIVACY.md`, `SECURITY.md`, `docs/rails-bridge.md`, and both screenshot URLs. They are pinned to a tag so the registry page always shows the docs of the installed version rather than whatever `main` currently says; leaving them on the previous tag makes the published page drift behind the release.
- [ ] Review the package metadata (name, description, keywords, `repository`, `bugs`, `homepage`) and the packed-file list with `npm pack --dry-run`.
- [ ] Run `npm test`; confirm the release workflow's runtime smoke gate passes with the pinned OpenCode runtime.
- [ ] Confirm no credentials, personal data, or local paths appear in the packed files, README, SECURITY.md, PRIVACY.md, or release notes.
- [ ] Tag the exact reviewed commit and push the tag from `main`; approve the `npm-release` deployment so CI publishes with OIDC provenance — never bypass with token-based local publishing.
- [ ] Verify on the registry: version, `latest` dist-tag, and SLSA provenance attestation.

## History

- **v0.1.0** was the one-time bootstrap: npm requires a package to exist before OIDC trusted publishing can be configured, so it was published once from the workstation with 2FA and no long-lived token.
- **v0.1.1** was tagged but never published; its gate correctly stopped on the OpenCode runtime smoke test (the npm 11 install-script gate, fixed in v0.1.2).
- **v0.1.2** was the first release published through the fully automated gate above.
