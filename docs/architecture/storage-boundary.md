# Storage Boundary

This boundary defines the runtime-facing storage contract shared by the scheduler, execution runtime, and SQLite implementation.

## Why this boundary exists

- scheduler, runtime, policy, and operator surfaces must depend on semantic ports, not on SQLite tables or SQL strings
- SQLite is the canonical v1 implementation, but not the product contract
- hosted backends must preserve the same state/query model without forcing orchestration logic rewrites

## Canonical write ports

- `tasks.upsert()`
- `goals.upsert()`
- `agents.upsert()`
- `agents.updateStatus()`
- `agents.accumulateCost()`
- `runs.upsert()`
- `events.append()`
- `ingress.record()`
- `assignments.record()`
- `queue.enqueue()`
- `queue.claimNext()`
- `leases.acquireOrRenew()`
- `taskSessions.upsert()`
- `runLogs.store()`
- `taskNotes.append()`
- `verdicts.record()`
- `evidence.savePacket()`
- `blockers.upsert()`
- `checkpoints.save()`
- `explainability.record()`

## Canonical query ports

- `tasks.list()`
- `tasks.byGoal()`
- `goals.byId()`
- `goals.list()`
- `runs.byTask()`
- `agents.list()`
- `agents.byId()`
- `agents.health()`
- `taskSessions.getByKey()`
- `taskSessions.byTaskKey()`
- `runLogs.getByRunId()`
- `runLogs.byRun()`
- `taskNotes.byTask()`
- `blockers.active()`
- `decisions.explain()`
- `evidence.byVerdict()`
- `ingress.byTask()`
- `assignments.byTask()`

## Concurrency semantics

- `queue.claimNext()` is an atomic claim boundary
- `leases.acquireOrRenew()` is atomic and may not silently downgrade an active lease
- append-style writes must be idempotent when replay/request identity matches
- transitions that depend on prior state must use compare-and-set semantics at the storage boundary
- orchestration logic must not read or write SQLite tables directly

## Implementation rule

Storage implementations must satisfy the full contract exported from `packages/core/src/contracts/storage.js`.
