import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInMemoryTestAdapter } from "../../adapters/test-adapter.js";
import {
  createInitPlan,
  routing,
  storage,
} from "../../core/src/index.js";
import { executeCliTaskLifecycle } from "../src/lifecycle-facade.js";

class RuntimeProofError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "RuntimeProofError";
    this.result = result;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function runCliStep({
  cliEntrypoint,
  command,
  commandArgs = [],
  workspaceRoot,
  parseJson = false,
}) {
  const result = spawnSync(
    process.execPath,
    [cliEntrypoint, command, ...commandArgs],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );
  const stdout = result.stdout?.trim() ?? "";
  const step = {
    command,
    command_args: commandArgs,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stderr: result.stderr?.trim() ?? "",
    stdout,
  };

  if (!parseJson) {
    return step;
  }

  if (result.status !== 0) {
    return step;
  }

  try {
    return {
      ...step,
      parsed_json: stdout ? JSON.parse(stdout) : null,
    };
  } catch (error) {
    throw new RuntimeProofError(
      `failed to parse JSON output for command ${command}: ${error.message}`,
      { failed_step: step },
    );
  }
}

function createTask({
  taskId,
  title,
  status,
  timestamp,
}) {
  return {
    id: taskId,
    title,
    status,
    phase: 8,
    priority: "high",
    goal_id: null,
    depends_on: [],
    assigned_to: null,
    out_of_scope: [
      "Repair product bugs discovered during the proof run.",
    ],
    rejection_count: 0,
    max_rejections: 5,
    created_at: timestamp,
    updated_at: timestamp,
    transition_log: [
      {
        timestamp,
        from_status: null,
        to_status: status,
        actor: "runtime-proof",
        reason: "Created as a durable proof task for the runtime contour.",
      },
    ],
  };
}

function createRouteSpec({ task }) {
  return {
    adapters: [
      {
        id: "runtime-proof-adapter",
        capabilities: {
          toolFamilies: ["shell"],
        },
        metadata: {
          cost_tier: "standard",
        },
      },
    ],
    referenceBundle: {
      documentationPriority: [
        "README.md",
        "playwright.config.ts",
      ],
      guides: [
        "Treat product bugs as validation evidence, not as repair scope for the runtime proof.",
      ],
      targetPaths: [
        "README.md",
        "playwright.config.ts",
      ],
    },
    roleManifests: [
      {
        id: "runtime-proof-generalist",
        lane: "generalist",
        safe_fallback: true,
        toolFamilies: ["shell"],
      },
    ],
    routingPolicy: {},
    subtasks: [],
    task,
  };
}

function createLifecycleExecutionInput({
  task,
  runId,
  bootstrapContext,
}) {
  return {
    adapters: [
      {
        id: "runtime-proof-adapter",
        capabilities: {
          toolFamilies: ["shell"],
        },
        metadata: {
          cost_tier: "standard",
        },
        scriptedResults: [
          {
            completion_signal: true,
            cost: {
              estimated_usd: 0.01,
              input_tokens: 24,
              output_tokens: 18,
            },
            next_actions: [],
            status: "SUCCESS",
            summary:
              "Runtime proof smoke task completed with a reviewable summary of the attached repository surfaces.",
          },
        ],
      },
    ],
    agentId: "runtime-proof-agent",
    bootstrapContext,
    confirmationThreshold: 1,
    maxTurns: 1,
    referenceBundle: {
      documentationPriority: [
        "README.md",
        "playwright.config.ts",
      ],
      guides: [
        "Use the attached repository artifacts as the validation surface for this smoke task.",
      ],
      targetPaths: [
        "README.md",
        "playwright.config.ts",
      ],
    },
    roleManifests: [
      {
        id: "runtime-proof-generalist",
        lane: "generalist",
        safe_fallback: true,
        toolFamilies: ["shell"],
      },
    ],
    runId,
    task,
  };
}

