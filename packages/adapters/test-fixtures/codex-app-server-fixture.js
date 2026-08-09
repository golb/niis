import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.NIIS_CODEX_FIXTURE_MODE ?? "complete";
const pidFile = process.env.NIIS_CODEX_FIXTURE_PID_FILE;
const requestLog = process.env.NIIS_CODEX_FIXTURE_REQUEST_LOG;
const requestPayloadLog =
  process.env.NIIS_CODEX_FIXTURE_REQUEST_PAYLOAD_LOG;

if (process.env.NIIS_CODEX_FIXTURE_IGNORE_TERM === "1") {
  process.on("SIGTERM", () => {});
}

let grandchild = null;
if (process.env.NIIS_CODEX_FIXTURE_GRANDCHILD === "1") {
  grandchild = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join(""),
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise((resolve, reject) => {
    grandchild.once("error", reject);
    grandchild.stdout.once("data", resolve);
  });
}

if (pidFile) {
  fs.writeFileSync(pidFile, JSON.stringify({
    grandchildPid: grandchild?.pid ?? null,
    parentPid: process.pid,
  }));
}

function recordRequest(message) {
  if (requestLog) fs.appendFileSync(requestLog, `${message.method ?? "response"}\n`);
  if (requestPayloadLog) {
    fs.appendFileSync(requestPayloadLog, `${JSON.stringify(message)}\n`);
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({
    id,
    jsonrpc: "2.0",
    result,
  })}\n`);
}

const lines = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

lines.on("line", (line) => {
  const message = JSON.parse(line);
  recordRequest(message);

  if (message.method === "initialize") {
    if (mode !== "hang-initialize") {
      respond(message.id, {
        capabilities: {},
        serverInfo: { name: "fixture", version: "1" },
      });
    }
    return;
  }

  if (message.method === "thread/start") {
    if (mode !== "hang-thread-start") {
      respond(message.id, { thread: { id: "fixture-thread" } });
    }
    return;
  }

  if (message.method === "turn/start") {
    respond(message.id, { turn: { id: "fixture-turn" } });
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "fixture-thread",
        turn: { id: "fixture-turn", status: "completed" },
      },
    })}\n`);
    return;
  }

  if (message.method === "turn/interrupt") {
    respond(message.id, {});
  }
});
