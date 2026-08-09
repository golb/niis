#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = join(SCRIPT_ROOT, "config", "reference-fingerprints.json");
const HASH_ALGORITHM = "sha256";
const NORMALIZATION_VERSION = "nfkc-casefold-url-compact-v1";
const BASELINE_FINGERPRINT_IDS = Object.freeze(
  Array.from({ length: 42 }, (_, index) => `reference-${String(index + 1).padStart(3, "0")}`),
);
const ROLLING_BASE = 16_777_619;
const GENERATED_DIRECTORY_NAMES = new Set([".dist", "build", "coverage", "dist", "generated"]);
const WALK_SKIP_NAMES = new Set([
  ".git",
  ".niis",
  ".tmp",
  "node_modules",
  "proof-outputs",
  "proofs-output",
  "tmp",
]);

function decodePercentEscapes(value) {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

function caseFold(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("\u00df", "ss")
    .replaceAll("\u03c2", "\u03c3");
}

export function normalizeCompact(value) {
  return Array.from(caseFold(decodePercentEscapes(String(value))))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

export function fingerprintDigest(value) {
  return createHash(HASH_ALGORITHM).update(value, "utf8").digest("hex");
}

export function rollingDigest(value) {
  let digest = 0;
  for (const character of Array.from(String(value))) {
    digest = (Math.imul(digest, ROLLING_BASE) + character.codePointAt(0)) >>> 0;
  }
  return digest.toString(16).padStart(8, "0");
}

function tokenizeWithLines(value) {
  const tokens = [];
  const lines = caseFold(decodePercentEscapes(String(value))).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(/[\p{L}\p{N}]+/gu)) {
      const normalized = normalizeCompact(match[0]);
      if (normalized) {
        tokens.push({
          characters: Array.from(normalized),
          line: index + 1,
        });
      }
    }
  }
  return tokens;
}

