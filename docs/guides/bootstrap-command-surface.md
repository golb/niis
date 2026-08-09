# Bootstrap Command Surface

The Reliability RC bootstrap preserves existing local state by default.

## Commands

```bash
niis init
niis attach
niis doctor
niis reset-state --backup-to <external-path> --confirm <project-id>
```

## Current behavior

- `init` creates missing directories, configuration, and SQLite lifecycle schema
  in the target project's `.niis/` state root
- repeated `init` verifies a compatible installation and repairs only missing
  scaffold artifacts; it does not recreate or overwrite an existing database,
  configuration, queue, backup, or secret
- `attach` records the attached validation surface without changing repository
  source
- `doctor` validates bootstrap health, package boundaries, state/schema health,
  Git, the required OS sandbox, permissions, and available local runtimes
- `reset-state` is the explicit destructive boundary; it refuses to run without
  an external backup destination and exact project-id confirmation
- proofs and evals create disposable workspace/state roots and compare protected
  live-state digests before and after execution

## Operator constraints

- do not use a live project state root as a proof or eval workspace
- do not hand-edit or delete state as a substitute for `reset-state`
