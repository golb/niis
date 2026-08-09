import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDaemonReadiness,
  classifyReadinessRepository,
  createDaemonReadinessPath,
  createReadinessChangedPathsDigest,
  createReadinessRepositoryIdentity,
  createReadinessRepositoryIdentityFromComponents,
  createReadinessSourceIdentity,
  normalizeReadinessRuntimeFamily,
  recordDaemonReadinessEvidence,
  verifyDaemonReadiness,
} from "./daemon-readiness.js";

function syntheticRepositoryIdentity(repositoryRoot) {
  return createReadinessRepositoryIdentityFromComponents({
    gitCommonDirectory: path.join(repositoryRoot, ".git"),
    originUrl: `https://invalid.local/${path.basename(repositoryRoot)}.git`,
    repositoryRoot,
    rootCommits: [
      createReadinessChangedPathsDigest([`${path.basename(repositoryRoot)}.root`]),
    ],
  });
}

function createFixture(t) {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-daemon-ready-"),
  );
  const fixtureWorkspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-daemon-source-"),
  );
  const stateRoot = path.join(workspaceRoot, ".niis");
  const fixtureStateRoot = path.join(fixtureWorkspaceRoot, ".niis");
  fs.mkdirSync(path.dirname(createDaemonReadinessPath(stateRoot)), {
    recursive: true,
  });
  fs.mkdirSync(fixtureStateRoot, { recursive: true });
  t.after(() => {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
    fs.rmSync(fixtureWorkspaceRoot, { force: true, recursive: true });
  });
  return {
    fixtureProjectId: path.basename(fixtureWorkspaceRoot),
    fixtureStateRoot,
    projectId: path.basename(workspaceRoot),
    stateRoot,
  };
}

function createAttemptDescriptor({
  adapterId,
  attemptId,
  base,
  changedFiles,
  repositoryRoot,
  selfHostScope,
  taskId,
}) {
  const finishedAt = new Date(base + 6_000).toISOString();
  const workspacePath = path.join(
    os.tmpdir(),
    "readiness-worktrees",
    attemptId,
  );
  const checkoutDigest = "a".repeat(64);
  const repositoryClass = classifyReadinessRepository({
    changedFiles,
    repositoryRoot,
    selfHostScope,
  });
  const promotion = {
    attempt_id: attemptId,
    metadata: {
      auto_merge: false,
      changed_files: changedFiles,
    },
    promoted_at: new Date(base + 4_000).toISOString(),
    status: "PROMOTED",
    target_ref: `task/${attemptId}`,
    task_id: taskId,
  };
  const attempt = {
    canonical_verdict: "PASS",
    finished_at: finishedAt,
    id: attemptId,
    stage: "FINISHED",
    state: {
      execution: {
        task_result: {
          run_record: {
            adapter_id: adapterId,
          },
        },
      },
      finish: {
        readiness_evidence: {
          budget: {
            limit: 1,
            used: 0.25,
          },
          primary_checkout: {
            after_digest: checkoutDigest,
            before_digest: checkoutDigest,
          },
          repository: {
            ...syntheticRepositoryIdentity(repositoryRoot),
            changed_paths_sha256:
              createReadinessChangedPathsDigest(changedFiles),
            checkout_sha256: checkoutDigest,
            class: repositoryClass,
            self_host_scope: selfHostScope,
          },
          runtime: {
            adapter_id: adapterId,
            family: normalizeReadinessRuntimeFamily(adapterId),
          },
          schema_version: 2,
        },
      },
      promotion,
      workspace: {
        repository_root: repositoryRoot,
        worktree_path: workspacePath,
      },
    },
    task_id: taskId,
    version: 8,
    workspace_path: workspacePath,
  };
  const queue = {
    created_at: new Date(base - 1_000).toISOString(),
    payload: {
      attempt_id: attemptId,
      canonical_verdict: "PASS",
    },
    state: "COMPLETED",
    task_id: taskId,
    updated_at: new Date(base + 7_000).toISOString(),
    version: 3,
  };
  const outboxEvents = [{
    created_at: queue.updated_at,
    delivered_at: new Date(base + 7_500).toISOString(),
    delivery_attempts: 1,
    entry: queue,
    event_id: `queue-event:${attemptId}`,
    last_error: null,
    operation: "UPSERT",
    task_id: taskId,
  }];
  const steps = new Map();
  for (const [stage, offset] of Object.entries({
    FINISHED: 5_000,
    GATES_RUN: 1_000,
    PROMOTED: 3_000,
    REVIEWED: 2_000,
  })) {
    steps.set(stage, {
      attempt_id: attemptId,
      completed_at: new Date(base + offset).toISOString(),
      result: stage === "GATES_RUN"
        ? {
            canonical_verdict: "PASS",
            ok: true,
            source: "acceptance_command_runner",
          }
        : stage === "REVIEWED"
          ? {
              canonical_verdict: "PASS",
              fresh_context: true,
              source: "fresh_outer_llm_review",
            }
          : {},
      stage,
      status: "COMPLETED",
    });
  }
  return { attempt, outboxEvents, promotion, queue, steps };
}