function sanitizeRoutePlan(routePlan) {
  return {
    delegation_payload: routePlan.delegation_payload,
    dispatchable_subtasks: routePlan.dispatchable_subtasks,
    event: routePlan.event,
    explainability: routePlan.explainability,
    reference_bundle: routePlan.reference_bundle,
    routing_policy: routePlan.routing_policy,
    selected_adapter: routePlan.selected_adapter,
    selected_lane: routePlan.selected_lane,
    task: routePlan.task,
  };
}

async function executeLifecycleInput(input) {
  const execution = await routing.runTaskExecution({
    adapters: input.adapters.map((adapterSpec) =>
      createInMemoryTestAdapter({
        capabilities: adapterSpec.capabilities ?? {},
        id: adapterSpec.id,
        metadata: adapterSpec.metadata ?? {},
        protocolType: adapterSpec.protocolType ?? "in_memory",
        scriptedResults: adapterSpec.scriptedResults ?? [],
      })),
    agentId: input.agentId,
    assignments: input.assignments ?? [],
    bootstrapContext: input.bootstrapContext ?? {},
    confirmationThreshold: input.confirmationThreshold ?? 1,
    events: input.events ?? [],
    maxTurns: input.maxTurns ?? 3,
    notes: input.notes ?? [],
    previousCursor: input.previousCursor ?? {},
    referenceBundle: input.referenceBundle ?? {},
    roleManifests: input.roleManifests ?? [],
    routingPolicy: input.routingPolicy ?? {},
    runId: input.runId,
    subtasks: input.subtasks ?? [],
    task: input.task,
  });

  return {
    execution: {
      confirmation_count: execution.execution.confirmation_count,
      final_response: execution.final_response,
      stop_reason: execution.execution.stop_reason,
      turns: execution.execution.turns.map((turn) => ({
        prompt_mode: turn.prompt_mode,
        summary: turn.adapter_response.summary,
        turn_number: turn.turn_number,
      })),
    },
    explainability: execution.explainability,
    route_plan: sanitizeRoutePlan(execution.route_plan),
    run_record: execution.run_record,
    runtime_events: execution.runtime_events,
  };
}

function createIngressRecord({
  taskId,
  timestamp,
}) {
  return {
    id: `${taskId}:ingress`,
    source_type: "backlog_file",
    source_ref: taskId,
    detected_at: timestamp,
    route_candidate: "generalist",
    authority_constraints: [],
    approvals_required: [],
    ingress_status: "ROUTED",
  };
}

function createAssignment({
  taskId,
  timestamp,
}) {
  return {
    id: `${taskId}:assignment`,
    task_id: taskId,
    agent_id: "runtime-proof-agent",
    reason_type: "manual",
    policy_ref: "runtime-proof/v1",
    assigned_at: timestamp,
    context: "Runtime proof selected the safe-fallback generalist lane for the smoke task.",
  };
}

function createReviewSpec({
  rawOutputRef,
  task,
  runOutput,
  timestamp,
}) {
  const finalTask = {
    ...task,
    status: "DONE",
    updated_at: timestamp,
    transition_log: [
      ...task.transition_log,
      {
        timestamp,
        from_status: task.status,
        to_status: "DONE",
        actor: "runtime-proof",
        reason: "Validator lane accepted the runtime proof smoke task.",
      },
    ],
  };

  return {
    actorRole: "validator",
    evidencePacket: {
      authenticity_status: "UNVERIFIED",
      items: [
        {
          type: "command_output",
          source: "acceptance-command:runtime-proof",
          content: runOutput.execution.final_response.summary,
          raw_output_ref: rawOutputRef,
        },
      ],
      markers: {
        checked_urls: [],
        auth_surfaces_attempted: [],
        browser_live_checks: [],
        runtime_evidence_succeeded: true,
      },
    },
    observedOutcome: {
      acceptance_command_results: [{
        command_id: "runtime-proof",
        exit_code: 0,
        ok: true,
        raw_output_ref: rawOutputRef,
      }],
      completion_confirmed: true,
      required_acceptance_command_ids: ["runtime-proof"],
    },
    persistedArtifacts: {
      assignments: [
        createAssignment({
          taskId: task.id,
          timestamp,
        }),
      ],
      events: runOutput.runtime_events,
      explainability: [
        runOutput.explainability,
        runOutput.route_plan?.explainability,
      ].filter(Boolean),
      ingressRecords: [
        createIngressRecord({
          taskId: task.id,
          timestamp,
        }),
      ],
    },
    runRecord: runOutput.run_record,
    task: finalTask,
  };
}

