





















const DIFF_FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const DIFF_HUNK_HEADER_RE = /^@@\s/;
const MALICIOUS_HOOK_PATTERN = /\b(rm\s+-rf|curl\s+[^|\n]+\|\s*(?:sh|bash|zsh)|wget\s+[^|\n]+\|\s*(?:sh|bash|zsh))\b/i;



const NPM_DEPENDENCY_RE = /^\s*"([a-z0-9@][a-z0-9@\-_/.]*)"\s*:\s*"[^"]+"/i;



const TYPOSQUAT_NEAR_NEIGHBORS = Object.freeze([
  "react", "vue", "angular", "lodash", "express", "axios", "chalk",
  "commander", "debug", "moment", "dotenv", "typescript", "webpack",
  "jest", "eslint", "prettier", "ajv", "yargs",
]);

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return prev[n];
}

function findTyposquatNeighbor(name) {
  if (typeof name !== "string" || name.length < 3) return null;
  if (TYPOSQUAT_NEAR_NEIGHBORS.includes(name)) return null;
  for (const neighbor of TYPOSQUAT_NEAR_NEIGHBORS) {
    if (neighbor.length < 3) continue;
    const distance = levenshtein(name, neighbor);
    if (distance > 0 && distance <= 2 && Math.abs(name.length - neighbor.length) <= 2) {
      return neighbor;
    }
  }
  return null;
}

function inferSurfaceType(filePath, surfaceTypePrefix) {
  const prefix = surfaceTypePrefix || "code_change";
  const lowered = filePath.toLowerCase();
  if (/\.(sh|bash|zsh|fish)$/.test(lowered)) return `${prefix}:shell_script`;
  if (/dockerfile(\..*)?$/.test(lowered)) return `${prefix}:dockerfile`;
  if (/\.github\/workflows\//.test(lowered) || /\.gitlab-ci\.ya?ml$/.test(lowered)) {
    return `${prefix}:ci_pipeline`;
  }
  if (lowered.endsWith("package.json")) return `${prefix}:package_manifest`;
  if (lowered.endsWith("pyproject.toml") || /requirements.*\.txt$/.test(lowered)) {
    return `${prefix}:python_manifest`;
  }
  if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(lowered)) return `${prefix}:js_source`;
  if (/\.py$/.test(lowered)) return `${prefix}:python_source`;
  return `${prefix}:generic`;
}


function parseUnifiedDiff(diffText) {
  const perFile = new Map();
  if (typeof diffText !== "string" || diffText.trim() === "") return perFile;
  const lines = diffText.split(/\r?\n/);
  let currentFile = null;
  let insideHunk = false;
  for (const line of lines) {
    const headerMatch = line.match(DIFF_FILE_HEADER_RE);
    if (headerMatch) {

      currentFile = headerMatch[2];
      insideHunk = false;
      if (!perFile.has(currentFile)) {
        perFile.set(currentFile, { addedLines: [], removedLines: [] });
      }
      continue;
    }
    if (!currentFile) continue;
    if (DIFF_HUNK_HEADER_RE.test(line)) {
      insideHunk = true;
      continue;
    }
    if (!insideHunk) continue;

    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      perFile.get(currentFile).addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      perFile.get(currentFile).removedLines.push(line.slice(1));
    }

  }
  return perFile;
}

function codeChangesToSurfaces(diffText, options = {}) {
  const surfaceTypePrefix = typeof options.surfaceTypePrefix === "string"
    ? options.surfaceTypePrefix
    : "code_change";
  const maxSurfaces = Number.isInteger(options.maxSurfaces) && options.maxSurfaces > 0
    ? options.maxSurfaces
    : 200;
  const perFile = parseUnifiedDiff(diffText);
  const surfaces = [];
  for (const [filePath, { addedLines }] of perFile) {
    if (surfaces.length >= maxSurfaces) break;
    if (addedLines.length === 0) continue;
    const content = addedLines.join("\n");
    const hooks = addedLines.filter((line) => MALICIOUS_HOOK_PATTERN.test(line));

    let similarTo = null;
    let typosquatCandidate = false;
    if (/package\.json$/.test(filePath)) {
      for (const line of addedLines) {
        const depMatch = line.match(NPM_DEPENDENCY_RE);
        if (!depMatch) continue;
        const neighbor = findTyposquatNeighbor(depMatch[1]);
        if (neighbor) {
          similarTo = neighbor;
          typosquatCandidate = true;
          break;
        }
      }
    }
    surfaces.push({
      capabilities: [],
      content,
      hooks,
      id: `code-change:${filePath}`,
      name: filePath,
      similar_to: similarTo,
      typosquatting_candidate: typosquatCandidate,
      type: inferSurfaceType(filePath, surfaceTypePrefix),
    });
  }
  return surfaces;
}

export {
  codeChangesToSurfaces,
  parseUnifiedDiff,
};
