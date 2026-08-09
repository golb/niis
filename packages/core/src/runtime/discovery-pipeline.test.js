import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  partitionDiscoverySources,
  runIncrementalDiscoveryPipeline,
} from "./discovery-pipeline.js";

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niis-discovery-pipeline-"));
  const packagesRoot = path.join(root, "packages");
  const registryPath = path.join(root, "registry.json");

  fs.mkdirSync(packagesRoot, { recursive: true });

  t.after(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  return {
    packagesRoot,
    registryPath,
    root,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("partitionDiscoverySources splits filesystem roots and registry entries into seeker scopes", (t) => {
  const fixture = createFixture(t);

  writeJson(path.join(fixture.packagesRoot, "alpha", "package.json"), {
    name: "@niis/alpha",
    version: "0.1.0",
    niisManifest: {
      activation_status: "INACTIVE",
      capabilities: ["review"],
      compatibility: {
        max_niis_version: null,
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      id: "pkg-alpha",
      name: "Alpha",
      schema_version: "1.0.0",
      type: "skill",
      version: "0.1.0",
    },
  });
  writeJson(path.join(fixture.packagesRoot, "beta", "package.json"), {
    name: "@niis/beta",
    version: "0.1.0",
    niisManifest: {
      activation_status: "INACTIVE",
      capabilities: ["review"],
      compatibility: {
        max_niis_version: null,
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      id: "pkg-beta",
      name: "Beta",
      schema_version: "1.0.0",
      type: "skill",
      version: "0.1.0",
    },
  });
  writeJson(fixture.registryPath, {
    entries: [
      {
        candidate_kind: "package",
        display_name: "Gamma",
        package_id: "pkg-gamma",
        source_ref: "registry://gamma",
        version: "0.1.0",
      },
      {
        candidate_kind: "package",
        display_name: "Delta",
        package_id: "pkg-delta",
        source_ref: "registry://delta",
        version: "0.1.0",
      },
    ],
  });

  const scopes = partitionDiscoverySources([
    {
      id: "filesystem-source",
      kind: "local_filesystem",
      rootDirectory: fixture.packagesRoot,
    },
    {
      id: "registry-source",
      kind: "registry",
      registryPath: fixture.registryPath,
    },
  ]);

  assert.equal(scopes.length, 4);
  assert.deepEqual(
    scopes.map((scope) => scope.source_kind),
    ["local_filesystem", "local_filesystem", "registry", "registry"],
  );
});

test("runIncrementalDiscoveryPipeline emits ready seekers and immediate downstream subtasks", (t) => {
  const fixture = createFixture(t);

  writeJson(path.join(fixture.packagesRoot, "alpha", "package.json"), {
    name: "@niis/alpha",
    version: "0.1.0",
    niisManifest: {
      activation_status: "INACTIVE",
      capabilities: ["review"],
      compatibility: {
        max_niis_version: null,
        min_niis_version: "0.1.0",
        required_adapters: [],
      },
      id: "pkg-alpha",
      name: "Alpha",
      schema_version: "1.0.0",
      type: "skill",
      version: "0.1.0",
    },
  });
  writeJson(fixture.registryPath, {
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

  const result = runIncrementalDiscoveryPipeline({
    maxParallel: 2,
    now: "2026-04-04T21:30:00Z",
    reportId: "discovery-pipeline-test",
    sources: [
      {
        kind: "local_filesystem",
        rootDirectory: fixture.packagesRoot,
      },
      {
        kind: "registry",
        registryPath: fixture.registryPath,
      },
    ],
    taskId: "task-discovery",
  });

  assert.equal(result.seeker_scopes.length, 3);
  assert.equal(result.ready_seekers.length, 2);
  assert.equal(result.final_report.candidates.length, 2);
  assert.equal(result.final_report.duplicates.length, 1);
  assert.equal(result.summary.downstream_subtasks_created, 2);
  assert.equal(result.seeker_reports[0].downstream_subtasks.length, 1);
  assert.equal(result.seeker_reports[1].downstream_subtasks.length, 0);
  assert.equal(result.seeker_reports[2].downstream_subtasks.length, 1);
  assert.match(
    result.seeker_reports[0].downstream_subtasks[0].title,
    /Review discovery candidate Alpha/i,
  );
  assert.match(
    result.seeker_reports[2].downstream_mutation_artifacts[0].event.payload.reason,
    /incremental pipeline produced downstream work/i,
  );
});
