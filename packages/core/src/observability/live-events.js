import { parseEventLogEntry } from "../schemas/event.js";

class LiveEventProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveEventProtocolError";
  }
}

function createLiveEventEnvelope(event) {
  const normalizedEvent = parseEventLogEntry(event);

  return Object.freeze({
    event_id: normalizedEvent.id,
    event_type: normalizedEvent.event_type,
    timestamp: normalizedEvent.timestamp,
    payload: Object.freeze({
      actor: normalizedEvent.actor,
      data: structuredClone(normalizedEvent.payload ?? {}),
      run_id: normalizedEvent.run_id,
      task_id: normalizedEvent.task_id,
    }),
  });
}

function normalizeLiveEventSink(liveEventSink) {
  if (liveEventSink === undefined || liveEventSink === null) {
    return null;
  }

  if (typeof liveEventSink === "function") {
    return Object.freeze({
      emit: liveEventSink,
      emitBatch: null,
    });
  }

  if (typeof liveEventSink !== "object" || Array.isArray(liveEventSink)) {
    throw new LiveEventProtocolError("liveEventSink must be a function or plain object");
  }

  if (typeof liveEventSink.emitBatch === "function") {
    return Object.freeze({
      emit: null,
      emitBatch: (events) => liveEventSink.emitBatch(events),
    });
  }

  if (typeof liveEventSink.emit === "function") {
    return Object.freeze({
      emit: (event) => liveEventSink.emit(event),
      emitBatch: null,
    });
  }

  if (typeof liveEventSink.append === "function") {
    return Object.freeze({
      emit: (event) => liveEventSink.append(event),
      emitBatch: null,
    });
  }

  throw new LiveEventProtocolError(
    "liveEventSink must provide emitBatch(events), emit(event), or append(event)",
  );
}

async function emitLiveEventBatch(liveEventSink, events = []) {
  const normalizedSink = normalizeLiveEventSink(liveEventSink);
  const envelopes = events
    .filter(Boolean)
    .map((event) => createLiveEventEnvelope(event));

  if (!normalizedSink || envelopes.length === 0) {
    return envelopes;
  }

  if (normalizedSink.emitBatch) {
    await normalizedSink.emitBatch(envelopes);
    return envelopes;
  }

  for (const envelope of envelopes) {
    await normalizedSink.emit(envelope);
  }

  return envelopes;
}

export {
  LiveEventProtocolError,
  createLiveEventEnvelope,
  emitLiveEventBatch,
  normalizeLiveEventSink,
};