function validateFingerprintConfig(config, configPath = "<config>") {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${configPath}: fingerprint config must be an object`);
  }
  const topLevelKeys = Object.keys(config).sort();
  const expectedTopLevelKeys = ["algorithm", "fingerprints", "normalization", "schemaVersion"];
  if (JSON.stringify(topLevelKeys) !== JSON.stringify(expectedTopLevelKeys)) {
    throw new Error(
      `${configPath}: only schemaVersion, algorithm, normalization, and fingerprints are allowed`,
    );
  }
  if (
    config.schemaVersion !== 1 ||
    config.algorithm !== HASH_ALGORITHM ||
    config.normalization !== NORMALIZATION_VERSION ||
    !Array.isArray(config.fingerprints)
  ) {
    throw new Error(`${configPath}: unsupported fingerprint config version`);
  }

  const ids = new Set();
  for (const entry of config.fingerprints) {
    const entryKeys = Object.keys(entry).sort();
    const expectedEntryKeys = [
      "digest",
      "id",
      "match",
      "normalizedLength",
      "rollingDigest",
    ];
    if (JSON.stringify(entryKeys) !== JSON.stringify(expectedEntryKeys)) {
      throw new Error(
        `${configPath}: fingerprint entries may contain only id, digest, rollingDigest, match, and normalizedLength`,
      );
    }
    if (!/^reference-[0-9]{3}$/u.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`${configPath}: fingerprint IDs must be unique neutral identifiers`);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.digest)) {
      throw new Error(`${configPath}: ${entry.id} has an invalid SHA-256 digest`);
    }
    if (!/^[a-f0-9]{8}$/u.test(entry.rollingDigest)) {
      throw new Error(`${configPath}: ${entry.id} has an invalid rolling digest`);
    }
    if (!Number.isSafeInteger(entry.normalizedLength) || entry.normalizedLength < 2) {
      throw new Error(`${configPath}: ${entry.id} has an invalid normalized length`);
    }
    if (!["stream", "token"].includes(entry.match)) {
      throw new Error(`${configPath}: ${entry.id} has an invalid match mode`);
    }
    if (entry.match === "token" && entry.normalizedLength > 8) {
      throw new Error(`${configPath}: token matching is reserved for short fingerprints`);
    }
    ids.add(entry.id);
  }
  for (const id of BASELINE_FINGERPRINT_IDS) {
    if (!ids.has(id)) {
      throw new Error(`${configPath}: required baseline fingerprint ${id} is missing`);
    }
  }
  return config;
}

export function loadFingerprintConfig(configPath = DEFAULT_CONFIG) {
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  return validateFingerprintConfig(parsed, configPath);
}

export function scanText(text, fingerprints, displayPath = "<text>") {
  const findings = [];
  const entriesByStreamLength = new Map();
  const tokenEntries = [];

  for (const entry of fingerprints) {
    if (entry.match === "token") {
      tokenEntries.push(entry);
      continue;
    }
    const entries = entriesByStreamLength.get(entry.normalizedLength) ?? [];
    entries.push(entry);
    entriesByStreamLength.set(entry.normalizedLength, entries);
  }

  const lines = String(text).split(/\r?\n/u);
  const compactCharacters = [];
  const compactLineNumbers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const compact = normalizeCompact(line);
    for (const character of Array.from(compact)) {
      compactCharacters.push(character);
      compactLineNumbers.push(lineNumber);
    }
  }

  if (tokenEntries.length > 0) {
    const entriesByLengthAndRollingDigest = new Map();
    let maximumTokenLength = 0;
    for (const entry of tokenEntries) {
      maximumTokenLength = Math.max(maximumTokenLength, entry.normalizedLength);
      const byRollingDigest =
        entriesByLengthAndRollingDigest.get(entry.normalizedLength) ?? new Map();
      const candidates = byRollingDigest.get(entry.rollingDigest) ?? [];
      candidates.push(entry);
      byRollingDigest.set(entry.rollingDigest, candidates);
      entriesByLengthAndRollingDigest.set(entry.normalizedLength, byRollingDigest);
    }

    const tokens = tokenizeWithLines(text);
    const reported = new Set();
    for (let start = 0; start < tokens.length; start += 1) {
      const merged = [];
      for (let cursor = start; cursor < tokens.length; cursor += 1) {
        merged.push(...tokens[cursor].characters);
        if (merged.length > maximumTokenLength) break;
        const byRollingDigest = entriesByLengthAndRollingDigest.get(merged.length);
        if (!byRollingDigest) continue;
        const normalized = merged.join("");
        const candidates = byRollingDigest.get(rollingDigest(normalized));
        if (!candidates) continue;
        const digest = fingerprintDigest(normalized);
        for (const entry of candidates) {
          if (entry.digest !== digest) continue;
          const line = tokens[start].line;
          const findingKey = `${entry.id}\0${line}`;
          if (reported.has(findingKey)) continue;
          reported.add(findingKey);
          findings.push({ file: displayPath, line, fingerprintId: entry.id });
        }
      }
    }
  }




  for (const [length, entries] of entriesByStreamLength.entries()) {
    if (compactCharacters.length < length) continue;
    const entriesByRollingDigest = new Map();
    for (const entry of entries) {
      const candidates = entriesByRollingDigest.get(entry.rollingDigest) ?? [];
      candidates.push(entry);
      entriesByRollingDigest.set(entry.rollingDigest, candidates);
    }
    let highestPower = 1;
    for (let power = 1; power < length; power += 1) {
      highestPower = Math.imul(highestPower, ROLLING_BASE) >>> 0;
    }
    let windowDigest = 0;
    for (let offset = 0; offset < length; offset += 1) {
      windowDigest = (
        Math.imul(windowDigest, ROLLING_BASE) +
        compactCharacters[offset].codePointAt(0)
      ) >>> 0;
    }
    const reported = new Set();
    for (let offset = 0; offset <= compactCharacters.length - length; offset += 1) {
      const rollingKey = windowDigest.toString(16).padStart(8, "0");
      const candidates = entriesByRollingDigest.get(rollingKey);
      if (candidates) {
        const digest = fingerprintDigest(
          compactCharacters.slice(offset, offset + length).join(""),
        );
        const line = compactLineNumbers[offset] ?? 1;
        for (const entry of candidates) {
          if (entry.digest !== digest) continue;
          const findingKey = `${entry.id}\0${line}`;
          if (reported.has(findingKey)) continue;
          reported.add(findingKey);
          findings.push({ file: displayPath, line, fingerprintId: entry.id });
        }
      }
      if (offset < compactCharacters.length - length) {
        const leading = compactCharacters[offset].codePointAt(0);
        const trailing = compactCharacters[offset + length].codePointAt(0);
        windowDigest = (
          Math.imul(
            (windowDigest - Math.imul(leading, highestPower)) >>> 0,
            ROLLING_BASE,
          ) + trailing
        ) >>> 0;
      }
    }
  }

  return findings;
}

function bufferToText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    try {
      return new TextDecoder("utf-16le", { fatal: true }).decode(buffer.subarray(2));
    } catch {
      return null;
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    try {
      return new TextDecoder("utf-16be", { fatal: true }).decode(buffer.subarray(2));
    } catch {
      return null;
    }
  }
  if (buffer.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function scanPath(path, displayPath, fingerprints, contentCache = null) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return scanText(readlinkSync(path), fingerprints, `${displayPath}:symlink`);
  }
  if (!stat.isFile()) {
    return [];
  }
  const buffer = readFileSync(path);
  const text = bufferToText(buffer);
  if (text === null) {
    return [];
  }
  if (!contentCache) {
    return scanText(text, fingerprints, displayPath);
  }
  const cacheKey = createHash(HASH_ALGORITHM).update(buffer).digest("hex");
  let cached = contentCache.get(cacheKey);
  if (!cached) {
    cached = scanText(text, fingerprints).map(({ line, fingerprintId }) => ({
      line,
      fingerprintId,
    }));
    contentCache.set(cacheKey, cached);
  }
  return cached.map((finding) => ({ ...finding, file: displayPath }));
}

function listGitCandidateFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output.split("\0").filter(Boolean);
}

function resolveRepositoryRoot(root) {
  return realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
  );
}

function walkFiles(root, base = root, skipNames = WALK_SKIP_NAMES) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipNames.has(entry.name)) {
        files.push(...walkFiles(join(root, entry.name), base, skipNames));
      }
      continue;
    }
    files.push(relative(base, join(root, entry.name)));
  }
  return files;
}

export function listArtifactFiles(root) {
  return walkFiles(root, root, new Set());
}

function listGeneratedFiles(root) {
  const files = [];

  function discover(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || WALK_SKIP_NAMES.has(entry.name)) {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (GENERATED_DIRECTORY_NAMES.has(entry.name)) {
        files.push(
          ...listArtifactFiles(absolute).map((file) => relative(root, join(absolute, file))),
        );
      } else {
        discover(absolute);
      }
    }
  }

  discover(root);
  return files;
}

function resolveGitCommit(root, candidate) {
  return execFileSync("git", ["merge-base", "HEAD", candidate], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveMergeBase(root, environment = process.env) {
  if (environment.SANITY_MERGE_BASE) {
    try {
      return resolveGitCommit(root, environment.SANITY_MERGE_BASE);
    } catch {
      throw new Error(
        `unable to resolve SANITY_MERGE_BASE=${environment.SANITY_MERGE_BASE}; ` +
          "check out the requested base revision before running the clean-room gate",
      );
    }
  }

  const candidates = [
    environment.GITHUB_BASE_REF ? `origin/${environment.GITHUB_BASE_REF}` : null,
    "origin/main",
    "main",
    "origin/master",
    "master",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return resolveGitCommit(root, candidate);
    } catch {

    }
  }

  if (environment.CI || environment.GITHUB_ACTIONS) {
    throw new Error(
      "unable to resolve a merge base in CI; check out full Git history or set SANITY_MERGE_BASE",
    );
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {

  }
  return null;
}

export function scanAddedDiff(root, fingerprints, pathspecs = ["."]) {
  const mergeBase = resolveMergeBase(root);
  if (!mergeBase) {
    return { findings: [], mergeBase: null };
  }
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--relative",
      "--no-ext-diff",
      "--no-color",
      "--unified=0",
      mergeBase,
      "--",
      ...pathspecs,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const findings = [];
  let currentFile = "<diff>";
  let nextLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      nextLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      findings.push(...scanText(line.slice(1), fingerprints, `diff:${currentFile}`).map(
        (finding) => ({ ...finding, line: nextLine }),
      ));
      nextLine += 1;
      continue;
    }
    if (!line.startsWith("-") && !line.startsWith("\\")) {
      nextLine += 1;
    }
  }

  return { findings, mergeBase };
}

function scanFileSet(
  root,
  filePaths,
  fingerprints,
  prefix = "",
  contentCache = null,
) {
  const findings = [];
  const seen = new Set();
  for (const filePath of filePaths) {
    const normalizedPath = filePath.split(sep).join("/");
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    try {




      lstatSync(join(root, filePath));
      findings.push(...scanText(normalizedPath, fingerprints, `${prefix}${normalizedPath}:path`));
      findings.push(
        ...scanPath(
          join(root, filePath),
          `${prefix}${normalizedPath}`,
          fingerprints,
          contentCache,
        ),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return findings;
}

export function scanArtifactDirectory(
  root,
  fingerprints,
  prefix = "artifact:",
  contentCache = null,
) {
  const files = listArtifactFiles(root);
  return {
    findings: scanFileSet(root, files, fingerprints, prefix, contentCache),
    fileCount: files.length,
  };
}

function parsePackJson(stdout) {
  const start = stdout.indexOf("[");
  if (start === -1) {
    throw new Error("npm pack did not return JSON metadata");
  }
  const metadata = JSON.parse(stdout.slice(start));
  if (!Array.isArray(metadata) || metadata.length !== 1 || !metadata[0]?.filename) {
    throw new Error("npm pack returned unexpected metadata");
  }
  return metadata[0];
}

function scanTarballArtifact({
  archivePath,
  extractionRoot,
  fingerprints,
  prefix,
  contentCache,
}) {
  mkdirSync(extractionRoot, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractionRoot], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const packageRoot = join(extractionRoot, "package");
  if (!existsSync(packageRoot)) {
    throw new Error(`${prefix} archive does not contain a package root`);
  }
  return scanArtifactDirectory(packageRoot, fingerprints, prefix, contentCache);
}

function scanPackageArtifact(root, fingerprints, contentCache) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-pack-"));
  try {
    const packed = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: join(temporaryRoot, "npm-cache"),
          npm_config_dry_run: "false",
        },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (packed.status !== 0) {
      throw new Error(`npm pack failed: ${(packed.stderr || packed.stdout).trim()}`);
    }
    const metadata = parsePackJson(packed.stdout);
    const archivePath = join(temporaryRoot, basename(metadata.filename));
    const extractedRoot = join(temporaryRoot, "extracted");
    return scanTarballArtifact({
      archivePath,
      extractionRoot: extractedRoot,
      fingerprints,
      prefix: "package:",
      contentCache,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function scanNpxDistributable(root, fingerprints, contentCache = null) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-npx-"));
  try {
    const outputRoot = join(temporaryRoot, "build");
    const archivePath = join(temporaryRoot, "niis-cli.tgz");
    const builderPath = join(root, "packages", "cli", "scripts", "pack-npx-cli.js");
    if (!existsSync(builderPath)) {
      throw new Error("npx distributable builder is missing");
    }
    const built = spawnSync(process.execPath, [builderPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NIIS_NPX_PACK_OUT: outputRoot,
        NIIS_NPX_TARBALL_OUT: archivePath,
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (built.status !== 0) {
      throw new Error(
        `npx distributable build failed: ${(built.stderr || built.stdout).trim()}`,
      );
    }
    if (!existsSync(archivePath)) {
      throw new Error("npx distributable build did not create the expected archive");
    }
    return scanTarballArtifact({
      archivePath,
      extractionRoot: join(temporaryRoot, "extracted"),
      fingerprints,
      prefix: "distributable:",
      contentCache,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.file}\0${finding.line}\0${finding.fingerprintId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function runSanityCheck({
  root = SCRIPT_ROOT,
  configPath = DEFAULT_CONFIG,
  scanPackage = true,
  useGit = true,
} = {}) {
  const resolvedRoot = realpathSync(root);
  const config = loadFingerprintConfig(configPath);
  const contentCache = new Map();
  const repositoryRoot = useGit ? resolveRepositoryRoot(resolvedRoot) : null;
  const projectPathspec = repositoryRoot ? relative(repositoryRoot, resolvedRoot) || "." : null;
  const gitFiles = useGit ? listGitCandidateFiles(resolvedRoot) : walkFiles(resolvedRoot);
  const generatedFiles = listGeneratedFiles(resolvedRoot);
  const treeFindings = scanFileSet(
    resolvedRoot,
    [...gitFiles, ...generatedFiles],
    config.fingerprints,
    "",
    contentCache,
  );
  const diffResult = repositoryRoot
    ? scanAddedDiff(repositoryRoot, config.fingerprints, [projectPathspec])
    : { findings: [], mergeBase: null };
  const packageResult = scanPackage
    ? scanPackageArtifact(resolvedRoot, config.fingerprints, contentCache)
    : { findings: [], fileCount: 0 };
  const distributableResult = scanPackage
    ? scanNpxDistributable(resolvedRoot, config.fingerprints, contentCache)
    : { findings: [], fileCount: 0 };
  const findings = uniqueFindings([
    ...treeFindings,
    ...diffResult.findings,
    ...packageResult.findings,
    ...distributableResult.findings,
  ]);

  return {
    ok: findings.length === 0,
    findings,
    counts: {
      candidateFiles: new Set(gitFiles).size,
      generatedFiles: new Set(generatedFiles).size,
      packageFiles: packageResult.fileCount,
      distributableFiles: distributableResult.fileCount,
    },
    mergeBase: diffResult.mergeBase,
    packageScanned: scanPackage,
  };
}

function readStdin() {
  return readFileSync(0, "utf8").replace(/\r?\n$/u, "");
}

function parseArguments(argv) {
  const options = {
    root: SCRIPT_ROOT,
    configPath: DEFAULT_CONFIG,
    scanPackage: true,
    json: false,
    hashStdin: false,
    useGit: process.env.NIIS_REFERENCE_NO_GIT !== "1",
    id: null,
    match: "stream",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      options.root = resolve(argv[++index]);
    } else if (argument === "--config") {
      options.configPath = resolve(argv[++index]);
    } else if (argument === "--skip-package") {
      options.scanPackage = false;
    } else if (argument === "--no-git") {
      options.useGit = false;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--hash-stdin") {
      options.hashStdin = true;
    } else if (argument === "--id") {
      options.id = argv[++index];
    } else if (argument === "--match") {
      options.match = argv[++index];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function createHashedEntry(options) {
  if (!/^reference-[0-9]{3}$/u.test(options.id ?? "")) {
    throw new Error("--id must use the neutral reference-NNN format");
  }
  if (!["stream", "token"].includes(options.match)) {
    throw new Error("--match must be stream or token");
  }
  const input = readStdin();
  if (!input || input.includes("\n") || input.includes("\r")) {
    throw new Error("stdin must contain exactly one non-empty fingerprint");
  }
  const normalized = normalizeCompact(input);
  const normalizedLength = Array.from(normalized).length;
  if (normalizedLength < 2) {
    throw new Error("normalized fingerprint is too short");
  }
  if (options.match === "token" && normalizedLength > 8) {
    throw new Error("token matching is reserved for short fingerprints");
  }
  return {
    id: options.id,
    digest: fingerprintDigest(normalized),
    rollingDigest: rollingDigest(normalized),
    match: options.match,
    normalizedLength,
  };
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.hashStdin) {
      process.stdout.write(`${JSON.stringify(createHashedEntry(options), null, 2)}\n`);
      return;
    }
    const result = runSanityCheck(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(
        `reference leak sanity check passed (${result.counts.candidateFiles} tree, ` +
          `${result.counts.generatedFiles} generated, ${result.counts.packageFiles} package, ` +
          `${result.counts.distributableFiles} distributable files)\n`,
      );
    } else {
      process.stderr.write("reference leak sanity check failed:\n");
      for (const finding of result.findings) {
        process.stderr.write(
          `- ${finding.file}:${finding.line} [${finding.fingerprintId}]\n`,
        );
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`reference leak sanity check error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
