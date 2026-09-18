# Privacy and Local Evidence

This package has no telemetry, analytics, or report-upload feature. It reads and writes migration evidence only in the current project worktree under `.ruby-upgrades/runs/` and serves the dashboard only on `127.0.0.1`.

Reports can contain target versions, branch names, commit SHAs, changed-file names, dependency source origins, citations, and bounded validation metadata. Absolute local paths and recognized credentials are redacted, but redaction is best-effort. Do not place secrets, customer data, database dumps, or raw command output in report fields.

Reports may be staged into local checkpoint commits. Review them before committing, pushing, sharing, or opening the dashboard on a shared machine. Delete `.ruby-upgrades/` when evidence retention is no longer needed. The dashboard has no authentication; other local processes able to reach your loopback interface may read its displayed report data.

Dependency installation, tests, and Rails tooling execute project-controlled code with your local user permissions after confirmation. Use an isolated environment for repositories you do not trust.
