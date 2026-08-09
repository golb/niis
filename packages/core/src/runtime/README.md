# Runtime

Execution-runtime contracts live here.

- `task-lifecycle.js` is the single durable attempt engine used by CLI, UI, and scheduler entry points. It resumes from persisted stages and fails closed on ambiguous execution, gate, or review recovery.
- `attempt-worktree.js` creates detached per-attempt worktrees, captures the complete reviewed delta, binds promotion to its snapshot digest, and creates an idempotent review branch only after `PASS`.
- `path-safety.js` defines workspace identifier sanitization, canonical path resolution, workspace-under-root checks, and symlink-escape prevention.
- `workspace.js` defines isolated workspace planning plus executable workspace lifecycle helpers for git-backed `worktree`/`branch` materialization, post-provision commands, hook severity, cleanup, and patch safety policy.
- `failure.js` defines failure normalization, structured failure reports, stall/orphan reconciliation, and bounded self-healing with incident-mode transition.
- `retry.js` defines continuation vs failure retry policy, capped backoff scheduling, and retry-token stale-dispatch protection.
- `resume.js` defines checkpoint/session restoration and resume-plan assembly with runtime artifacts.
- `reference-bundle.js` defines cold-start reference-bundle assembly plus external-content provenance/trust marking.
- `layered-context.js` defines deterministic `core < organization < project` precedence, provenance-preserving overrides, and explicit progressive loading.
- `discovery-pipeline.js` defines a discovery-side incremental pipeline with scope partitioning, shared already-reported dedup state, parallel-ready seeker subtasks, and immediate downstream follow-up task creation.
- `instinct-confidence.js` defines the canonical default confidence policy for reviewed instinct promotion.
- `instinct-promotion.js` defines the reviewed discovery/observation-to-instinct promotion paths with provenance, approval metadata, security-bounded review, confidence-policy wiring, self-loop-safe observation ingress, and pattern-category-to-domain derivation for orchestration learning.
- `instinct-transfer.js` defines reviewed instinct export/import bundles with provenance-preserving sharing, deduplication, and confidence-aware merge rules.
- `learning-governance.js` defines the separate governance gate required before learned artifacts may proceed toward active behavior, including durable-evidence checks before reviewed skill packaging.
- `memory-taxonomy.js` defines the executable `daily / projects / facts` memory-tier classifier over observation artifacts, reviewed instincts, and reviewed skill candidates.
- `observation-guardian.js` defines cheapest-first background observer guard checks for time window, project cooldown, turn budget, and activity-signal policy.
- `observation-lifecycle.js` defines named lifecycle policy evaluation for redacted observation artifacts across hot, archive, and purge tiers.
- `skill-candidate.js` defines reviewed instinct-clustering into skill candidates with trigger/context similarity checks and security-bounded review.
- `prompt-execution.js` defines bootstrap vs heartbeat context assembly, multi-turn continuation, and iterative context refinement.
- `result-normalizer.js` converts adapter execution output into canonical run/event artifacts.
