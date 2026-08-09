# Scheduler

Queueing and lease primitives live here.

- `queue.js` defines the queue item model, deterministic sort helpers, claim expiry helpers, and task-source normalization rules for ingress adapters.
- `scheduler.js` selects the next ready task by deterministic queue order, dependency readiness, and assignment-reason generation.
- `lease.js` defines the task-scoped lease record, acquire/renew/release helpers, and `LOCK_CONFLICT` blocker generation.
- `lock.js` defines deferred wakeups, queue-trigger coalescing, promotion on release, and bounded concurrency policy helpers.
- `wake.js` defines the canonical wake-source taxonomy and records every observed wake before queue/deferred coalescing.
- `watch.js` defines polling, ingress creation, auto-pickup gating, hot reload with last-known-good fallback, and watch-loop tick orchestration.