function createStore(descriptors) {
  const attempts = new Map();
  const promotions = new Map();
  const queues = new Map();
  const steps = new Map();
  const taskAttempts = new Map();
  const visibleAttemptIds = [];
  const outboxEvents = [];

  for (const descriptor of descriptors) {
    attempts.set(descriptor.attempt.id, descriptor.attempt);
    promotions.set(descriptor.attempt.id, descriptor.promotion);
    queues.set(descriptor.attempt.task_id, descriptor.queue);
    taskAttempts.set(descriptor.attempt.task_id, [descriptor.attempt]);
    outboxEvents.push(...descriptor.outboxEvents);
    for (const [stage, step] of descriptor.steps) {
      steps.set(`${descriptor.attempt.id}:${stage}`, step);
    }
  }

  return {
    attempts: {
      async byId(attemptId) {
        return attempts.get(attemptId) ?? null;
      },
      async list() {
        return visibleAttemptIds.map((attemptId) =>
          attempts.get(attemptId) ?? { id: attemptId });
      },
      async listByTask(taskId) {
        return taskAttempts.get(taskId) ?? [];
      },
      async step({ attemptId, stage }) {
        return steps.get(`${attemptId}:${stage}`) ?? null;
      },
    },
    outbox: {
      async list() {
        return outboxEvents.map((event, index) => ({
          ...event,
          sequence_id: index + 1,
        }));
      },
    },
    promotions: {
      async byAttempt(attemptId) {
        return promotions.get(attemptId) ?? null;
      },
    },
    queue: {
      async byTask(taskId) {
        return queues.get(taskId) ?? null;
      },
      async list() {
        return [...queues.values()];
      },
    },
    records: {
      attempts,
      promotions,
      queues,
      steps,
      taskAttempts,
      visibleAttemptIds,
      outboxEvents,
    },
  };
}

function createVerifiedStores(count = 20) {
  const temporaryRepositoryRoot = path.join(
    fs.realpathSync.native(os.tmpdir()),
    "niis-disposable-readiness-repository",
  );
  const canonicalRepositoryRoot = path.resolve(
    path.parse(process.cwd()).root,
    "workspace",
    "canonical-project",
  );
  const fixtureDescriptor = createAttemptDescriptor({
    adapterId: "fixture-adapter",
    attemptId: "phase-disposable_fixture",
    base: Date.UTC(2026, 5, 30, 0, 0),
    changedFiles: ["fixture.txt"],
    repositoryRoot: temporaryRepositoryRoot,
    selfHostScope: null,
    taskId: "phase-task-0",
  });
  const canonicalDescriptors = [
    createAttemptDescriptor({
      adapterId: "codex_local",
      attemptId: "phase-self_hosted",
      base: Date.UTC(2026, 5, 30, 0, 1),
      changedFiles: ["niis/src/self-hosted.js"],
      repositoryRoot: canonicalRepositoryRoot,
      selfHostScope: "niis",
      taskId: "phase-task-1",
    }),
    createAttemptDescriptor({
      adapterId: "codex_local",
      attemptId: "phase-runtime_a",
      base: Date.UTC(2026, 5, 30, 0, 2),
      changedFiles: ["app/runtime-a.txt"],
      repositoryRoot: canonicalRepositoryRoot,
      selfHostScope: "niis",
      taskId: "phase-task-2",
    }),
    createAttemptDescriptor({
      adapterId: "claude_code_local",
      attemptId: "phase-runtime_b",
      base: Date.UTC(2026, 5, 30, 0, 3),
      changedFiles: ["app/runtime-b.txt"],
      repositoryRoot: canonicalRepositoryRoot,
      selfHostScope: "niis",
      taskId: "phase-task-3",
    }),
    ...Array.from({ length: count }, (_, index) =>
      createAttemptDescriptor({
        adapterId: index % 2 === 0 ? "codex_local" : "claude_code_local",
        attemptId: `attempt-${index}`,
        base: Date.UTC(2026, 6, 1, 0, index),
        changedFiles: [`app/canary-${index}.txt`],
        repositoryRoot: canonicalRepositoryRoot,
        selfHostScope: "niis",
        taskId: `task-${index}`,
      })),
  ];
  return {
    canonical: createStore(canonicalDescriptors),
    fixture: createStore([fixtureDescriptor]),
  };
}

