class ThreatCatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = "ThreatCatalogError";
  }
}

const THREAT_SEVERITIES = Object.freeze(["low", "medium", "high", "critical"]);

const DEFAULT_THREAT_CATALOG = Object.freeze([
  Object.freeze({
    auto_fixable: false,
    blocking: true,
    category: "secret_handling",
    remediation_hint: "Store the value as a secret_ref or redact it before persistence.",
    rule_id: "security/plaintext-secret-persistence",
    severity: "critical",
    summary: "Plaintext secrets must not be persisted in durable config or artifact surfaces.",
  }),
  Object.freeze({
    auto_fixable: false,
    blocking: true,
    category: "supply_chain",
    remediation_hint: "Keep the candidate in REVIEW and require operator inspection before activation.",
    rule_id: "security/prompt-injection-carrier",
    severity: "high",
    summary: "Imported or fetched content may carry prompt-injection instructions.",
  }),
  Object.freeze({
    auto_fixable: false,
    blocking: true,
    category: "capability_gating",
    remediation_hint: "Reduce permissions or route through a lower-privilege adapter/plugin.",
    rule_id: "security/overprivileged-integration",
    severity: "high",
    summary: "The requested operation exceeds the declared capability envelope.",
  }),
  Object.freeze({
    auto_fixable: false,
    blocking: true,
    category: "supply_chain",
    remediation_hint: "Verify origin and naming similarity before import or activation.",
    rule_id: "security/typosquatting-candidate",
    severity: "medium",
    summary: "The package or plugin candidate resembles a known name suspiciously closely.",
  }),
  Object.freeze({
    auto_fixable: false,
    blocking: true,
    category: "execution_hooks",
    remediation_hint: "Keep the hook disabled until reviewed and sandboxed explicitly.",
    rule_id: "security/malicious-hook-surface",
    severity: "high",
    summary: "Lifecycle hook requests destructive or undeclared privileged behavior.",
  }),
]);

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ThreatCatalogError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function createThreatRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new ThreatCatalogError("threat rule must be a plain object");
  }

  const severity = ensureNonEmptyString(rule.severity, `severity for ${rule.rule_id ?? "rule"}`);

  if (!THREAT_SEVERITIES.includes(severity)) {
    throw new ThreatCatalogError(
      `unsupported threat severity ${severity}; expected one of ${THREAT_SEVERITIES.join(", ")}`,
    );
  }

  return Object.freeze({
    auto_fixable: Boolean(rule.auto_fixable ?? rule.autoFixable ?? false),
    blocking: Boolean(rule.blocking ?? false),
    category: ensureNonEmptyString(rule.category, `category for ${rule.rule_id ?? "rule"}`),
    remediation_hint: ensureNonEmptyString(
      rule.remediation_hint ?? rule.remediationHint ?? "Review and remediate before activation.",
      `remediation_hint for ${rule.rule_id ?? "rule"}`,
    ),
    rule_id: ensureNonEmptyString(rule.rule_id ?? rule.ruleId, "rule_id"),
    severity,
    summary: ensureNonEmptyString(rule.summary, `summary for ${rule.rule_id ?? "rule"}`),
  });
}

function createThreatCatalog(entries = DEFAULT_THREAT_CATALOG) {
  if (!Array.isArray(entries)) {
    throw new ThreatCatalogError("threat catalog entries must be an array");
  }

  const rules = entries.map((entry) => createThreatRule(entry));
  const duplicateRuleIds = rules
    .map((rule) => rule.rule_id)
    .filter((ruleId, index, allRuleIds) => allRuleIds.indexOf(ruleId) !== index);

  if (duplicateRuleIds.length > 0) {
    throw new ThreatCatalogError(
      `threat rule ids must be unique: ${[...new Set(duplicateRuleIds)].join(", ")}`,
    );
  }

  return Object.freeze(rules);
}

function indexThreatCatalog(threatCatalog = DEFAULT_THREAT_CATALOG) {
  return new Map(createThreatCatalog(threatCatalog).map((rule) => [rule.rule_id, rule]));
}

export {
  DEFAULT_THREAT_CATALOG,
  THREAT_SEVERITIES,
  ThreatCatalogError,
  createThreatCatalog,
  createThreatRule,
  indexThreatCatalog,
};
