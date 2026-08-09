import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fingerprintDigest,
  listArtifactFiles,
  loadFingerprintConfig,
  normalizeCompact,
  resolveMergeBase,
  rollingDigest,
  runSanityCheck,
  scanAddedDiff,
  scanArtifactDirectory,
  scanText,
} from "./reference-leak-sanity.mjs";

function syntheticEntry(value, overrides = {}) {
  const normalized = normalizeCompact(value);
  return {
    id: "reference-900",
    digest: fingerprintDigest(normalized),
    rollingDigest: rollingDigest(normalized),
    match: "stream",
    normalizedLength: Array.from(normalized).length,
    ...overrides,
  };
}

test("stream fingerprints normalize case, Unicode width, separators, and URL forms", () => {
  const entry = syntheticEntry("Cobalt Example");
  for (const candidate of [
    "COBALT_example",
    "cobalt-example",
    "https://code.invalid/team/cobalt%20example.git",
    "\uff23\uff4f\uff42\uff41\uff4c\uff54/\uff25\uff58\uff41\uff4d\uff50\uff4c\uff45",
  ]) {
    assert.deepEqual(scanText(candidate, [entry]), [
      { file: "<text>", line: 1, fingerprintId: entry.id },
    ]);
  }
});

test("URL normalization decodes UTF-8 percent-encoded code points", () => {
  const entry = syntheticEntry("Caf\u00e9 Tool");
  assert.deepEqual(
    scanText("https://code.invalid/Caf%C3%A9-Tool", [entry]),
    [{ file: "<text>", line: 1, fingerprintId: entry.id }],
  );
});

test("short token fingerprints match tokens and separated initials without substring noise", () => {
  const entry = syntheticEntry("QXL", { match: "token" });
  assert.equal(scanText("https://code.invalid/qxl/tool", [entry]).length, 1);
  assert.equal(scanText("q-x-l", [entry]).length, 1);
  assert.equal(scanText("q-\nx-\nl", [entry]).length, 1);
  assert.equal(scanText("tranquxly unrelated prose", [entry]).length, 0);
});

test("token fingerprints preserve boundaries while allowing grouped separators", () => {
  const entry = syntheticEntry("Cobalt", { match: "token" });
  assert.equal(scanText("co_balt", [entry]).length, 1);
  assert.equal(scanText("safe co-\nbalt safe", [entry]).length, 1);
  assert.equal(scanText("cobaltic unrelated", [entry]).length, 0);
  assert.equal(scanText("const cobaltValue = true", [entry]).length, 0);
});

test("findings identify the exact synthetic fixture line without echoing content", () => {
  const entry = syntheticEntry("/synthetic/root/Cobalt Lab");
  assert.deepEqual(scanText(`safe\n/synthetic/root/cobalt-lab\nsafe`, [entry], "fixture.txt"), [
    { file: "fixture.txt", line: 2, fingerprintId: entry.id },
  ]);
});

test("stream fingerprints cannot be hidden across line boundaries", () => {
  const entry = syntheticEntry("Cobalt Example");
  assert.deepEqual(scanText("safe cobalt-\n_example safe", [entry], "fixture.txt"), [
    { file: "fixture.txt", line: 1, fingerprintId: entry.id },
  ]);
});

test("production config accepts only neutral IDs and hashed fingerprint fields", () => {
  const config = loadFingerprintConfig();
  assert.equal(config.schemaVersion, 1);
  assert.ok(config.fingerprints.length >= 42);
  assert.deepEqual(
    config.fingerprints.slice(0, 42).map(({ id }) => id),
    Array.from({ length: 42 }, (_, index) => `reference-${String(index + 1).padStart(3, "0")}`),
  );
  for (const entry of config.fingerprints) {
    assert.match(entry.id, /^reference-[0-9]{3}$/u);
    assert.match(entry.digest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(entry).sort(), [
      "digest",
      "id",
      "match",
      "normalizedLength",
      "rollingDigest",
    ]);
  }
});

