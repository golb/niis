# UI

Local dashboard and supervised control-plane UI surfaces for `Niis`.

Reliability RC permits only lifecycle actions: `approve`, `start`, `cancel`,
`retry`, and `resolve`. The UI does not expose arbitrary task-status mutation,
automatic merge, or a bypass around the canonical attempt lifecycle. Approval
is version-bound and becomes invalid when plan-relevant task, intake, or runtime
inputs change.

Current slices:

- renders a static HTML operator dashboard from the same task/run/blocker query snapshot shape already used by the CLI and observability helpers
- shows phase progress, active blockers, approval blockers, and recent runs without introducing a separate truth model
- renders a focus-task detail pane from the shared task observability view, including assignments, explainability decisions, and recent activity
- adds a local navigation shell with task links and a precomputed task-detail catalog so operators can jump between task sections without regenerating the dashboard for every selection
- supports local filtering via `--status`, `--phase`, `--task-id`, and `--focus-task-id`, so operators can render scoped static dashboards over the same shared dashboard view instead of maintaining a separate filtered UI state layer
- adds a thin in-browser interactive shell on top of the same static HTML using collapsible `<details>` sections and hash-driven auto-open for task detail anchors, without introducing a server or a separate client-state runtime
- is now reachable through the CLI as `niis ui`, which renders dashboard HTML from an inline/spec snapshot or from the default local SQLite snapshot with redaction applied before output
- has explicit CLI integration proof for the default local path: `niis init` + seeded SQLite state + `niis ui --output ...` now exercises the same renderer without requiring an inline snapshot fixture
- supports `niis ui --open`, which writes the dashboard to a local HTML file and launches the system viewer so operators can open the local console without manually finding the exported file
- supports `niis ui --serve`, which hosts the local single-project control-plane UI on a loopback HTTP server with `/`, `/tasks`, `/tasks/new`, `/tasks/:taskId`, `/approvals`, `/runs/:runId`, `/project`, and `/health`
- has a repeatable browser-smoke fixture at `evals/fixtures/ui-serve-browser-spec.json`, so the loopback UI contour can be verified in a real browser without inventing a second demo-only data shape
- now also has a dedicated SQLite-backed browser proof entrypoint at `packages/cli/scripts/ui-browser-proof.js` and `npm run proof:ui-browser`, so the loopback control-plane contour can be exercised against a real initialized local state root instead of only inline fixtures
- now also has a separate scenario-harness entrypoint at `npm run evals:ui-browser`, which verifies both the preserved read-only `ui --output` contour and the served interactive control-plane contour without folding the UI proof into the main proof regression gate
- the SQLite browser-proof path emits a structured `render-summary.json` artifact for the static `ui --output` export, so eval coverage can assert that the dashboard remains read-only and is not overloaded with mutation behavior
- the SQLite browser-proof path also supports a finite `--smoke-only` served-control-plane check that writes `serve-summary.json`, so eval coverage can assert loopback `/`, `/health`, task preview/create+start, approval handling, and run-detail rendering without keeping the local server process alive

Local renderer:

```bash
node packages/ui/src/index.js path/to/snapshot.json --status BLOCKED --phase 10 > dashboard.html
```

CLI bridge:

```bash
niis ui ui-spec.json
```

SQLite-backed local path:

```bash
niis init
niis ui --output dashboard.html
```

Open in local viewer:

```bash
niis ui --open
```

Serve the local control-plane UI over loopback HTTP:

```bash
niis ui --serve --host 127.0.0.1 --port 4173
```

Serve and open in the browser:

```bash
niis ui --serve --open
```

The RC UI is loopback-only. Non-loopback hosts and legacy remote/token flags
are rejected. `--open` passes a one-time bootstrap URL to the local browser;
HTTP mutations and WebSocket upgrades then require the authenticated session
and exact same origin.

Browser-smoke fixture:

```bash
node packages/cli/bin/niis.js ui evals/fixtures/ui-serve-browser-spec.json --serve --open
```

SQLite-backed browser proof:

```bash
npm run proof:ui-browser
```

SQLite-backed browser proof eval suite:

```bash
npm run evals:ui-browser
```

Setup-only SQLite browser proof workspace:

```bash
node packages/cli/scripts/ui-browser-proof.js --prepare-only --workspace-root /tmp/niis-ui-browser-proof
```

Served-control-plane SQLite browser smoke:

```bash
node packages/cli/scripts/ui-browser-proof.js --smoke-only --port 0 --workspace-root /tmp/niis-ui-browser-proof
```

Focused/scoped served-contour SQLite browser smoke:

The setup-only path proves that `niis ui --output` remains a read-only export
surface, while the served-smoke path proves supervised lifecycle actions,
approval handling, and run-detail rendering through the loopback control plane.
