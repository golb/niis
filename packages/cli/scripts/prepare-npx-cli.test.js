import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { prepareNpxCliBundle } from "./prepare-npx-cli.js";

test("prepareNpxCliBundle creates a self-contained npx bundle", (t) => {
  const outputRoot = prepareNpxCliBundle();

  t.after(() => {
    fs.rmSync(outputRoot, { force: true, recursive: true });
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "package.json"), "utf8"));

  assert.equal(manifest.name, "@niis/cli");
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "UNLICENSED");
  assert.equal(manifest.bin.niis, "packages/cli/bin/niis.js");
  assert.equal(
    fs.existsSync(path.join(outputRoot, "packages", "core", "src", "index.js")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(outputRoot, "packages", "ui", "src", "index.js")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(outputRoot, "node_modules", "better-sqlite3", "package.json")),
    true,
  );
  for (const relativePath of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "config/pricing.json",
    "config/role-manifests/generalist-worker.md",
    "node_modules/prismjs/package.json",
    "node_modules/prism-themes/package.json",
  ]) {
    assert.equal(fs.existsSync(path.join(outputRoot, relativePath)), true, relativePath);
  }
  assert.equal(
    fs.existsSync(path.join(outputRoot, "node_modules", "prismjs", "components")),
    false,
  );
});
