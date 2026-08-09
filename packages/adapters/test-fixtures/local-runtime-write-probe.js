import fs from "node:fs";
import path from "node:path";

function tryWrite(target) {
  try {
    fs.writeFileSync(target, "probe\n");
    return true;
  } catch {
    return false;
  }
}

const outcome = {
  backend: process.env.NIIS_EXECUTION_SANDBOX_BACKEND,
  primary: tryWrite(process.env.FAKE_PRIMARY_TARGET),
  runtimeTemp: tryWrite(path.join(process.env.TMPDIR, "runtime-temp.txt")),
  symlink: tryWrite(process.env.FAKE_SYMLINK_TARGET),
  workspace: tryWrite(process.env.FAKE_WORKSPACE_TARGET),
};

process.stdout.write(JSON.stringify({
  artifacts: [],
  completion_signal: true,
  cost: null,
  error: null,
  next_actions: [],
  self_assessment: null,
  status: "SUCCESS",
  summary: JSON.stringify(outcome),
}));
