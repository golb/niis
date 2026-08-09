# Evals

Scenario-based eval and regression harness for the Niis runtime.

## Baseline Command

Run from `niis/`:

```bash
npm run evals:proofs
```

This executes the named proof regression suite defined in `evals/scenarios/proof-regression-suite.json`.
Changes affecting the runtime kernel are not considered safe until this suite passes.

## Current Scope

- `bootstrap-proof-baseline`
- `runtime-proof-baseline`
- `extractability-proof-baseline`
- `review-preexisting-failure-attribution`
- `review-task-local-defect-attribution`
- `prompt-surface-health`
- `skill-surface-health`
- `discovery-pipeline-proof`
- `discovery-pipeline-host-proof`
- `discovery-pipeline-repo-proof`
- `adversarial-activation-review-plan`
- `adversarial-activation-review-execution`
- `adversarial-activation-review-escalation`
- `adversarial-import-review-execution`
- `adversarial-import-review-escalation`
- `adversarial-import-proof-baseline`
- `adversarial-activation-proof-baseline`
- `adversarial-host-surfaces-proof-baseline`
- `asset-health-cli-skill-view`
- `asset-health-cli-adapter-view`
- `route-derived-health-assets`
- `serve-selected-adapter-health-block`
- `serve-selected-adapter-health-watch`
- `serve-route-derived-prompt-health-block`
- `serve-route-derived-prompt-health-watch`

Each scenario declares:

- the executable command and args
- the number of attempts (`k`) for pass@k accounting
- the grader set used to decide pass/fail across `stdout`, structured JSON fields/ranges/arrays/objects, aggregate subordinate checks, and durable file artifacts

## Result artifacts

The default suite runs in a disposable workspace and removes its artifacts.
Keep a durable copy by selecting an output directory:

```bash
node evals/run-isolated-scenarios.js --output-dir /tmp/niis-eval-results
```

That directory receives:

- `.niis/proofs/evals/proof-regression-suite.json`
- `.niis/proofs/evals/proof-regression-suite.asset-health.json`

When an asset-health report is installed in a project's state directory, the
runtime can block dispatch for assets marked `failing` and record a warning for
assets marked `watch`.

This harness is the runtime regression gate. It establishes:

- a named scenario corpus under `evals/`
- repeatable regression execution over key proof contours
- isolated regression coverage for asset health, route-derived gates,
  activation and import review, discovery de-duplication, and synthetic
  multi-surface repository analysis
- explicit grader output and pass@k accounting
- baseline artifact-oriented grading against durable proof outputs plus structured field/range/array/object assertions and aggregate subordinate-check assertions, not only `stdout`
- a derived `healthy | watch | failing` asset-health rollup for the currently annotated reusable assets
- baseline health coverage for reusable `adapter`, `skill`, `prompt`, `agent`, `package`, and `validator` surfaces exercised by the proof corpus
- a policy-visible signal that can stop `serve` before failing reusable assets continue routing more work

## Local UI browser smoke

The local control plane has two finite UI checks included by `npm run verify`:

- static fixture path: `node packages/cli/bin/niis.js ui evals/fixtures/ui-serve-browser-spec.json --serve --open`
- SQLite-backed proof path: `npm run proof:ui-browser`
- scenario-suite entrypoint: `npm run evals:ui-browser`
- setup-only variant for finite automation: `node packages/cli/scripts/ui-browser-proof.js --prepare-only --workspace-root /tmp/niis-ui-browser-proof`
- served-smoke variant for finite automation: `node packages/cli/scripts/ui-browser-proof.js --smoke-only --port 0 --workspace-root /tmp/niis-ui-browser-proof`

`proof:ui-browser` initializes disposable SQLite state and exercises the
loopback server. `evals:ui-browser` grades both the read-only HTML export and
the interactive smoke path through the scenario harness.
