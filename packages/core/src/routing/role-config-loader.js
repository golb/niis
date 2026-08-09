import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_ROLE_MANIFESTS, SYSTEM_ROLE_IDS } from "./role-manifests.js";

const SHIPPED_MANIFEST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
  "config/role-manifests",
);
const PROJECT_CONFIG_RELATIVE = ".niis/project-config.json";

const cache = new Map();




const capabilityCache = new Map();

function probeCommandAvailable(command, args = ["--version"]) {
  if (capabilityCache.has(command)) return capabilityCache.get(command);
  let available = false;
  try {
    const result = spawnSync(command, args, { encoding: "utf8" });
    available = !result.error && result.status === 0;
  } catch {
    available = false;
  }
  capabilityCache.set(command, available);
  return available;
}

function probeGitOriginAvailable(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") return false;
  const cacheKey = `git_origin:${workspaceRoot}`;
  if (capabilityCache.has(cacheKey)) return capabilityCache.get(cacheKey);
  let available = false;
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    available = !result.error && result.status === 0 && (result.stdout ?? "").trim() !== "";
  } catch {
    available = false;
  }
  capabilityCache.set(cacheKey, available);
  return available;
}

function clearCapabilityCache() {
  capabilityCache.clear();
}

class RoleConfigLoaderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RoleConfigLoaderError";
    this.cause = options.cause ?? null;
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.join(dirPath, entry))
    .sort();
}

function parseFrontmatter(text) {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n")) {
    return { body: text, frontmatter: {} };
  }
  const closingIndex = trimmed.indexOf("\n---", 4);
  if (closingIndex < 0) {
    return { body: text, frontmatter: {} };
  }
  const headerBlock = trimmed.slice(4, closingIndex).trim();
  const bodyStart = trimmed.indexOf("\n", closingIndex + 4);
  const body = bodyStart >= 0 ? trimmed.slice(bodyStart + 1) : "";
  const frontmatter = parseYamlSubset(headerBlock);
  return { body: body.trim(), frontmatter };
}

function parseYamlSubset(headerBlock) {
  const result = {};
  const lines = headerBlock.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const match = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1];
    const inlineValue = match[2];
    if (inlineValue === "" || inlineValue === undefined) {
      const { value, consumed } = parseNestedBlock(lines, i + 1);
      result[key] = value;
      i = consumed;
      continue;
    }
    result[key] = parseScalar(inlineValue);
    i += 1;
  }
  return result;
}

function parseNestedBlock(lines, startIndex) {
  const blockLines = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    blockLines.push(line);
    i += 1;
  }
  if (blockLines.length === 0) {
    return { consumed: i, value: null };
  }
  const isList = blockLines.every((line) => line.trim().startsWith("- "));
  if (isList) {
    return {
      consumed: i,
      value: blockLines.map((line) => parseScalar(line.trim().slice(2).trim())),
    };
  }
  const dedented = dedentBlock(blockLines);
  return { consumed: i, value: parseYamlSubset(dedented.join("\n")) };
}

function dedentBlock(blockLines) {
  let minIndent = Infinity;
  for (const line of blockLines) {
    const match = line.match(/^(\s*)/);
    if (match && line.trim() !== "") {
      minIndent = Math.min(minIndent, match[1].length);
    }
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) {
    return blockLines;
  }
  return blockLines.map((line) => line.slice(minIndent));
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "" || value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return value;
}

function loadMarkdownManifests(workspaceRoot) {
  const files = listMarkdownFiles(SHIPPED_MANIFEST_DIR);
  const manifests = [];
  for (const filePath of files) {
    const text = safeReadFile(filePath);
    if (text === null) continue;
    try {
      const { frontmatter, body } = parseFrontmatter(text);
      if (!frontmatter || typeof frontmatter !== "object" || !frontmatter.id) {
        continue;
      }
      manifests.push({
        ...frontmatter,
        system_prompt: body && body.trim() !== "" ? body : (frontmatter.system_prompt ?? null),
      });
    } catch (error) {
      throw new RoleConfigLoaderError(
        `Failed to parse role manifest ${filePath}: ${error.message}`,
        { cause: error },
      );
    }
  }
  return manifests;
}

