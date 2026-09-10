# Security Policy

## Scope

This package prevents unsafe **agent actions** through OpenCode permissions, a guarded local commit path, and reviewable evidence. It does not sandbox Ruby projects: Bundler, tests, native builds, Git hooks, and project scripts execute with the local user's permissions.

Use an isolated environment for repositories you do not trust. Never place credentials in migration reports. Report suspected vulnerabilities through [GitHub private security advisories](https://github.com/lilla021/opencode-ruby-upgrader/security/advisories/new); do not open a public issue containing exploit details or secrets.

## Supported security posture

Only the latest published package version receives security fixes. Consumers must restart OpenCode after plugin updates so the new permission policy is loaded.