function createOptions(fixture, stores) {
  const fixtureSource = createReadinessSourceIdentity({
    sourceProjectId: fixture.fixtureProjectId,
    sourceStateRoot: fixture.fixtureStateRoot,
  });
  return {
    captureCurrentCheckoutDigest() {
      return "a".repeat(64);
    },
    projectId: fixture.projectId,
    resolveRepositoryIdentity: syntheticRepositoryIdentity,
    resolveSourceStore(source) {
      if (
        source.state_root_identity_sha256
        !== fixtureSource.state_root_identity_sha256
      ) {
        throw new Error("unexpected external source");
      }
      return { store: stores.fixture };
    },
    stateRoot: fixture.stateRoot,
    store: stores.canonical,
  };
}

async function recordEvidence({
  attemptId,
  fixture,
  kind,
  now,
  source = "canonical",
  stores,
  taskId,
}) {
  const external = source === "fixture";
  return recordDaemonReadinessEvidence({
    attemptId,
    destinationProjectId: fixture.projectId,
    kind,
    now,
    resolveRepositoryIdentity: syntheticRepositoryIdentity,
    sourceProjectId: external
      ? fixture.fixtureProjectId
      : fixture.projectId,
    sourceStateRoot: external
      ? fixture.fixtureStateRoot
      : fixture.stateRoot,
    stateRoot: fixture.stateRoot,
    store: external ? stores.fixture : stores.canonical,
    taskId,
  });
}

async function recordCompleteSequence({
  count = 20,
  fixture,
  stores,
}) {
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");
  await recordEvidence({
    attemptId: "phase-disposable_fixture",
    fixture,
    kind: "rollout_phase",
    now: new Date(Date.UTC(2026, 6, 2, 0, 0)),
    source: "fixture",
    stores,
    taskId: "phase-task-0",
  });
  for (const [offset, phase] of ["self_hosted", "runtime_a", "runtime_b"].entries()) {
    stores.canonical.records.visibleAttemptIds.push(`phase-${phase}`);
    await recordEvidence({
      attemptId: `phase-${phase}`,
      fixture,
      kind: "rollout_phase",
      now: new Date(Date.UTC(2026, 6, 2, 0, offset + 1)),
      stores,
      taskId: `phase-task-${offset + 1}`,
    });
  }
  for (let index = 0; index < count; index += 1) {
    stores.canonical.records.visibleAttemptIds.push(`attempt-${index}`);
    await recordEvidence({
      attemptId: `attempt-${index}`,
      fixture,
      kind: "canary_task",
      now: new Date(Date.UTC(2026, 6, 2, 1, index)),
      stores,
      taskId: `task-${index}`,
    });
  }
}

test("daemon readiness fails closed when the durable record is absent", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  const options = createOptions(fixture, stores);
  const result = await verifyDaemonReadiness(options);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "missing_readiness_record");
  await assert.rejects(assertDaemonReadiness(options), /daemon mode is locked/u);
});

