import { parseTaskNote } from "../schemas/task-note.js";
import { registerTaskWake } from "../scheduler/wake.js";
import { toIsoTimestamp } from "../scheduler/queue.js";

class TaskNoteContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "TaskNoteContractError";
  }
}

const TASK_NOTE_MENTION_PATTERN = /@([A-Za-z0-9._-]+)/g;

function ensureNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskNoteContractError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function extractTaskNoteMentions(content) {
  const normalizedContent = ensureNonEmptyString(content, "content");
  const mentions = [];

  for (const match of normalizedContent.matchAll(TASK_NOTE_MENTION_PATTERN)) {
    if (match[1]) {
      mentions.push(match[1].replace(/[.,:;!?]+$/g, ""));
    }
  }

  return [...new Set(mentions)];
}

function createTaskNote({
  id,
  taskId,
  authorType,
  authorId,
  content,
  mentions = null,
  createdAt = new Date(),
}) {
  const normalizedContent = ensureNonEmptyString(content, "content");

  return parseTaskNote({
    author_id: ensureNonEmptyString(authorId, "authorId"),
    author_type: ensureNonEmptyString(authorType, "authorType"),
    content: normalizedContent,
    created_at: toIsoTimestamp(createdAt, "createdAt"),
    id: ensureNonEmptyString(id, "task note id"),
    mentions: mentions === null ? extractTaskNoteMentions(normalizedContent) : mentions,
    task_id: ensureNonEmptyString(taskId, "taskId"),
  });
}

async function appendTaskNote({
  storage,
  taskNote,
}) {
  if (!storage?.taskNotes?.append || typeof storage.taskNotes.append !== "function") {
    throw new TaskNoteContractError("storage.taskNotes.append must exist");
  }

  return storage.taskNotes.append(parseTaskNote(taskNote));
}

async function appendTaskNoteWithMentions({
  deferredWakeups = [],
  leases = [],
  now = new Date(),
  priority = null,
  queueItems = [],
  storage,
  taskNote,
  wakeRecords = [],
}) {
  const normalizedTaskNote = await appendTaskNote({
    storage,
    taskNote,
  });
  let nextWakeState = {
    deferredWakeups,
    queueItems,
    wakeRecords,
  };
  const mentionWakeResults = [];

  for (const mentionedAgentId of normalizedTaskNote.mentions) {
    const wakeResult = registerTaskWake({
      context: {
        mention_author_id: normalizedTaskNote.author_id,
        mention_author_type: normalizedTaskNote.author_type,
        mentioned_agent_id: mentionedAgentId,
        note_id: normalizedTaskNote.id,
      },
      deferredWakeups: nextWakeState.deferredWakeups,
      leases,
      now,
      priority,
      queueItems: nextWakeState.queueItems,
      source: "mention",
      taskId: normalizedTaskNote.task_id,
      wakeRecords: nextWakeState.wakeRecords,
    });

    nextWakeState = {
      deferredWakeups: wakeResult.deferredWakeups,
      queueItems: wakeResult.queueItems,
      wakeRecords: wakeResult.wakeRecords,
    };
    mentionWakeResults.push({
      mentioned_agent_id: mentionedAgentId,
      wake_record: wakeResult.wakeRecord,
    });
  }

  return {
    note: normalizedTaskNote,
    mention_wakes: mentionWakeResults,
    wake_state: nextWakeState,
  };
}

async function loadTaskConversation(storage, taskId) {
  if (!storage?.taskNotes?.byTask || typeof storage.taskNotes.byTask !== "function") {
    throw new TaskNoteContractError("storage.taskNotes.byTask must exist");
  }

  const notes = await storage.taskNotes.byTask(ensureNonEmptyString(taskId, "taskId"));
  return notes.map((note) => parseTaskNote(note));
}

export {
  TASK_NOTE_MENTION_PATTERN,
  TaskNoteContractError,
  appendTaskNote,
  appendTaskNoteWithMentions,
  createTaskNote,
  extractTaskNoteMentions,
  loadTaskConversation,
};
