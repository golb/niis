<p align="center">
  <img src="assets/readme/niis-promenade-watercolor.png" alt="Watercolor panorama of the Promenade des Anglais in Nice" width="100%">
</p>

<p align="center">
  <img src="assets/readme/niis-logo.svg" alt="Niis Bay N logo" width="88">
</p>

<h1 align="center">Niis</h1>

<p align="center">
  <strong>Supervised orchestration for coding agents, with a local Kanban control plane.</strong>
  <br>
  Turn an approved plan into a verified, reviewable change without surrendering the merge button.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-supervised-path">How it works</a> ·
  <a href="#security-boundaries">Security</a> ·
  <a href="#verify-the-distribution">Verification</a>
</p>

> [!IMPORTANT]
> Niis `v0.1.0` is an experimental release candidate for supervised local use.
> Automatic merge is unavailable, and daemon mode stays locked until its rollout
> evidence is complete.

Niis turns a task into a reviewable plan, executes the approved work through
Codex or Claude, runs deterministic gates and a fresh review, and produces a
branch only after the canonical verdict is `PASS`.

| Plan deliberately | Execute safely | Promote with evidence |
| --- | --- | --- |
| Review and approve the exact task plan before an agent starts. | Give every attempt a durable record and an isolated Git worktree. | Require deterministic gates, a fresh review, and a canonical `PASS`. |

## The supervised path

```text
Task
  → Plan
  → Operator approval
  → Isolated Git worktree
  → Deterministic gates
  → Fresh review
  → PASS-only branch
  → Manual merge
```

| Boundary | What Niis enforces |
| --- | --- |
| Primary checkout | Never switched, cleaned, or stashed |
| Plan approval | Bound to the exact plan-relevant task version |
| Execution | One durable attempt in its own worktree |
| Promotion | Blocked until evidence, gates, and fresh review produce `PASS` |
| State | Queue, leases, attempts, evidence, and promotion records in SQLite |
| Control | Kanban UI is loopback-only; merge remains a human decision |

## Quick start

### Requirements

- Node.js 20 or newer
- Git with worktree support
- `codex` or `claude` available on `PATH`
- macOS `sandbox-exec` or Linux Bubblewrap (`bwrap`)

Niis is installed from its official source-available repository; it is not
published to npm:

```bash
git clone https://github.com/golb/niis.git
cd niis
npm ci
npm link ./packages/cli
niis help
```

Run Niis from the Git repository it should manage:

```bash
cd /path/to/your/project
niis init
niis attach
niis doctor --security
```

Create and run the first supervised task:

```bash
niis intake --text "Describe the change"
niis approve-plan --task-id <id>
niis start-task --task-id <id>
```

Open the local Kanban control plane:

```bash
niis ui --serve --open
```

Each managed project gets a local `.niis/` directory containing SQLite state,
evidence, and machine-local secrets. `init` is idempotent, and `.niis/` must
not be committed.

## Security boundaries

- During task execution, Claude writes are confined to the attempt worktree by
  Niis's operating-system wrapper. Codex promotion requires the provider's
  per-turn `workspaceWrite` policy to be reported as applied.
- During planning (`intake`), the provider CLI runs as the operating-system user.
  Niis blocks writes to protected roots, but the planner can write elsewhere
  that the user can write. This is not a complete filesystem write sandbox.
- Niis denies reads to project state and common credential paths, but it does
  not hide every user-readable file.
- Provider transport remains available while supervised execution disables
  agent-requested network tools.
- The local UI accepts loopback connections only and requires a one-time
  operator bootstrap session.

Read the complete threat model and reporting process in [SECURITY.md](SECURITY.md).

## Costs and optional rendering

Planner and executor calls use the installed Codex or Claude account and may
consume paid credits or API quota. Niis's runtime estimates do not cap charges
at the provider account.

Artifact previews are local and explicit:

```bash
niis render-artifacts --stub --artifact project-profile
```

Provider rendering requires a provider, a scope, and cost acknowledgement; each
selected artifact is a separate provider call:

```bash
niis render-artifacts --codex --all --confirm-provider-cost
```

## Daemon readiness

`serve --daemon` remains locked until machine-verified rollout phases and 20
consecutive clean canary tasks are recorded. Automatic merge remains disabled.
See the [`niis readiness record` procedure](packages/cli/README.md#reliability-rc-execution-contour).

## Verify the distribution

```bash
npm ci
npm run release:verify
```

The release gate runs the unit suite, 25 isolated proof scenarios, browser
proofs, reference and distribution checks, and the production dependency audit.

## License and feedback

Niis is source-available proprietary software. The license permits viewing,
downloading, installing, building, and running an unmodified copy. It does not
permit modification, redistribution, resale, hosted third-party operation, or
derivative works. See [LICENSE](LICENSE).

Reproducible bug reports and focused technical feedback are welcome under
[CONTRIBUTING.md](CONTRIBUTING.md).
