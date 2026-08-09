# @niis/cli

Bootstrap and runtime command surface for `init`, `attach`, `profile`, `doctor`, `asset-health`, plus repeatable proof scripts such as `proof:bootstrap`, `proof:host-local-runtimes`, `proof:local-runtimes`, `proof:npx-bootstrap`, `proof:upgrade-plan`, `proof:runtime`, and `proof:extractability`.

## Reliability RC execution contour

The supervised path is:

```text
intake → plan approval → start-task → gates → fresh review
       → PASS-only review branch → manual merge
```

`approve-plan` is bound to the exact plan-relevant task fields, intake artifact,
and runtime preferences. A task edit invalidates the approval and execution
fails closed until the operator approves the revised plan.

`start-task`, `go`, `serve --once`, `serve --daemon`, the UI, and the deprecated
`worker` alias all enter the same durable `TaskAttempt` lifecycle. Reliability RC
fixes concurrency at `1`. `worker` delegates to `serve --daemon`; it is not a
separate execution engine.

Daemon mode is a release state, not a convenience switch:

```bash
niis readiness status
niis readiness record \
  --kind rollout_phase \
  --task-id <task-id> \
  --attempt-id <attempt-id> \
  --source-workspace /path/to/disposable-fixture
niis readiness record \
  --kind canary_task \
  --task-id <task-id> \
  --attempt-id <attempt-id>
```

The writer accepts only completed attempts whose durable stages contain the
required gate, fresh-review, promotion, budget, checkout-integrity, repository,
source-state, and runtime evidence. It derives each rollout phase; callers
cannot supply a phase label. External fixture state is retained and reopened
read-only on every verification. Ordered rollout phases must be recorded first,
followed by 20 consecutive clean canonical attempts. Until then,
`serve --daemon` and `worker` remain locked; `serve --once` remains available
for supervised operation.

The RC UI is loopback-only. Non-loopback hosts and legacy remote/token flags
are rejected. `niis ui --serve --open` passes a one-time bootstrap URL to the
local browser. HTTP mutations and WebSocket upgrades require an authenticated
session and exact same origin.

Artifact rendering requires an explicit renderer and scope. `--stub` creates a
local preview without a provider call. `--codex` and `--claude` also require
`--confirm-provider-cost`; each selected artifact is a separate provider call.

```bash
niis render-artifacts --stub --artifact project-profile
niis render-artifacts --claude --all --confirm-provider-cost
```