test("cross-workspace writer derives four phases and verifies a 24-record chain", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  const options = createOptions(fixture, stores);
  await recordCompleteSequence({ fixture, stores });

  const result = await assertDaemonReadiness(options);
  assert.equal(result.ready, true);
  assert.equal(result.observed_consecutive_clean_tasks, 20);
  assert.equal(result.verified_attempt_ids.length, 24);
  assert.equal(
    fs.statSync(createDaemonReadinessPath(fixture.stateRoot)).mode & 0o777,
    0o600,
  );
  const record = JSON.parse(
    fs.readFileSync(createDaemonReadinessPath(fixture.stateRoot), "utf8"),
  );
  assert.deepEqual(
    record.rollout_phases.map((entry) => entry.phase),
    ["disposable_fixture", "self_hosted", "runtime_a", "runtime_b"],
  );
  assert.equal(record.rollout_phases[2].runtime.family, "codex");
  assert.equal(record.rollout_phases[3].runtime.family, "claude");
});

test("operator-authored legacy invariant booleans are never trusted", async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(
    createDaemonReadinessPath(fixture.stateRoot),
    `${JSON.stringify({
      consecutive_clean_tasks: [{
        attempt_id: "attempt-0",
        completed_at: "2026-07-01T00:00:06.000Z",
        invariants: { no_task_loss: true },
        task_id: "task-0",
      }],
      generated_at: "2026-07-23T00:00:00.000Z",
      rollout_phases: [],
      schema_version: 1,
    })}\n`,
  );
  const stores = createVerifiedStores();
  const result = await verifyDaemonReadiness(createOptions(fixture, stores));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "unsupported_readiness_schema");
});

test("writer rejects attempts without machine-checkable durable proofs", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");
  stores.fixture.records.attempts.get("phase-disposable_fixture")
    .state.finish.readiness_evidence.primary_checkout.after_digest = "b".repeat(64);

  await assert.rejects(
    recordEvidence({
      attemptId: "phase-disposable_fixture",
      fixture,
      kind: "rollout_phase",
      source: "fixture",
      stores,
      taskId: "phase-task-0",
    }),
    /primary_checkout_proof_missing/u,
  );
  assert.equal(fs.existsSync(createDaemonReadinessPath(fixture.stateRoot)), false);
});

test("writer requires deterministic gates and a fresh LLM review", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");
  stores.fixture.records.steps.get("phase-disposable_fixture:GATES_RUN").result = {
    canonical_verdict: "PASS",
  };

  await assert.rejects(
    recordEvidence({
      attemptId: "phase-disposable_fixture",
      fixture,
      kind: "rollout_phase",
      source: "fixture",
      stores,
      taskId: "phase-task-0",
    }),
    /deterministic_gate_not_proven/u,
  );

  stores.fixture.records.steps.get("phase-disposable_fixture:GATES_RUN").result = {
    canonical_verdict: "PASS",
    ok: true,
    source: "acceptance_command_runner",
  };
  stores.fixture.records.steps.get("phase-disposable_fixture:REVIEWED").result = {
    canonical_verdict: "PASS",
    fresh_context: false,
    source: "fresh_outer_llm_review",
  };

  await assert.rejects(
    recordEvidence({
      attemptId: "phase-disposable_fixture",
      fixture,
      kind: "rollout_phase",
      source: "fixture",
      stores,
      taskId: "phase-task-0",
    }),
    /fresh_review_not_proven/u,
  );
});

test("durable mutation invalidates the linked readiness digest", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  const options = createOptions(fixture, stores);
  await recordCompleteSequence({ fixture, stores });
  stores.canonical.records.attempts.get("attempt-19").state.audit_note = "changed";

  const result = await verifyDaemonReadiness(options);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "readiness_evidence_digest_mismatch");
  assert.equal(result.attempt_id, "attempt-19");
});

