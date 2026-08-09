# Observability

This directory contains operator-facing observability helpers.

- `activity-stream.js` projects persisted events, explainability records, blockers, assignments, and checkpoints into a task-scoped activity stream.
- `dashboard.js` builds a read-only operator dashboard view over the same task/run/blocker query snapshot used by the CLI and later local UI surfaces, including a selected-task detail pane, task navigation entries, a task-detail catalog, and shared status/phase/task-id filtering derived from canonical task observability records.
- the same module defines the event-humanization contract used to turn machine-readable events into concise operator-readable summaries.
- `live-events.js` defines the canonical local live-event envelope (`event_id`, `event_type`, `timestamp`, `payload`) and sink/emitter helpers that later streaming transports may reuse.
- `metrics.js` projects persisted runs, agents, events, and queue writes into cost/budget aggregates and operational metrics query views.

Observability remains a presentation layer on top of canonical event and storage records; it does not replace raw machine-readable storage.
