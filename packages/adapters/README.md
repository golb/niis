# Adapters

- `test-adapter.js` defines an in-memory adapter that implements the same `execute/test/capabilities/normalize` contract as production adapters for runtime and scheduler tests.
- `local-cli-adapter.js` defines the shared local subprocess transport used by first-class local runtimes.
- `codex-local-adapter.js` defines the `codex_local` first-class runtime on top of the shared `local_cli` contract.
- `claude-code-local-adapter.js` defines the `claude_code_local` first-class runtime on top of the shared `local_cli` contract.
- `mcp-server-adapter.js` defines a stdio MCP adapter that performs `initialize -> tools/list -> tools/call` against a real MCP server process through the same production adapter contract.
- `cursor-bridge-adapter.js` defines the declared `cursor_bridge` compatibility path as a thin adapter over the same stdio MCP transport, keeping Cursor integration outside the core runtime state model.
