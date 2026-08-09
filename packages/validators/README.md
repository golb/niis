# Validators

Validator packages provide narrow, orthogonal checks that can be assembled into a policy-driven
validator lane.

- `evidence-authenticity-validator.js` checks for placeholders, truncation, and handwritten claims
  without raw backing.
- `security-scan-validator.js` applies the named threat catalog to doctor/converter/activation-like
  surfaces and raises structured security findings into the validator lane.
- `completion-proof-validator.js` decides whether authentic runtime evidence is sufficient for
  `PASS`, `PARTIAL_PROGRESS`, `EVIDENCE_GAP`, `DEFECT`, `ENV_BLOCK`, or `NEEDS_ESCALATION`.
- `index.js` exports the default validator set used by the CLI `review` path.