function createProofArtifacts(workspaceRoot) {
  const proofRoot = path.join(workspaceRoot, ".niis", "proofs", "runtime");
  return Object.freeze({
    explain_output: path.join(proofRoot, "explain-output.json"),
    lifecycle_input: path.join(proofRoot, "lifecycle-input.json"),
    lifecycle_output: path.join(proofRoot, "lifecycle-output.json"),
    review_output: path.join(proofRoot, "review-output.json"),
    review_spec: path.join(proofRoot, "review-spec.json"),
    route_output: path.join(proofRoot, "route-output.json"),
    route_spec: path.join(proofRoot, "route-spec.json"),
  });
}

function verifyProofArtifacts(artifacts) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(artifacts).map(([key, artifactPath]) => [key, fs.existsSync(artifactPath)]),
    ),
  );
}

async function runRuntimeProof({
  workspaceRoot = process.cwd(),
  validationSurfaceRoot = workspaceRoot,
  cliEntrypoint = null,
} = {}) {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedValidationSurfaceRoot = path.resolve(validationSurfaceRoot);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resolvedCliEntrypoint = cliEntrypoint
    ? path.resolve(cliEntrypoint)
    : path.resolve(scriptDirectory, "..", "bin", "niis.js");
  const timestamp = "2026-04-02T12:45:00.000Z";
  const task = createTask({
    taskId: "runtime-proof-task",
    title: "Demonstrate the runtime proof contour on the attached repository",
    status: "PENDING",
    timestamp,
  });
  const runId = "runtime-proof-lifecycle-run";
  const attemptId = "runtime-proof-attempt";
  const artifacts = createProofArtifacts(normalizedWorkspaceRoot);
  const steps = [
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "init",
      workspaceRoot: normalizedWorkspaceRoot,
    }),
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "attach",
      commandArgs: ["--validation-surface-root", normalizedValidationSurfaceRoot],
      workspaceRoot: normalizedWorkspaceRoot,
    }),
    runCliStep({
      cliEntrypoint: resolvedCliEntrypoint,
      command: "profile",
      commandArgs: ["--validation-surface-root", normalizedValidationSurfaceRoot],
      workspaceRoot: normalizedWorkspaceRoot,
    }),
  ];

  const bootstrapFailed = steps.some((step) => !step.ok);
  if (bootstrapFailed) {
    throw new RuntimeProofError(
      "runtime proof bootstrap preconditions failed",
      { steps },
    );
  }

  const bootstrapContext = {
    projectProfile: readUtf8(path.join(normalizedWorkspaceRoot, ".niis", "exports", "project-profile.md")),
    workflow: readUtf8(path.join(normalizedWorkspaceRoot, ".niis", "exports", "workflow.md")),
  };
  const routeSpec = createRouteSpec({ task });
  const lifecycleInput = createLifecycleExecutionInput({
    bootstrapContext,
    runId,
    task,
  });
  writeJson(artifacts.route_spec, routeSpec);
  writeJson(artifacts.lifecycle_input, lifecycleInput);

  const routeStep = runCliStep({
    cliEntrypoint: resolvedCliEntrypoint,
    command: "route",
    commandArgs: [path.relative(normalizedWorkspaceRoot, artifacts.route_spec)],
    parseJson: true,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  steps.push(routeStep);

  if (!routeStep.ok) {
    throw new RuntimeProofError(
      "runtime proof failed during route",
      { artifacts, steps },
    );
  }

  writeJson(artifacts.route_output, routeStep.parsed_json);
  const plan = createInitPlan(normalizedWorkspaceRoot);
  const lifecycleStore = storage.createLifecycleSqliteStore({
    databasePath: plan.databasePath,
  });
  const attemptWorkspace = path.join(
    normalizedWorkspaceRoot,
    ".niis",
    "proofs",
    "runtime",
    "attempt-workspaces",
    attemptId,
  );
  let reviewStep = null;
  let lifecycleResult = null;

  try {
    lifecycleResult = await executeCliTaskLifecycle({
      attemptId,
      engineVersion: "runtime-proof/rc-1",
      executeTask: async ({ workspacePath }) => {
        if (path.resolve(workspacePath) !== path.resolve(attemptWorkspace)) {
          throw new Error("lifecycle did not pass the isolated attempt workspace");
        }
        const executionOutput = await executeLifecycleInput(lifecycleInput);
        writeJson(artifacts.lifecycle_output, executionOutput);
        return {
          ...executionOutput,
          final_task: {
            ...task,
            status: "IN_PROGRESS",
          },
        };
      },
      finishTask: async () => ({
        final_status: "IN_REVIEW",
        review_output_ref: ".niis/proofs/runtime/review-output.json",
      }),
      networkPolicy: {
        mode: "disabled",
      },
      prepareWorkspace: async () => {
        fs.mkdirSync(attemptWorkspace, { recursive: true });
        return {
          isolated: true,
          workspacePath: attemptWorkspace,
        };
      },
      promoteTask: async ({ taskResult }) => {
        const branchName = `niis/proof/${task.id}/${attemptId}`;
        const commitSha = createHash("sha256")
          .update(JSON.stringify({
            run_id: taskResult.run_record.id,
            task_id: task.id,
          }))
          .digest("hex");
        return {
          branchName,
          commitSha,
          metadata: {
            auto_merge: false,
            proof_only: true,
          },
          targetKind: "BRANCH",
          targetRef: `refs/heads/${branchName}`,
        };
      },
      reviewTask: async ({ taskResult }) => {
        const reviewSpec = createReviewSpec({
          rawOutputRef: ".niis/proofs/runtime/lifecycle-output.json",
          runOutput: taskResult,
          task,
          timestamp,
        });
        writeJson(artifacts.review_spec, reviewSpec);
        reviewStep = runCliStep({
          cliEntrypoint: resolvedCliEntrypoint,
          command: "review",
          commandArgs: [
            path.relative(normalizedWorkspaceRoot, artifacts.review_spec),
            "--persist",
          ],
          parseJson: true,
          workspaceRoot: normalizedWorkspaceRoot,
        });
        if (!reviewStep.ok) {
          const error = new Error("validator lane failed during lifecycle review");
          error.retrySafe = false;
          throw error;
        }
        writeJson(artifacts.review_output, reviewStep.parsed_json);
        return {
          canonical_verdict:
            reviewStep.parsed_json?.final_verdict?.verdict_class
            ?? "EVIDENCE_GAP",
          reason:
            reviewStep.parsed_json?.final_verdict?.reason
            ?? "validator lane returned no reason",
          review_output_ref: ".niis/proofs/runtime/review-output.json",
          source: "runtime-proof-validator-lane",
        };
      },
      runGates: async ({ taskResult }) => {
        const passed = Boolean(
          taskResult.run_record?.status === "COMPLETED"
          && taskResult.execution?.final_response?.status === "SUCCESS"
          && taskResult.execution?.final_response?.completion_signal === true
          && taskResult.execution?.stop_reason === "CONFIRMED_COMPLETION",
        );
        return {
          canonical_verdict: passed ? "PASS" : "EVIDENCE_GAP",
          evidence_items: [{
            raw_output_ref: ".niis/proofs/runtime/lifecycle-output.json",
            type: "acceptance_command_output",
          }],
          ok: passed,
          results: [{
            command_id: "runtime-proof",
            exit_code: passed ? 0 : 1,
            status: passed ? "PASS" : "FAIL",
          }],
          source: "runtime-proof-deterministic-gate",
        };
      },
      sandboxPolicy: {
        concurrency: 1,
        mode: "workspace-write",
      },
      store: lifecycleStore,
      taskId: task.id,
      trigger: "proof",
      workspacePath: attemptWorkspace,
    });
  } catch (error) {
    steps.push({
      command: "execute-task-lifecycle",
      command_args: [],
      exit_code: 1,
      ok: false,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    });
    throw new RuntimeProofError(
      "runtime proof failed during the durable lifecycle",
      { artifacts, steps },
    );
  } finally {
    lifecycleStore.close();
  }

  const lifecycleStep = {
    command: "execute-task-lifecycle",
    command_args: [],
    exit_code: lifecycleResult?.stage === "FINISHED" ? 0 : 1,
    ok:
      lifecycleResult?.stage === "FINISHED"
      && lifecycleResult?.canonical_verdict === "PASS"
      && reviewStep?.ok === true,
    parsed_json: lifecycleResult,
    stderr: reviewStep?.stderr ?? "",
    stdout: JSON.stringify(lifecycleResult),
  };
  steps.push(lifecycleStep);

  if (!lifecycleStep.ok) {
    throw new RuntimeProofError(
      "runtime proof lifecycle did not finish with a persisted PASS verdict",
      { artifacts, steps },
    );
  }

  const explainStep = runCliStep({
    cliEntrypoint: resolvedCliEntrypoint,
    command: "explain",
    commandArgs: ["--task-id", task.id],
    parseJson: true,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  steps.push(explainStep);

  if (!explainStep.ok) {
    throw new RuntimeProofError(
      "runtime proof failed during explain",
      { artifacts, steps },
    );
  }

  writeJson(artifacts.explain_output, explainStep.parsed_json);

  const artifactChecks = verifyProofArtifacts(artifacts);
  const finalVerdict = lifecycleResult?.canonical_verdict ?? null;
  const ok = steps.every((step) => step.ok)
    && Object.values(artifactChecks).every(Boolean)
    && finalVerdict === "PASS"
    && lifecycleResult?.stage === "FINISHED"
    && lifecycleResult?.promoted === true
    && lifecycleResult?.state?.review?.fresh_context === true
    && Array.isArray(explainStep.parsed_json?.runs)
    && explainStep.parsed_json.runs.length >= 1
    && Array.isArray(explainStep.parsed_json?.explainability)
    && explainStep.parsed_json.explainability.length >= 1;
  const result = {
    artifact_checks: artifactChecks,
    artifacts,
    cli_entrypoint: resolvedCliEntrypoint,
    explain_summary: {
      explainability_count: explainStep.parsed_json?.explainability?.length ?? 0,
      run_count: explainStep.parsed_json?.runs?.length ?? 0,
      task_id: explainStep.parsed_json?.task?.id ?? null,
    },
    final_verdict: finalVerdict,
    lifecycle: lifecycleResult,
    ok,
    steps,
    validation_surface_root: normalizedValidationSurfaceRoot,
    workspace_root: normalizedWorkspaceRoot,
  };

  if (!ok) {
    throw new RuntimeProofError(
      "runtime proof failed; inspect command outputs or persisted explainability state",
      result,
    );
  }

  return Object.freeze(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const validationSurfaceRootFlagIndex = process.argv.indexOf("--validation-surface-root");
    const validationSurfaceRoot = validationSurfaceRootFlagIndex === -1
      ? process.cwd()
      : path.resolve(process.cwd(), process.argv[validationSurfaceRootFlagIndex + 1] ?? ".");

    console.log(JSON.stringify(await runRuntimeProof({
      validationSurfaceRoot,
    }), null, 2));
  } catch (error) {
    if (error instanceof RuntimeProofError && error.result) {
      console.error(JSON.stringify(error.result, null, 2));
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export {
  RuntimeProofError,
  runRuntimeProof,
};