test("writer derives phase and rejects a same-state fake fixture", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  stores.canonical.records.attempts.set(
    "phase-disposable_fixture",
    stores.fixture.records.attempts.get("phase-disposable_fixture"),
  );
  stores.canonical.records.promotions.set(
    "phase-disposable_fixture",
    stores.fixture.records.promotions.get("phase-disposable_fixture"),
  );
  stores.canonical.records.queues.set(
    "phase-task-0",
    stores.fixture.records.queues.get("phase-task-0"),
  );
  stores.canonical.records.taskAttempts.set(
    "phase-task-0",
    stores.fixture.records.taskAttempts.get("phase-task-0"),
  );
  for (const stage of ["GATES_RUN", "REVIEWED", "PROMOTED", "FINISHED"]) {
    stores.canonical.records.steps.set(
      `phase-disposable_fixture:${stage}`,
      stores.fixture.records.steps.get(`phase-disposable_fixture:${stage}`),
    );
  }
  stores.canonical.records.visibleAttemptIds.push("phase-disposable_fixture");

  await assert.rejects(
    recordEvidence({
      attemptId: "phase-disposable_fixture",
      fixture,
      kind: "rollout_phase",
      stores,
      taskId: "phase-task-0",
    }),
    /rollout_repository_class_mismatch/u,
  );
});

test("writer rejects wrong runtime family and skipped canonical attempts", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");
  await recordEvidence({
    attemptId: "phase-disposable_fixture",
    fixture,
    kind: "rollout_phase",
    source: "fixture",
    stores,
    taskId: "phase-task-0",
  });
  stores.canonical.records.visibleAttemptIds.push("phase-self_hosted");
  await recordEvidence({
    attemptId: "phase-self_hosted",
    fixture,
    kind: "rollout_phase",
    stores,
    taskId: "phase-task-1",
  });

  const runtimeA = stores.canonical.records.attempts.get("phase-runtime_a");
  runtimeA.state.execution.task_result.run_record.adapter_id = "claude_code_local";
  runtimeA.state.finish.readiness_evidence.runtime = {
    adapter_id: "claude_code_local",
    family: "claude",
  };
  stores.canonical.records.visibleAttemptIds.push("phase-runtime_a");
  await assert.rejects(
    recordEvidence({
      attemptId: "phase-runtime_a",
      fixture,
      kind: "rollout_phase",
      stores,
      taskId: "phase-task-2",
    }),
    /rollout_runtime_a_mismatch/u,
  );

  runtimeA.state.execution.task_result.run_record.adapter_id = "codex_local";
  runtimeA.state.finish.readiness_evidence.runtime = {
    adapter_id: "codex_local",
    family: "codex",
  };
  stores.canonical.records.visibleAttemptIds.splice(1, 1, "unrecorded-attempt");
  stores.canonical.records.visibleAttemptIds.push("phase-runtime_a");
  await assert.rejects(
    recordEvidence({
      attemptId: "phase-runtime_a",
      fixture,
      kind: "rollout_phase",
      stores,
      taskId: "phase-task-2",
    }),
    /canary_attempts_not_consecutive/u,
  );
});

test("verifier locks when imported source state cannot be reopened", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  await recordCompleteSequence({ fixture, stores });
  const result = await verifyDaemonReadiness({
    projectId: fixture.projectId,
    stateRoot: fixture.stateRoot,
    store: stores.canonical,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "readiness_source_unavailable");
});

test("repository identity changes when a checkout path is replaced by another repository", (t) => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-readiness-git-"),
  );
  t.after(() => fs.rmSync(repositoryRoot, { force: true, recursive: true }));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout || `git ${args.join(" ")} failed`,
    );
  };
  const initialize = (content) => {
    git("init", "--quiet");
    git("config", "user.email", "readiness@example.invalid");
    git("config", "user.name", "Readiness Fixture");
    fs.writeFileSync(path.join(repositoryRoot, "identity.txt"), `${content}\n`);
    git("add", "identity.txt");
    git("commit", "--quiet", "-m", `identity ${content}`);
  };

  initialize("first");
  const first = createReadinessRepositoryIdentity(repositoryRoot);
  fs.rmSync(path.join(repositoryRoot, ".git"), {
    force: true,
    recursive: true,
  });
  initialize("second");
  const second = createReadinessRepositoryIdentity(repositoryRoot);

  assert.notEqual(first.root_commits_sha256, second.root_commits_sha256);
  assert.notEqual(first.identity_sha256, second.identity_sha256);
});