test("config validation rejects fields that could carry plaintext labels", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-config-"));
  const configPath = join(temporaryRoot, "fingerprints.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        algorithm: "sha256",
        normalization: "nfkc-casefold-url-compact-v1",
        fingerprints: [
          {
            ...syntheticEntry("Cobalt Example"),
            label: "synthetic label",
          },
        ],
      }),
    );
    assert.throws(() => loadFingerprintConfig(configPath), /may contain only/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("config validation rejects empty and incomplete baseline lists", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-baseline-"));
  const configPath = join(temporaryRoot, "fingerprints.json");
  const production = loadFingerprintConfig();
  try {
    for (const fingerprints of [
      [],
      production.fingerprints.filter((entry) => entry.id !== "reference-001"),
    ]) {
      writeFileSync(configPath, JSON.stringify({ ...production, fingerprints }));
      assert.throws(() => loadFingerprintConfig(configPath), /required baseline fingerprint/u);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("artifact scanning includes bundled dependency trees excluded from source walks", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-artifact-"));
  const dependencyRoot = join(
    temporaryRoot,
    "node_modules",
    "synthetic-dependency",
  );
  const entry = syntheticEntry("Cobalt Example");
  try {
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(
      join(dependencyRoot, "index.js"),
      "safe line\nconst marker = 'cobalt-example';\n",
    );
    assert.deepEqual(listArtifactFiles(temporaryRoot), [
      "node_modules/synthetic-dependency/index.js",
    ]);
    assert.deepEqual(
      scanArtifactDirectory(temporaryRoot, [entry], "distributable:").findings,
      [
        {
          file: "distributable:node_modules/synthetic-dependency/index.js",
          line: 2,
          fingerprintId: entry.id,
        },
      ],
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("artifact scanning checks file paths as well as file contents", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-path-"));
  const entry = syntheticEntry("Cobalt Example");
  try {
    const nestedRoot = join(temporaryRoot, "safe");
    mkdirSync(nestedRoot, { recursive: true });
    writeFileSync(join(nestedRoot, "cobalt-example.txt"), "safe content\n");
    assert.deepEqual(
      scanArtifactDirectory(temporaryRoot, [entry]).findings,
      [
        {
          file: "artifact:safe/cobalt-example.txt:path",
          line: 1,
          fingerprintId: entry.id,
        },
      ],
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("standalone scanning does not require a Git repository", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-standalone-"));
  const configPath = join(temporaryRoot, "fingerprints.json");
  const production = loadFingerprintConfig();
  const entry = syntheticEntry("Cobalt Example", { id: "reference-900" });
  try {
    writeFileSync(configPath, JSON.stringify({
      ...production,
      fingerprints: [...production.fingerprints, entry],
    }));
    writeFileSync(join(temporaryRoot, "cobalt-example.txt"), "safe content\n");
    const result = runSanityCheck({
      root: temporaryRoot,
      configPath,
      scanPackage: false,
      useGit: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.findings.some(({ fingerprintId }) => fingerprintId === entry.id), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("artifact scanning recognizes BOM-marked UTF-16 text", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-utf16-"));
  const entry = syntheticEntry("Cobalt Example");
  try {
    const encoded = Buffer.from("safe\ncobalt-example\n", "utf16le");
    writeFileSync(
      join(temporaryRoot, "fixture.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), encoded]),
    );
    assert.deepEqual(
      scanArtifactDirectory(temporaryRoot, [entry]).findings,
      [
        {
          file: "artifact:fixture.txt",
          line: 2,
          fingerprintId: entry.id,
        },
      ],
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("added-diff scanning blocks a synthetic leak", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-diff-"));
  const entry = syntheticEntry("Cobalt Example");
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot });
    execFileSync("git", ["config", "user.email", "synthetic@invalid"], { cwd: temporaryRoot });
    execFileSync("git", ["config", "user.name", "Synthetic"], { cwd: temporaryRoot });
    writeFileSync(join(temporaryRoot, "fixture.txt"), "safe\n");
    execFileSync("git", ["add", "fixture.txt"], { cwd: temporaryRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: temporaryRoot });
    writeFileSync(join(temporaryRoot, "fixture.txt"), "safe\ncobalt-example\n");
    assert.deepEqual(scanAddedDiff(temporaryRoot, [entry]).findings, [
      { file: "diff:fixture.txt", line: 2, fingerprintId: entry.id },
    ]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("merge-base discovery fails closed in CI when history is unavailable", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "niis-sanity-no-git-"));
  try {
    assert.throws(
      () => resolveMergeBase(temporaryRoot, { CI: "true" }),
      /unable to resolve a merge base in CI/u,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
