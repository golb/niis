import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTaskNoteWithMentions,
  createTaskNote,
  extractTaskNoteMentions,
  loadTaskConversation,
} from "./task-notes.js";

function createStorage() {
  const notes = [];

  return {
    taskNotes: {
      async append(note) {
        notes.push(note);
        return note;
      },
      async byTask(taskId) {
        return notes.filter((note) => note.task_id === taskId);
      },
    },
  };
}

test("extractTaskNoteMentions deduplicates agent mentions from note content", () => {
  assert.deepEqual(
    extractTaskNoteMentions("Please take over @agent.review and then sync with @agent.ops @agent.review"),
    ["agent.review", "agent.ops"],
  );
});

test("appendTaskNoteWithMentions persists the note and emits mention wake records", async () => {
  const storage = createStorage();
  const taskNote = createTaskNote({
    id: "note-1",
    taskId: "task-1",
    authorType: "operator",
    authorId: "operator.main",
    content: "Investigate the blocker, then ping @agent.review.",
    createdAt: "2026-03-17T12:00:00.000Z",
  });

  const result = await appendTaskNoteWithMentions({
    storage,
    taskNote,
    now: "2026-03-17T12:00:00.000Z",
  });
  const conversation = await loadTaskConversation(storage, "task-1");

  assert.equal(result.note.id, "note-1");
  assert.equal(result.mention_wakes.length, 1);
  assert.equal(result.mention_wakes[0].mentioned_agent_id, "agent.review");
  assert.equal(result.mention_wakes[0].wake_record.source, "mention");
  assert.equal(result.wake_state.wakeRecords.length, 1);
  assert.equal(conversation.length, 1);
  assert.deepEqual(conversation[0].mentions, ["agent.review"]);
});
