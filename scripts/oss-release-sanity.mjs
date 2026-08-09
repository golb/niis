#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXPECTED_WORKSPACES = ["packages/cli", "packages/core", "packages/ui"];
const EXPECTED_REPOSITORY_URL = "git+https://github.com/golb/niis.git";
const EXPECTED_HOMEPAGE = "https://github.com/golb/niis#readme";
const EXPECTED_BUGS_URL = "https://github.com/golb/niis/issues";
const REQUIRED_BUNDLED_NOTICES = [
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "prismjs",
  "prism-themes",
];
const ALLOWED_PUBLIC_DOCS = new Set([
  "docs/architecture/storage-boundary.md",
  "docs/guides/bootstrap-command-surface.md",
  "docs/testing/reference-leak-sanity.md",
]);
const FORBIDDEN_PATHS = [
  "docs/guides/authoring-package-agents.md",
  "docs/guides/context-contracts.md",
];
const FORBIDDEN_ASSET_EXTENSIONS = /\.(?:gif|jpe?g|png|ttf|woff2?)$/iu;
const REVIEWED_BINARY_ASSETS = new Map([
  ["assets/readme/niis-promenade-watercolor.png", "aa17b638f649cf633722e81107f10643aa91ec2ef0c924234c40700cf7f26957"],
]);
const PARENT_VALIDATION_ROOT = /--(?:host-root|validation-surface-root)[ \t]+\.\.(?=$|[\s`"'])/mu;
const INTERNAL_MILESTONE_COORDINATE = /(?:\bNIIS-\d[\w-]*\b|(?<!-)\bPhase \d+\b)/iu;
const COPYLEFT_LICENSE = /(?:^|[^A-Z])(?:A?GPL|LGPL)(?:[^A-Z]|$)/iu;
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const FORBIDDEN_TEXT_FINGERPRINTS = new Map([
  ["5e612276c5155b1caa408351e70e59ca476e20d3829d8a14b1828ebda4c7dfb1", "oss-fingerprint-001"],
  ["ca0b642ed0c1c9902c3e9c8ac00865e0a9cf6449f66012e1c6948b66818f26ff", "oss-fingerprint-002"],
  ["3f40462915a3e6026a4d790127b95ded4d870f6ab18d9af2fcbc454168255237", "oss-fingerprint-003"],
  ["d8bb1ccccda38c8fdae9fea7ed584e141ac16afe05abf6bddd2ad1815ba4c2f6", "oss-fingerprint-004"],
]);

function findForbiddenTextFingerprint(value, fingerprints) {
  const lines = String(value).normalize("NFKC").toLocaleLowerCase("und").split(/\r?\n/u);
  for (let line = 0; line < lines.length; line += 1) {
    for (const token of lines[line].match(/[\p{L}\p{N}]+/gu) ?? []) {
      const digest = createHash("sha256").update(token, "utf8").digest("hex");
      const id = fingerprints.get(digest);
      if (id) return { id, line: line + 1 };
    }
  }
  return null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeMilestoneText(value) {
  return String(value).replace(/(?:&nbsp;|&#0*160;|&#x0*a0;|\u00a0)/giu, " ");
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function canStartRegex(text, index) {
  const prefix = text.slice(0, index).trimEnd();
  if (prefix.length === 0) return true;
  const last = prefix.at(-1);
  if ("([{:;,=!?&|+-*%^~<>".includes(last)) return true;
  const word = prefix.match(/([\p{L}_$][\p{L}\p{N}_$]*)$/u)?.[1];
  return new Set(["await", "case", "delete", "in", "instanceof", "of", "return", "throw", "typeof", "void", "yield"]).has(word);
}

function findCssComment(text) {
  const blockMarker = "/" + "*";
  let quote = null;
  for (let index = 0, line = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") line += 1;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (text.startsWith(blockMarker, index)) return { kind: "block", line };
  }
  return null;
}

function findShellComment(text) {
  const lines = text.split(/\r?\n/u);
  for (let line = 0; line < lines.length; line += 1) {
    const trimmed = lines[line].trimStart();
    if (trimmed.startsWith("#") && !(line === 0 && trimmed.startsWith("#!"))) {
      return { kind: "line", line: line + 1 };
    }
  }
  return null;
}

function findMarkdownCodeComment(text) {
  const languagePaths = new Map([
    ["bash", "snippet.sh"], ["cjs", "snippet.cjs"], ["css", "snippet.css"],
    ["html", "snippet.html"], ["javascript", "snippet.js"], ["js", "snippet.js"],
    ["jsx", "snippet.jsx"], ["mjs", "snippet.mjs"], ["scss", "snippet.scss"],
    ["sh", "snippet.sh"], ["shell", "snippet.sh"], ["ts", "snippet.ts"],
    ["tsx", "snippet.tsx"], ["zsh", "snippet.sh"],
  ]);
  const fences = /^```([^\s`]*)[^\n]*\n([\s\S]*?)^```/gmu;
  for (const match of text.matchAll(fences)) {
    const virtualPath = languagePaths.get(match[1].toLowerCase());
    if (!virtualPath) continue;
    const finding = findCodeComment(match[2], virtualPath);
    if (finding) return { ...finding, line: lineAt(text, match.index) + finding.line };
  }
  return null;
}

export function findCodeComment(value, path) {
  const text = String(value);
  const extension = extname(path).toLowerCase();
  const lineMarker = "/" + "/";
  const htmlMarker = "<" + "!--";
  if (extension === ".md") return findMarkdownCodeComment(text);
  if ([".css", ".scss"].includes(extension)) return findCssComment(text);
  if ([".bash", ".sh", ".zsh"].includes(extension)) return findShellComment(text);
  if ([".htm", ".html"].includes(extension)) {
    const htmlIndex = text.indexOf(htmlMarker);
    return htmlIndex === -1 ? null : { kind: "html", line: lineAt(text, htmlIndex) };
  }
  const isJavaScript = JAVASCRIPT_EXTENSIONS.has(extension)
    || (extension === "" && /^#![^\n]*\bnode\b/u.test(text));
  if (!isJavaScript) return null;
  const rawLines = text.split(/\r?\n/u);
  const rawLine = rawLines.findIndex((line) => line.trimStart().startsWith(lineMarker));
  if (rawLine !== -1) return { kind: "line", line: rawLine + 1 };
  let mode = "code";
  let line = 1;
  const templateDepths = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === "\n") line += 1;
    if (mode === "single" || mode === "double") {
      if (character === "\\") {
        if (next === "\n") line += 1;
        index += 1;
      } else if ((mode === "single" && character === "'") || (mode === "double" && character === '"')) {
        mode = "code";
      }
      continue;
    }
    if (mode === "template") {
      if (character === "\\") {
        if (next === "\n") line += 1;
        index += 1;
      } else if (character === "`") {
        mode = "code";
      } else if (character === "$" && next === "{") {
        templateDepths.push(1);
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (character === "'") {
      mode = "single";
      continue;
    }
    if (character === '"') {
      mode = "double";
      continue;
    }
    if (character === "`") {
      mode = "template";
      continue;
    }
    if (character === "/" && next === "/") return { kind: "line", line };
    if (character === "/" && next === "*") return { kind: "block", line };
    if (character === "/" && canStartRegex(text, index)) {
      let inClass = false;
      for (index += 1; index < text.length; index += 1) {
        const regexCharacter = text[index];
        if (regexCharacter === "\n") line += 1;
        if (regexCharacter === "\\") index += 1;
        else if (regexCharacter === "[") inClass = true;
        else if (regexCharacter === "]") inClass = false;
        else if (regexCharacter === "/" && !inClass) break;
      }
      continue;
    }
    if (templateDepths.length > 0) {
      if (character === "{") templateDepths[templateDepths.length - 1] += 1;
      else if (character === "}") {
        templateDepths[templateDepths.length - 1] -= 1;
        if (templateDepths.at(-1) === 0) {
          templateDepths.pop();
          mode = "template";
        }
      }
    }
  }
  return null;
}

function walk(root, directory = root, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".niis", "node_modules", ".dist", "dist", "build", "coverage"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    const displayPath = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) walk(root, path, output);
    else if (entry.isFile() || entry.isSymbolicLink()) output.push(displayPath);
  }
  return output;
}

export function inspectDistributionTree(root = DEFAULT_ROOT, {
  forbiddenTextFingerprints = FORBIDDEN_TEXT_FINGERPRINTS,
} = {}) {
  const resolvedRoot = realpathSync(root);
  const errors = [];
  const manifestPath = join(resolvedRoot, "package.json");
  const licensePath = join(resolvedRoot, "LICENSE");
  const noticesPath = join(resolvedRoot, "THIRD_PARTY_NOTICES.md");
  const lockPath = join(resolvedRoot, "package-lock.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;

  if (!manifest) errors.push("package.json is missing");
  else {
    if (manifest.name !== "niis") errors.push("package name must be niis");
    if (manifest.private !== true) errors.push("package must remain private:true");
    if (manifest.license !== "SEE LICENSE IN LICENSE") {
      errors.push("package license must point to the source-available LICENSE");
    }
    if (manifest.repository?.type !== "git" || manifest.repository?.url !== EXPECTED_REPOSITORY_URL) {
      errors.push("package repository metadata must identify golb/niis");
    }
    if (manifest.homepage !== EXPECTED_HOMEPAGE) errors.push("package homepage must identify golb/niis");
    if (manifest.bugs?.url !== EXPECTED_BUGS_URL) errors.push("package bugs URL must identify golb/niis");
    if (JSON.stringify(manifest.workspaces) !== JSON.stringify(EXPECTED_WORKSPACES)) {
      errors.push("workspaces must contain only cli, core, and ui");
    }
  }

  if (!existsSync(licensePath) || !readFileSync(licensePath, "utf8").startsWith("Niis Source-Available License Agreement\n")) {
    errors.push("root source-available LICENSE is missing or invalid");
  }
  if (!existsSync(noticesPath)) errors.push("THIRD_PARTY_NOTICES.md is missing");
  else {
    const notices = readFileSync(noticesPath, "utf8");
    for (const dependency of REQUIRED_BUNDLED_NOTICES) {
      if (!notices.includes(dependency)) errors.push(`third-party notice is missing: ${dependency}`);
    }
  }
  const packageManifests = new Map(EXPECTED_WORKSPACES.map((workspace) => [
    workspace,
    join(resolvedRoot, workspace, "package.json"),
  ]));
  if ([...packageManifests.values()].some((path) => !existsSync(path))) {
    errors.push("distribution package manifests are missing");
  } else {
    const manifests = new Map([...packageManifests].map(([workspace, path]) => [workspace, readJson(path)]));
    for (const [workspace, packageManifest] of manifests) {
      if (packageManifest.private !== true) errors.push(`${workspace} must remain private:true`);
      if (packageManifest.license !== "SEE LICENSE IN ../../LICENSE") {
        errors.push(`${workspace} license must point to the root LICENSE`);
      }
    }
    const cliManifest = manifests.get("packages/cli");
    const uiManifest = manifests.get("packages/ui");
    for (const dependency of ["prismjs", "prism-themes"]) {
      if (!cliManifest.dependencies?.[dependency]) errors.push(`CLI dependency is missing: ${dependency}`);
      if (uiManifest.dependencies?.[dependency]) errors.push(`UI must not own server dependency: ${dependency}`);
    }
  }
  for (const relativePath of ["config/pricing.json", "config/role-manifests/generalist-worker.md"]) {
    if (!existsSync(join(resolvedRoot, relativePath))) errors.push(`runtime config is missing: ${relativePath}`);
  }
  const readmePath = join(resolvedRoot, "README.md");
  if (existsSync(readmePath) && /\bnpx\b/u.test(readFileSync(readmePath, "utf8"))) {
    errors.push("README must not invoke npx for a repository installation");
  }
  for (const path of FORBIDDEN_PATHS) {
    if (existsSync(join(resolvedRoot, path))) errors.push(`excluded path is present: ${path}`);
  }

  const files = walk(resolvedRoot);
  for (const path of files) {
    if (path.startsWith("docs/") && !ALLOWED_PUBLIC_DOCS.has(path)) {
      errors.push(`non-allowlisted public documentation is present: ${path}`);
    }
    const pathFinding = findForbiddenTextFingerprint(path, forbiddenTextFingerprints);
    if (pathFinding) errors.push(`private fingerprint ${pathFinding.id} is present in path: ${path}`);
    if (FORBIDDEN_ASSET_EXTENSIONS.test(path)) {
      const digest = createHash("sha256").update(readFileSync(join(resolvedRoot, path))).digest("hex");
      if (REVIEWED_BINARY_ASSETS.get(path) !== digest) errors.push(`unreviewed binary asset is present: ${path}`);
    }
    if (/(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials\.json)$/iu.test(path)) {
      errors.push(`credential-bearing path is present: ${path}`);
    }
    if (lstatSync(join(resolvedRoot, path)).isSymbolicLink()) continue;
    const buffer = readFileSync(join(resolvedRoot, path));
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    const localPathMarkers = ["/" + "Users/", "/" + "home/", ":\\" + "Users\\"];
    if (localPathMarkers.some((marker) => text.includes(marker))) {
      errors.push(`absolute local path is present: ${path}`);
    }
    const textFinding = findForbiddenTextFingerprint(text, forbiddenTextFingerprints);
    if (textFinding) {
      errors.push(`private fingerprint ${textFinding.id} is present: ${path}:${textFinding.line}`);
    }
    if (PARENT_VALIDATION_ROOT.test(text)) {
      errors.push(`parent-directory validation root is present: ${path}`);
    }
    if (INTERNAL_MILESTONE_COORDINATE.test(normalizeMilestoneText(text))) {
      errors.push(`internal milestone coordinate is present: ${path}`);
    }
    const comment = findCodeComment(text, path);
    if (comment) errors.push(`code comment is present: ${path}:${comment.line} (${comment.kind})`);
  }

  if (!existsSync(lockPath)) errors.push("package-lock.json is missing");
  else {
    const lock = readJson(lockPath);
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      if (!path.startsWith("node_modules/") || entry.link) continue;
      if (!entry.license) errors.push(`dependency license is unknown: ${path}`);
      else if (COPYLEFT_LICENSE.test(entry.license)) errors.push(`copyleft dependency is present: ${path}`);
    }
  }

  return { ok: errors.length === 0, errors, files: files.length };
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? DEFAULT_ROOT : resolve(process.argv[rootIndex + 1]);
  const result = inspectDistributionTree(root);
  if (result.ok) process.stdout.write(`Distribution sanity check passed (${result.files} files)\n`);
  else {
    process.stderr.write(`Distribution sanity check failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) main();
