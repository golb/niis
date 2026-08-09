import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findCodeComment, inspectDistributionTree } from "./oss-release-sanity.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "niis-distribution-sanity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  mkdirSync(join(root, "packages", "ui"), { recursive: true });
  mkdirSync(join(root, "config", "role-manifests"), { recursive: true });
  writeFileSync(join(root, "README.md"), "safe\n");
  writeFileSync(join(root, "LICENSE"), "Niis Source-Available License Agreement\n\nCopyright synthetic\n");
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), [
    "better-sqlite3", "bindings", "file-uri-to-path", "prismjs", "prism-themes",
  ].join("\n"));
  writeFileSync(join(root, "packages", "cli", "package.json"), JSON.stringify({
    private: true,
    license: "SEE LICENSE IN ../../LICENSE",
    dependencies: { "prism-themes": "1.0.0", prismjs: "1.0.0" },
  }));
  writeFileSync(join(root, "packages", "core", "package.json"), JSON.stringify({
    private: true,
    license: "SEE LICENSE IN ../../LICENSE",
  }));
  writeFileSync(join(root, "packages", "ui", "package.json"), JSON.stringify({
    private: true,
    license: "SEE LICENSE IN ../../LICENSE",
  }));
  writeFileSync(join(root, "config", "pricing.json"), "{}\n");
  writeFileSync(join(root, "config", "role-manifests", "generalist-worker.md"), "synthetic\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "niis",
    private: true,
    license: "SEE LICENSE IN LICENSE",
    repository: {
      type: "git",
      url: "git+https://github.com/golb/niis.git",
    },
    homepage: "https://github.com/golb/niis#readme",
    bugs: {
      url: "https://github.com/golb/niis/issues",
    },
    workspaces: ["packages/cli", "packages/core", "packages/ui"],
  }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  return root;
}

test("distribution sanity accepts the minimal source-available contract", (t) => {
  assert.deepEqual(inspectDistributionTree(fixture(t)).errors, []);
});

test("distribution sanity fails closed on metadata, synthetic fingerprints, assets, and dependency licenses", (t) => {
  const root = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    ...manifest,
    private: false,
    repository: { type: "git", url: "https://example.invalid/repository.git" },
  }));
  writeFileSync(join(root, "README.md"), "npx ambiguous-package\n");
  writeFileSync(join(root, "internal-milestone.md"), `${["Phase", 42].join(" ")}\n`);
  writeFileSync(join(root, "encoded-milestone.html"), `${["Phase", "&", "nbsp;", 42].join("")}\n`);
  writeFileSync(
    join(root, "unsafe-proof.md"),
    `${["tool", "--validation-surface-root", ".."].join(" ")}\n`,
  );
  const syntheticToken = "syntheticleaksentinel";
  const syntheticFingerprints = new Map([[
    createHash("sha256").update(syntheticToken).digest("hex"),
    "synthetic-fingerprint-001",
  ]]);
  writeFileSync(join(root, "leak.js"), `const value = "${syntheticToken}";\n`);
  writeFileSync(join(root, "portrait.png"), "synthetic");
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/example": { version: "1.0.0", license: "GPL-3.0" } },
  }));
  const errors = inspectDistributionTree(root, {
    forbiddenTextFingerprints: syntheticFingerprints,
  }).errors.join("\n");
  assert.match(errors, /private:true/u);
  assert.match(errors, /repository metadata/u);
  assert.match(errors, /must not invoke npx/u);
  assert.match(errors, /parent-directory validation root/u);
  assert.match(errors, /internal milestone coordinate/u);
  assert.match(errors, /encoded-milestone\.html/u);
  assert.match(errors, /synthetic-fingerprint-001/u);
  assert.match(errors, /binary asset/u);
  assert.match(errors, /copyleft dependency/u);
});

test("distribution sanity rejects code comments without confusing URLs or regular expressions", (t) => {
  const root = fixture(t);
  const lineMarker = ["/", "/"].join("");
  const blockMarker = ["/", "*"].join("");
  const blockEnd = ["*", "/"].join("");
  writeFileSync(join(root, "safe.js"), 'const url = "https://example.invalid";\nconst slashes = /\\/\\//u;\n');
  assert.equal(findCodeComment(readFileSync(join(root, "safe.js"), "utf8"), "safe.js"), null);
  writeFileSync(join(root, "line-comment.js"), `const value = true; ${lineMarker} synthetic\n`);
  writeFileSync(join(root, "block-comment.css"), `${blockMarker} synthetic ${blockEnd}\nbody { color: black; }\n`);
  writeFileSync(join(root, "snippet.md"), ["```css", `${blockMarker} synthetic ${blockEnd}`, "```", ""].join("\n"));
  const errors = inspectDistributionTree(root).errors.join("\n");
  assert.match(errors, /code comment is present: block-comment\.css:1 \(block\)/u);
  assert.match(errors, /code comment is present: line-comment\.js:1 \(line\)/u);
  assert.match(errors, /code comment is present: snippet\.md:2 \(block\)/u);
});
