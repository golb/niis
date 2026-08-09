# Policy

Policy modules define resolved-policy computation, pre-execution gates,
artifact redaction, threat-catalog normalization, and validator-lane orchestration.

- `resolved-policy.js` merges defaults, project/workflow inputs, and runtime overrides into one
  resolved policy substrate.
- `gates.js` defines the pre-execution gate contract, including fail-open/fail-closed handling.
- `redaction.js` redacts JWTs, secret-like assignments, and operator PII before durable persist/render.
- `threat-catalog.js` normalizes named security scan rules with severity/blocking metadata.
- `security-scan.js` evaluates doctor/converter/activation-like surfaces against the named threat catalog and emits structured findings/observations.
- `observations.js` defines structured observation outputs for later learning ingestion, inheriting the same redaction rules as durable artifacts.
- `lane.js` assembles the validator lane and terminal completion gate on top of verdict-class continuation policy.
- `scope-governance.js` keeps discovered host-product bugfix work out of phase scope by default, while allowing proof-driven exceptions only through explicit governance evidence.
