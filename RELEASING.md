# Releasing

1. Verify package `author`, `repository`, `bugs`, and `homepage` metadata remains accurate.
2. Run `npm test` and `npm pack --dry-run`.
3. Review the packed file list, dependency changes, LICENSE, README, SECURITY.md, and the [Release Gate](RELEASE_CHECKLIST.md).
4. Publish from protected CI with npm provenance enabled; never publish from an unreviewed workstation.
5. Tag the exact reviewed commit, publish release notes, and verify installation in a clean OpenCode environment.

Do not publish credentials, report fixtures containing customer data, or a package with unreviewed permission-policy changes.