test("readiness storage refuses a symlinked reliability directory", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  const reliabilityDirectory = path.dirname(
    createDaemonReadinessPath(fixture.stateRoot),
  );
  const externalDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "niis-readiness-external-"),
  );
  t.after(() => fs.rmSync(externalDirectory, {
    force: true,
    recursive: true,
  }));
  fs.rmSync(reliabilityDirectory, { force: true, recursive: true });
  fs.symlinkSync(externalDirectory, reliabilityDirectory, "dir");

  const status = await verifyDaemonReadiness(createOptions(fixture, stores));
  assert.equal(status.ready, false);
  assert.equal(status.reason, "unsafe_readiness_path");
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");
  await assert.rejects(
    recordEvidence({
      attemptId: "phase-disposable_fixture",
      fixture,
      kind: "rollout_phase",
      source: "fixture",
      stores,
      taskId: "phase-task-0",
    }),
    /unsafe readiness storage/u,
  );
  assert.equal(
    fs.existsSync(path.join(externalDirectory, "canary-readiness.json")),
    false,
  );
});

test("writer reclaims a lock whose owner process is dead", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  const recordPath = createDaemonReadinessPath(fixture.stateRoot);
  fs.writeFileSync(
    `${recordPath}.lock`,
    `${JSON.stringify({
      created_at: "2026-07-23T00:00:00.000Z",
      owner_token: "dead-owner",
      pid: 2_147_483_647,
    })}\n`,
    { mode: 0o600 },
  );
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");

  await recordEvidence({
    attemptId: "phase-disposable_fixture",
    fixture,
    kind: "rollout_phase",
    source: "fixture",
    stores,
    taskId: "phase-task-0",
  });

  assert.equal(fs.existsSync(recordPath), true);
  assert.equal(fs.existsSync(`${recordPath}.lock`), false);
});

test("writer never reclaims a live owner's lock", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  const recordPath = createDaemonReadinessPath(fixture.stateRoot);
  fs.writeFileSync(
    `${recordPath}.lock`,
    `${JSON.stringify({
      created_at: "2026-07-23T00:00:00.000Z",
      owner_token: "live-owner",
      pid: process.pid,
    })}\n`,
    { mode: 0o600 },
  );
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");

  await assert.rejects(
    recordEvidence({
      attemptId: "phase-disposable_fixture",
      fixture,
      kind: "rollout_phase",
      source: "fixture",
      stores,
      taskId: "phase-task-0",
    }),
    /already locked/u,
  );
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(fs.existsSync(`${recordPath}.lock`), true);
});

test("writer refuses readiness evidence when a queue task is lost", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  stores.fixture.records.outboxEvents.push({
    created_at: "2026-06-30T00:00:03.000Z",
    delivered_at: "2026-06-30T00:00:04.000Z",
    delivery_attempts: 1,
    entry: null,
    event_id: "queue-event:lost-task",
    last_error: null,
    operation: "UPSERT",
    task_id: "lost-task",
  });
  stores.fixture.records.visibleAttemptIds.push("phase-disposable_fixture");

  await assert.rejects(
    recordEvidence({
      attemptId: "phase-disposable_fixture",
      fixture,
      kind: "rollout_phase",
      source: "fixture",
      stores,
      taskId: "phase-task-0",
    }),
    /no_task_loss_not_proven/u,
  );
  assert.equal(
    fs.existsSync(createDaemonReadinessPath(fixture.stateRoot)),
    false,
  );
});

test("strict unlock rejects an unrecorded attempt after the canary streak", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  const options = createOptions(fixture, stores);
  await recordCompleteSequence({ fixture, stores });
  stores.canonical.records.visibleAttemptIds.push("unrecorded-failed-attempt");

  const status = await verifyDaemonReadiness(options);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "canary_attempts_not_consecutive");
});

test("strict unlock binds the current primary checkout to the final canary", async (t) => {
  const fixture = createFixture(t);
  const stores = createVerifiedStores();
  await recordCompleteSequence({ fixture, stores });

  const status = await verifyDaemonReadiness({
    ...createOptions(fixture, stores),
    captureCurrentCheckoutDigest() {
      return "b".repeat(64);
    },
  });
  assert.equal(status.ready, false);
  assert.equal(status.reason, "primary_checkout_changed_since_canary");
});