function loadProjectOverrides(workspaceRoot) {
  const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
  const text = safeReadFile(filePath);
  if (text === null) return { roles: {}, routing_policy: null };
  try {
    const parsed = JSON.parse(text);
    return {
      roles: parsed.roles && typeof parsed.roles === "object" ? parsed.roles : {},
      routing_policy: parsed.routing_policy && typeof parsed.routing_policy === "object"
        ? parsed.routing_policy
        : null,
    };
  } catch (error) {
    throw new RoleConfigLoaderError(
      `Failed to parse project-config.json: ${error.message}`,
      { cause: error },
    );
  }
}




const DEEP_MERGE_KEYS = new Set(["persona"]);

function mergeManifest(base, ...overrides) {
  const merged = { ...base };
  for (const override of overrides) {
    if (!override || typeof override !== "object") continue;
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      if (
        DEEP_MERGE_KEYS.has(key)
        && value
        && typeof value === "object"
        && !Array.isArray(value)
        && merged[key]
        && typeof merged[key] === "object"
        && !Array.isArray(merged[key])
      ) {
        merged[key] = { ...merged[key], ...value };
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function computeCacheKey(workspaceRoot) {
  const projectConfig = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
  const files = listMarkdownFiles(SHIPPED_MANIFEST_DIR);
  const mtimes = files.map((filePath) => `${filePath}:${safeStat(filePath)?.mtimeMs ?? 0}`);
  mtimes.push(`${projectConfig}:${safeStat(projectConfig)?.mtimeMs ?? 0}`);
  return mtimes.join("|");
}

function loadRoleConfig({ workspaceRoot, useCache = true } = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    throw new RoleConfigLoaderError("workspaceRoot is required");
  }
  const cacheKey = `${workspaceRoot}|${computeCacheKey(workspaceRoot)}`;
  if (useCache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const markdownManifests = loadMarkdownManifests(workspaceRoot);
  const overrides = loadProjectOverrides(workspaceRoot);

  const builtinIds = new Set(DEFAULT_ROLE_MANIFESTS.map((m) => m.id));
  const markdownIds = new Set(markdownManifests.map((m) => m.id));

  const byId = new Map();
  for (const manifest of DEFAULT_ROLE_MANIFESTS) {
    byId.set(manifest.id, { ...manifest });
  }
  for (const manifest of markdownManifests) {
    const base = byId.get(manifest.id) ?? {};
    byId.set(manifest.id, mergeManifest(base, manifest));
  }
  for (const [roleId, override] of Object.entries(overrides.roles)) {
    if (!override || typeof override !== "object") continue;
    const base = byId.get(roleId) ?? { id: roleId };
    byId.set(roleId, mergeManifest(base, override));
  }










  const systemIds = new Set(SYSTEM_ROLE_IDS);
  const manifests = Array.from(byId.values()).map((m) => {
    let provenance = "local";
    if (builtinIds.has(m.id)) provenance = "built-in";
    else if (markdownIds.has(m.id)) provenance = "local-markdown";
    return Object.freeze({ ...m, _provenance: provenance, _system: systemIds.has(m.id) });
  });

  const result = Object.freeze({
    manifests: Object.freeze(manifests),
    routing_policy_overrides: overrides.routing_policy,
  });
  if (useCache) {
    cache.set(cacheKey, result);
  }
  return result;
}

function loadRoleById(roleId, options = {}) {
  const { manifests } = loadRoleConfig(options);
  return manifests.find((manifest) => manifest.id === roleId) ?? null;
}

function clearRoleConfigCache() {
  cache.clear();
}

function writeProjectConfig({ workspaceRoot, config }) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    throw new RoleConfigLoaderError("workspaceRoot is required");
  }
  const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
  clearRoleConfigCache();
}

function readProjectConfig(workspaceRoot) {
  return loadProjectOverrides(workspaceRoot);
}

const DEFAULT_WORKTREE_RETENTION = Object.freeze({
  cleanup_on_success: false,
  keep_last_n_per_task: 5,
});

const DEFAULT_AUTONOMOUS_WORKER_CONFIG = Object.freeze({
  enabled: false,
  max_concurrent: 1,
  poll_interval_ms: 5000,
});

function getAutonomousWorkerConfig({ workspaceRoot }) {
  try {
    const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
    if (!fs.existsSync(filePath)) return DEFAULT_AUTONOMOUS_WORKER_CONFIG;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const overrides = parsed.autonomous_worker && typeof parsed.autonomous_worker === "object"
      ? parsed.autonomous_worker
      : {};
    return {
      enabled: overrides.enabled === true,
      max_concurrent: Number.isInteger(overrides.max_concurrent) && overrides.max_concurrent > 0
        ? overrides.max_concurrent
        : DEFAULT_AUTONOMOUS_WORKER_CONFIG.max_concurrent,
      poll_interval_ms: Number.isInteger(overrides.poll_interval_ms) && overrides.poll_interval_ms >= 500
        ? overrides.poll_interval_ms
        : DEFAULT_AUTONOMOUS_WORKER_CONFIG.poll_interval_ms,
    };
  } catch {
    return DEFAULT_AUTONOMOUS_WORKER_CONFIG;
  }
}




const DEFAULT_AUTO_REPAIR_CONFIG = Object.freeze({
  enabled: false,
  max_attempts: 2,
});

function getAutoRepairConfig({ workspaceRoot }) {
  try {
    const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
    if (!fs.existsSync(filePath)) return DEFAULT_AUTO_REPAIR_CONFIG;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const overrides = parsed.auto_repair && typeof parsed.auto_repair === "object"
      ? parsed.auto_repair
      : {};
    return {
      enabled: overrides.enabled === true,
      max_attempts: Number.isInteger(overrides.max_attempts) && overrides.max_attempts > 0
        ? overrides.max_attempts
        : DEFAULT_AUTO_REPAIR_CONFIG.max_attempts,
    };
  } catch {
    return DEFAULT_AUTO_REPAIR_CONFIG;
  }
}

const DEFAULT_GOALS_CONFIG = Object.freeze({
  auto_suggest_on_intake: false,
});

function getGoalsConfig({ workspaceRoot }) {
  try {
    const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
    if (!fs.existsSync(filePath)) return DEFAULT_GOALS_CONFIG;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const overrides = parsed.goals && typeof parsed.goals === "object"
      ? parsed.goals
      : {};
    return {
      auto_suggest_on_intake: overrides.auto_suggest_on_intake === true,
    };
  } catch {
    return DEFAULT_GOALS_CONFIG;
  }
}





const DEFAULT_INTAKE_VALIDATION_CONFIG = Object.freeze({
  strict: true,
});

function getIntakeValidationConfig(_args) {
  return DEFAULT_INTAKE_VALIDATION_CONFIG;
}

const LLM_REVIEW_MODES = Object.freeze(["standard", "adversarial"]);







const DEFAULT_LLM_REVIEW_CONFIG = Object.freeze({
  enabled: false,
  mode: "standard",
  model_preferences: Object.freeze({ codex_local: null, claude_code_local: null }),
  legacy_model_preference: null,
});

function getLlmReviewConfig({ workspaceRoot }) {
  try {
    const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
    if (!fs.existsSync(filePath)) return DEFAULT_LLM_REVIEW_CONFIG;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const overrides = parsed.llm_review && typeof parsed.llm_review === "object"
      ? parsed.llm_review
      : {};
    const mode = typeof overrides.mode === "string" && LLM_REVIEW_MODES.includes(overrides.mode.trim())
      ? overrides.mode.trim()
      : DEFAULT_LLM_REVIEW_CONFIG.mode;
    const legacyPref = typeof overrides.model_preference === "string" && overrides.model_preference.trim() !== ""
      ? overrides.model_preference.trim()
      : null;
    const prefsRaw = overrides.model_preferences && typeof overrides.model_preferences === "object"
      ? overrides.model_preferences
      : {};
    const pickPref = (key) => typeof prefsRaw[key] === "string" && prefsRaw[key].trim() !== ""
      ? prefsRaw[key].trim()
      : null;
    return {
      enabled: overrides.enabled === true,
      mode,
      model_preferences: Object.freeze({
        codex_local: pickPref("codex_local"),
        claude_code_local: pickPref("claude_code_local"),
      }),
      legacy_model_preference: legacyPref,
    };
  } catch {
    return DEFAULT_LLM_REVIEW_CONFIG;
  }
}

function getWorktreeRetention({ workspaceRoot }) {
  try {
    const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
    if (!fs.existsSync(filePath)) return DEFAULT_WORKTREE_RETENTION;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const overrides = parsed.worktree_retention && typeof parsed.worktree_retention === "object"
      ? parsed.worktree_retention
      : {};
    return {
      cleanup_on_success: overrides.cleanup_on_success === true,
      keep_last_n_per_task: Number.isInteger(overrides.keep_last_n_per_task) && overrides.keep_last_n_per_task > 0
        ? overrides.keep_last_n_per_task
        : DEFAULT_WORKTREE_RETENTION.keep_last_n_per_task,
    };
  } catch {
    return DEFAULT_WORKTREE_RETENTION;
  }
}

const MERGE_POLICY_MODES = Object.freeze(["none", "auto_merge", "create_pr"]);
const CONSERVATIVE_DEFAULT_MERGE_POLICY = Object.freeze({
  base_branch: null,
  branch_per_task: false,
  isolate_single_shot: false,
  mode: "none",
});
const AUTONOMOUS_DEFAULT_MERGE_POLICY = Object.freeze({
  base_branch: null,
  branch_per_task: true,
  isolate_single_shot: true,
  mode: "create_pr",
});

const DEFAULT_MERGE_POLICY = CONSERVATIVE_DEFAULT_MERGE_POLICY;

function resolveDefaultMergePolicy({ workspaceRoot, probe = { command: probeCommandAvailable, origin: probeGitOriginAvailable } }) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    return CONSERVATIVE_DEFAULT_MERGE_POLICY;
  }
  const ghReady = probe.command("gh", ["auth", "status"]) || probe.command("gh", ["--version"]);
  const originReady = probe.origin(workspaceRoot);
  if (ghReady && originReady) return AUTONOMOUS_DEFAULT_MERGE_POLICY;
  return CONSERVATIVE_DEFAULT_MERGE_POLICY;
}

