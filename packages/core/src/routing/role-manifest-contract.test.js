import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./role-config-loader.js";
import { validateContextContract } from "../schemas/context-contract.js";
import { normalizeContextContract } from "../contracts/context-contract.js";
import { DEFAULT_ROLE_MANIFESTS } from "./role-manifests.js";




const SHIPPED_MANIFEST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
  "config/role-manifests",
);

function listShippedManifests() {
  if (!fs.existsSync(SHIPPED_MANIFEST_DIR)) {
    return [];
  }
  return fs.readdirSync(SHIPPED_MANIFEST_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.join(SHIPPED_MANIFEST_DIR, entry))
    .sort();
}

test("every shipped role-manifest context contract is schema-valid", () => {
  const files = listShippedManifests();
  assert.ok(files.length > 0, `expected shipped manifests under ${SHIPPED_MANIFEST_DIR}`);

  for (const filePath of files) {
    const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, "utf8"));



    if (!frontmatter || Object.keys(frontmatter).length === 0) {
      continue;
    }
    assert.ok(
      typeof frontmatter.id === "string" && frontmatter.id.trim() !== "",
      `${filePath} declares frontmatter but no id`,
    );
    if (frontmatter.context_contract === undefined || frontmatter.context_contract === null) {
      continue;
    }
    const result = validateContextContract(frontmatter.context_contract);
    assert.deepEqual(
      result.errors,
      [],
      `${filePath} has an invalid context_contract`,
    );
    assert.equal(result.ok, true, `${filePath} has an invalid context_contract`);
  }
});

test("every built-in role manifest carries a normalizable context contract field", () => {
  for (const manifest of DEFAULT_ROLE_MANIFESTS) {


    const normalized = normalizeContextContract(manifest.context_contract, { roleId: manifest.id });
    if (normalized !== null) {
      assert.ok(Array.isArray(normalized.allow), `${manifest.id} contract lacks allow`);
    }
  }
});
