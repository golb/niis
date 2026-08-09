# SDK

Local-first SDK surface for Niis package and plugin extensions.

- `src/index.js` exports `definePlugin()`, which validates a plugin manifest/runtime descriptor against the canonical core contract while keeping executable `setup` / `shutdown` / `health` hooks on the SDK side.
- the current SDK intentionally covers plugin definition/runtime contracts only; it does not require a marketplace, hosted control plane, or published package registry.