function getMergePolicy({ workspaceRoot }) {
  const defaults = resolveDefaultMergePolicy({ workspaceRoot });
  try {
    const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
    if (!fs.existsSync(filePath)) return defaults;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const overrides = parsed.merge_policy && typeof parsed.merge_policy === "object"
      ? parsed.merge_policy
      : null;
    if (!overrides) return defaults;
    const mode = typeof overrides.mode === "string" && MERGE_POLICY_MODES.includes(overrides.mode)
      ? overrides.mode
      : defaults.mode;



    const isolate_single_shot = typeof overrides.isolate_single_shot === "boolean"
      ? overrides.isolate_single_shot
      : defaults.isolate_single_shot;
    const branch_per_task = typeof overrides.branch_per_task === "boolean"
      ? overrides.branch_per_task
      : defaults.branch_per_task;
    const base_branch = typeof overrides.base_branch === "string" && overrides.base_branch.trim() !== ""
      ? overrides.base_branch.trim()
      : defaults.base_branch;
    return { base_branch, branch_per_task, isolate_single_shot, mode };
  } catch {
    return defaults;
  }
}

const DEFAULT_SUBTASK_TIMEOUT_MS = 15 * 60 * 1000;

function getSubtaskTimeoutMs({ workspaceRoot }) {
  try {
    const filePath = path.join(workspaceRoot, PROJECT_CONFIG_RELATIVE);
    if (!fs.existsSync(filePath)) return DEFAULT_SUBTASK_TIMEOUT_MS;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const value = Number(parsed.subtask_timeout_ms);
    if (Number.isFinite(value) && value >= 0) return value;
    return DEFAULT_SUBTASK_TIMEOUT_MS;
  } catch {
    return DEFAULT_SUBTASK_TIMEOUT_MS;
  }
}

