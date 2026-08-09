import assert from "node:assert/strict";
import test from "node:test";
import { createLlmReviewValidator, normalizeVerdictLabel, parseReviewerJsonResponse } from "./llm-review-validator.js";

test("normalizeVerdictLabel canonicalizes common synonyms", () => {
  assert.equal(normalizeVerdictLabel("pass"), "PASS");
  assert.equal(normalizeVerdictLabel("ACCEPT"), "PASS");
  assert.equal(normalizeVerdictLabel("defect"), "DEFECT");
  assert.equal(normalizeVerdictLabel("REJECTED"), "DEFECT");
  assert.equal(normalizeVerdictLabel("evidence_gap"), "EVIDENCE_GAP");
  assert.equal(normalizeVerdictLabel("unclear"), "EVIDENCE_GAP");
  assert.equal(normalizeVerdictLabel("??"), null);
  assert.equal(normalizeVerdictLabel(null), null);
});

test("parseReviewerJsonResponse extracts trailing JSON block", () => {
  const text = "Review notes...\nFinally:\n{\"verdict\": \"PASS\", \"reason\": \"all good\"}";
  const parsed = parseReviewerJsonResponse(text);
  assert.deepEqual(parsed, { reason: "all good", verdict: "PASS" });
});

test("parseReviewerJsonResponse returns null for non-JSON", () => {
  assert.equal(parseReviewerJsonResponse("nothing to see here"), null);
  assert.equal(parseReviewerJsonResponse(""), null);
  assert.equal(parseReviewerJsonResponse(null), null);
});

test("llm-review skips gracefully when llmReviewer is not wired", async () => {
  const validator = createLlmReviewValidator();
  const result = await validator.validate({
    evidencePacket: { items: [{ content: "ok", type: "subtask_summary" }], markers: {} },
    evidenceRuntime: {},
    task: { acceptance_markdown: "criteria", operator_brief_markdown: "brief", title: "t" },
  });
  assert.equal(result.verdict_class, "EVIDENCE_GAP");
  assert.match(result.reason, /not configured/);
});

test("llm-review returns EVIDENCE_GAP when there are no summaries", async () => {
  const validator = createLlmReviewValidator();
  const result = await validator.validate({
    evidencePacket: { items: [], markers: {} },
    evidenceRuntime: { llmReviewer: async () => ({ verdict: "PASS" }) },
    task: { acceptance_markdown: "criteria", title: "t" },
  });
  assert.equal(result.verdict_class, "EVIDENCE_GAP");
  assert.match(result.reason, /No agent summaries/);
});

test("llm-review returns PASS when reviewer accepts", async () => {
  const validator = createLlmReviewValidator();
  const result = await validator.validate({
    evidencePacket: {
      items: [{ content: "Added function countByState", source: "subtask:1", type: "subtask_summary" }],
      markers: {},
    },
    evidenceRuntime: {
      llmReviewer: async () => ({ next_action: "accept", reason: "criteria met", verdict: "PASS" }),
    },
    task: { acceptance_markdown: "Add countByState", title: "Task 3" },
  });
  assert.equal(result.verdict_class, "PASS");
  assert.equal(result.reason, "criteria met");
  const lastItem = result.evidence_packet.items.at(-1);
  assert.equal(lastItem.type, "llm_review");
});

test("llm-review returns DEFECT when reviewer rejects", async () => {
  const validator = createLlmReviewValidator();
  const result = await validator.validate({
    evidencePacket: {
      items: [{ content: "Added unrelated file", source: "subtask:1", type: "subtask_summary" }],
      markers: {},
    },
    evidenceRuntime: {
      llmReviewer: async () => ({ reason: "did not add countByState", verdict: "DEFECT" }),
    },
    task: { acceptance_markdown: "Add countByState", title: "Task 3" },
  });
  assert.equal(result.verdict_class, "DEFECT");
  assert.equal(result.blocker_class, "MISSING_EVIDENCE");
  assert.equal(result.failure_attribution, "task_local");
});

