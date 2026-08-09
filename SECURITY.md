# Security Policy

Only the latest commit on `main` is supported while Niis is pre-1.0.

Report vulnerabilities through GitHub private vulnerability reporting. Please include reproduction steps, impact, and affected versions. Do not open a public issue for a suspected vulnerability.

High-priority findings include worktree escape, gate bypass, promotion without `PASS`, context-contract widening, secret disclosure, and unauthenticated remote UI mutation.

Niis runs agent CLIs as the current operating-system user. Task execution and
planning have different write boundaries. During task execution, Claude uses an
operating-system wrapper that confines writes to the attempt worktree. Codex
requires the provider's per-turn `workspaceWrite` policy before promotion; its
app-server process remains trusted. During planning (`intake`), the wrapper
denies writes only to the protected roots listed below. The provider CLI can
write anywhere else that the operating-system user can. This is not a complete
filesystem write sandbox.

The wrappers deny reads to `.niis`, `~/.ssh`,
`~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.npmrc`, and paths listed in the
path-delimited `NIIS_DENIED_READ_ROOTS` variable. This is not a complete
home-directory read sandbox: other user-readable files may remain visible.
Provider transport stays available, while agent-requested network tools are
disabled in supervised execution.
