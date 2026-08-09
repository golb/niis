import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runIncrementalDiscoveryPipeline } from "../../packages/core/src/runtime/discovery-pipeline.js";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-discovery-pipeline-proof-"));

try {
  const packagesRoot = path.join(root, "packages");
  const registryPath = path.join(root, "registry.json");
  const proofRoot = path.join(process.cwd(), ".niis", "proofs", "discovery-pipeline");
  const summaryPath = path.join(proofRoot, "summary.json");

  writeJson(path.join(packagesRoot, "alpha", "package.json"), {
    name: "@niis/alpha",
    version: "0.1.0",
    niisManifest: {
      id: "pkg-alpha",
      name: "Alpha",
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
  writeJson(registryPath, {
    entries: [
      {
        candidate_kind: "package",
        display_name: "Alpha Mirror",
        package_id: "pkg-alpha",
        source_ref: "registry://alpha",
        version: "0.1.0",
      },
      {
        candidate_kind: "package",
        display_name: "Gamma",
        package_id: "pkg-gamma",
        source_ref: "registry://gamma",
        version: "0.1.0",
      },
    ],
  });

  const pipeline = runIncrementalDiscoveryPipeline({
    maxParallel: 2,
    now: "2026-04-04T21:30:00Z",
    reportId: "discovery-pipeline-proof",
    sources: [
      {
        kind: "local_filesystem",
        rootDirectory: packagesRoot,
      },
      {
        kind: "registry",
        registryPath,
      },
    ],
    taskId: "discovery-pipeline-proof",
  });

  const summary = {
    candidate_package_ids: pipeline.final_report.candidates
      .map((candidate) => candidate.package_id)
      .filter(Boolean),
    downstream_subtask_count: pipeline.summary.downstream_subtasks_created,
    downstream_titles: pipeline.seeker_reports.flatMap((report) =>
      report.downstream_subtasks.map((subtask) => subtask.title)),
    duplicate_count: pipeline.final_report.duplicates.length,
    duplicate_dedup_keys: pipeline.final_report.duplicates.map((duplicate) => duplicate.dedup_key),
    final_candidate_count: pipeline.final_report.candidates.length,
    parallel_ready_seeker_count: pipeline.ready_seekers.length,
    proof_summary_path: summaryPath,
    report_id: pipeline.final_report.report_id,
    scope_count: pipeline.seeker_scopes.length,
    source_kinds: pipeline.final_report.source_kinds,
  };

  writeJson(summaryPath, summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  fs.rmSync(root, { force: true, recursive: true });
}
