# Contracts

- `storage.js` defines the storage/query port contract, required concurrency semantics, and storage-backend compatibility and migration planning artifacts.
- `plugin-runtime.js` defines the executable plugin runtime contract: lifecycle state machine, worker isolation, event subscriptions, tool registration, job scheduling, scoped state, MCP integration descriptors, and capability gating.
- `completion.js` defines completion gating against verdict/evidence/explainability requirements.
- `adapter.js` defines the canonical adapter interface, capability/allow-deny model, env binding contract, diagnostics, runtime-tool injection surface, callback channel, and session codec helpers.
- `validator.js` defines validator contracts, orthogonality checks, and verdict-class continuation policy.
- `governance.js` defines review/approval/release ownership, durable governance artifacts, roadmap-change protocol, and optional goal-to-task linkage reporting.
- `task-notes.js` defines the task-note communication channel, mention extraction, and mention-to-wake bridging.
- `context-contract.js` defines per-role context contracts: allow-list normalization, guide-source classification, deny-by-default filtering with fail-closed violations, and the applied-contract digest recorded in attempt evidence.
- `onboarding.js` defines the generated onboarding artifact contracts for `project-profile.md`, `workflow.md`, codemap/reference seeds, bootstrap packs, scaffold plans, and local project registry entries.
- `packages.js` defines package manifests, conversion/discovery report helpers, release and upgrade planning contracts, and immutable install-state and drift record shapes.
