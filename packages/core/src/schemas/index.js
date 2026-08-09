import { SchemaValidationError } from "./shared.js";
import * as task from "./task.js";
import * as subtask from "./subtask.js";
import * as agent from "./agent.js";
import * as goal from "./goal.js";
import * as taskNote from "./task-note.js";
import * as approval from "./approval.js";
import * as ingress from "./ingress.js";
import * as assignment from "./assignment.js";
import * as run from "./run.js";
import * as event from "./event.js";
import * as checkpoint from "./checkpoint.js";
import * as adapterResponse from "./adapter-response.js";
import * as taskSession from "./task-session.js";
import * as taskRunSession from "./task-run-session.js";
import * as taskRunEvent from "./task-run-event.js";
import * as taskLiveExcerpt from "./task-live-excerpt.js";
import * as taskContentRevision from "./task-content-revision.js";
import * as verdict from "./verdict.js";
import * as evidence from "./evidence.js";
import * as blocker from "./blocker.js";
import * as contextContract from "./context-contract.js";
import * as explainability from "./explainability.js";
import * as packageManifest from "./package-manifest.js";
import * as conversionReport from "./conversion-report.js";
import * as instinct from "./instinct.js";
import * as observationArtifact from "./observation-artifact.js";
import * as skillCandidate from "./skill-candidate.js";
import {
  BACKWARD_COMPATIBILITY_RULES,
  REGISTERED_ENTITY_VERSION_FIELD,
  SchemaRegistryError,
  buildDefaultSchemaRegistry,
  createSchemaRegistry,
  isBackwardCompatibleChange,
} from "./registry.js";

const schemaModules = [
  task,
  subtask,
  agent,
  goal,
  taskNote,
  approval,
  ingress,
  assignment,
  run,
  event,
  checkpoint,
  adapterResponse,
  taskSession,
  taskRunSession,
  taskRunEvent,
  taskLiveExcerpt,
  taskContentRevision,
  verdict,
  evidence,
  blocker,
  contextContract,
  explainability,
  packageManifest,
  conversionReport,
  instinct,
  observationArtifact,
  skillCandidate,
].map((module) => {
  const schema = Object.values(module).find((value) => value && value.entity && value.version);
  const parse = Object.values(module).find(
    (value) => typeof value === "function" && value.name.startsWith("parse"),
  );

  if (!schema || !parse) {
    throw new Error("Schema module must export both a schema descriptor and a parse helper");
  }

  return {
    entity: schema.entity,
    name: schema.name,
    version: schema.version,
    schema,
    parse,
  };
});

const defaultSchemaRegistry = buildDefaultSchemaRegistry(schemaModules);

export {
  BACKWARD_COMPATIBILITY_RULES,
  REGISTERED_ENTITY_VERSION_FIELD,
  SchemaRegistryError,
  SchemaValidationError,
  adapterResponse,
  agent,
  assignment,
  blocker,
  checkpoint,
  contextContract,
  conversionReport,
  createSchemaRegistry,
  defaultSchemaRegistry,
  evidence,
  event,
  explainability,
  goal,
  ingress,
  instinct,
  isBackwardCompatibleChange,
  observationArtifact,
  packageManifest,
  run,
  schemaModules,
  skillCandidate,
  subtask,
  task,
  approval,
  taskSession,
  taskRunSession,
  taskRunEvent,
  taskLiveExcerpt,
  taskContentRevision,
  taskNote,
  verdict,
};
