# Routing

Coordinator routing and execution-lane selection live here.

- `plan-builder.js` selects the lane, adapter, cost tier, and reference bundle for `route`.
- `executor.js` binds the route plan to prompt execution and result normalization for `run`.
- plan mutation and parallel-ready subtask detection are kept separate from prompt execution so decomposition and execution remain distinct modules.
