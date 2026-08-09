# Storage

This directory contains the durable storage implementation surface.

- `index.js` re-exports the engine-agnostic storage contract plus the SQLite v1 implementation helpers.
- `sqlite.js` provides the canonical local SQLite-backed storage engine, schema bootstrap, health checks, and seed helpers for tests/CLI wiring.
- `backup.js` provides manual backup creation, retention policy helpers, and doctor-friendly backup freshness checks for the local state root. Reliability RC intentionally exposes no in-place restore primitive.
- `secrets.js` provides the encrypted local secret store, secret-ref helpers, and agent env-binding rewrite/materialization helpers for runtime diagnostics.
- `run-logs.js` provides file-backed run-log artifact storage, SHA-256 integrity helpers, ref verification, and hydration for inline-vs-ref log records.

Business logic must still depend on the storage contract rather than on SQLite-specific calls.
