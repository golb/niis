import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluatePackageActivation } from "../../packages/core/src/runtime/package-activation.js";
import { discoverPackageCandidates } from "../../packages/core/src/runtime/package-discovery.js";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-skill-health-"));

try {
  const packagesRoot = path.join(root, "packages");
  const skillPackageRoot = path.join(packagesRoot, "review-skill");

  writeJson(path.join(skillPackageRoot, "package.json"), {
    name: "@niis/review-skill",
    version: "0.1.0",
    niisManifest: {
      id: "pkg-review-skill",
      name: "Review Skill",
      version: "0.1.0",
      type: "skill",
      capabilities: ["review"],
      compatibility: {
        min_niis_version: "0.1.0",
        max_niis_version: null,
        required_adapters: [],
      },
      activation_status: "INACTIVE",
      schema_version: "1.0.0",
    },
  });

  const report = discoverPackageCandidates({
    reportId: "skill-health-discovery",
    sources: [{
      kind: "local_filesystem",
      rootDirectory: packagesRoot,
    }],
  });
  const candidate = report.candidates[0] ?? null;
  const activation = evaluatePackageActivation({
    packageManifest: candidate?.package_manifest ?? null,
    securityScanSurfaces: [{
      content: "Reviewed skill package for local review workflows only.",
      hooks: [],
      id: "workflow:skill-health",
      type: "workflow",
    }],
    taskId: "skill-surface-health",
  });

  console.log(JSON.stringify({
    activation_allowed: activation.allowed,
    candidate_count: report.candidates.length,
    discovered_activation_status: candidate?.package_manifest?.activation_status ?? null,
    discovered_type: candidate?.package_manifest?.type ?? null,
    activated_status: activation.package_manifest.activation_status,
    skill_id: candidate?.package_id ?? null,
  }, null, 2));
} finally {
  fs.rmSync(root, { force: true, recursive: true });
}