export {
  AUTONOMOUS_DEFAULT_MERGE_POLICY,
  CONSERVATIVE_DEFAULT_MERGE_POLICY,
  DEFAULT_MERGE_POLICY,
  DEFAULT_AUTONOMOUS_WORKER_CONFIG,
  DEFAULT_AUTO_REPAIR_CONFIG,
  DEFAULT_GOALS_CONFIG,
  DEFAULT_INTAKE_VALIDATION_CONFIG,
  DEFAULT_LLM_REVIEW_CONFIG,
  LLM_REVIEW_MODES,
  DEFAULT_SUBTASK_TIMEOUT_MS,
  DEFAULT_WORKTREE_RETENTION,
  MERGE_POLICY_MODES,
  PROJECT_CONFIG_RELATIVE,
  RoleConfigLoaderError,
  clearCapabilityCache,
  clearRoleConfigCache,
  getAutonomousWorkerConfig,
  getAutoRepairConfig,
  getGoalsConfig,
  getIntakeValidationConfig,
  getLlmReviewConfig,
  getMergePolicy,
  getSubtaskTimeoutMs,
  getWorktreeRetention,
  resolveDefaultMergePolicy,
  loadProjectOverrides,
  loadRoleById,
  loadRoleConfig,
  parseFrontmatter,
  readProjectConfig,
  writeProjectConfig,
};