test("llm-review reports EVIDENCE_GAP when reviewer throws", async () => {
  const validator = createLlmReviewValidator();
  const result = await validator.validate({
    evidencePacket: {
      items: [{ content: "summary", source: "subtask:1", type: "subtask_summary" }],
      markers: {},
    },
    evidenceRuntime: {
      llmReviewer: async () => { throw new Error("runtime not available"); },
    },
    task: { acceptance_markdown: "x", title: "t" },
  });
  assert.equal(result.verdict_class, "EVIDENCE_GAP");
  assert.match(result.reason, /runtime not available/);
});

test("llm-review extracts review_target JSON and passes it to the reviewer", async () => {
  const validator = createLlmReviewValidator();
  let capturedInputs = null;
  const target = {
    branch_name: "niis/t/subtask:1",
    source_branch: "niis/task/t",
    worktree_path: "/tmp/wt/subtask-1",
  };
  const result = await validator.validate({
    evidencePacket: {
      items: [
        { content: "did work", source: "subtask:1", subtask_id: "subtask:1", type: "subtask_summary" },
        { content: JSON.stringify(target), source: "review-target:subtask:1", subtask_id: "subtask:1", type: "review_target" },
      ],
      markers: {},
    },
    evidenceRuntime: {
      llmReviewer: async (inputs) => {
        capturedInputs = inputs;
        return { reason: "ok", verdict: "PASS" };
      },
    },
    task: { acceptance_markdown: "a", title: "t" },
  });
  assert.equal(result.verdict_class, "PASS");
  assert.deepEqual(capturedInputs.reviewTarget, { ...target, subtask_id: "subtask:1" });
});

test("llm-review tolerates invalid review_target JSON", async () => {
  const validator = createLlmReviewValidator();
  let capturedInputs = null;
  const result = await validator.validate({
    evidencePacket: {
      items: [
        { content: "did work", source: "subtask:1", subtask_id: "subtask:1", type: "subtask_summary" },
        { content: "not-json", source: "review-target:subtask:1", subtask_id: "subtask:1", type: "review_target" },
      ],
      markers: {},
    },
    evidenceRuntime: {
      llmReviewer: async (inputs) => {
        capturedInputs = inputs;
        return { reason: "ok", verdict: "PASS" };
      },
    },
    task: { acceptance_markdown: "a", title: "t" },
  });
  assert.equal(result.verdict_class, "PASS");
  assert.equal(capturedInputs.reviewTarget, null);
});

test("llm-review forwards git_diff items to the reviewer as diffs", async () => {
  const validator = createLlmReviewValidator();
  let capturedInputs = null;
  const result = await validator.validate({
    evidencePacket: {
      items: [
        { content: "Added countByState function", source: "subtask:1", subtask_id: "subtask:1", type: "subtask_summary" },
        { content: "diff --git a/x.js b/x.js\n+export function x() {}", source: "git-diff:subtask:1", subtask_id: "subtask:1", type: "git_diff" },
      ],
      markers: {},
    },
    evidenceRuntime: {
      llmReviewer: async (inputs) => {
        capturedInputs = inputs;
        return { reason: "diff matches brief", verdict: "PASS" };
      },
    },
    task: { acceptance_markdown: "Add countByState", title: "Task 3" },
  });
  assert.equal(result.verdict_class, "PASS");
  assert.equal(capturedInputs.diffs.length, 1);
  assert.match(capturedInputs.diffs[0].content, /export function x/);
  assert.equal(capturedInputs.summaries.length, 1);
});

test("llm-review passes through unknown verdict labels as EVIDENCE_GAP", async () => {
  const validator = createLlmReviewValidator();
  const result = await validator.validate({
    evidencePacket: {
      items: [{ content: "summary", source: "subtask:1", type: "subtask_summary" }],
      markers: {},
    },
    evidenceRuntime: {
      llmReviewer: async () => ({ reason: "reviewer confused", verdict: "maybe?" }),
    },
    task: { acceptance_markdown: "x", title: "t" },
  });
  assert.equal(result.verdict_class, "EVIDENCE_GAP");
});
