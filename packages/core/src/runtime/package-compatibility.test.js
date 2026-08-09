import test from "node:test";
import assert from "node:assert/strict";

import { createPackageManifest } from "../contracts/packages.js";
import { compareVersions, evaluatePackageManifestCompatibility } from "./package-compatibility.js";

function createManifest(overrides = {}) {
  return createPackageManifest({
    activationStatus: "REVIEW",
    capabilities: ["review"],
    compatibility: overrides.compatibility ?? {
      min_niis_version: "0.1.0",
      max_niis_version: null,
      required_adapters: [],
    },
    id: overrides.id ?? "pkg-compatibility",
    name: overrides.name ?? "Compatibility Package",
    type: overrides.type ?? "role",
    version: overrides.version ?? "0.1.0",
  });
}

test("compareVersions compares dot-separated runtime versions", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
});

test("evaluatePackageManifestCompatibility blocks unmet version and adapter requirements", () => {
  const evaluation = evaluatePackageManifestCompatibility({
    availableAdapters: ["local-shell"],
    currentNiisVersion: "0.1.0",
    packageManifest: createManifest({
      compatibility: {
        max_niis_version: "0.0.9",
        min_niis_version: "0.2.0",
        required_adapters: ["cursor-bridge"],
      },
    }),
  });

  assert.equal(evaluation.compatible, false);
  assert.deepEqual(evaluation.blocked_by, [
    "min_niis_version_unmet",
    "max_niis_version_exceeded",
    "required_adapters_missing",
  ]);
});
