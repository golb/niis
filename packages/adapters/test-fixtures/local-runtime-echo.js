#!/usr/bin/env node
const runtime = process.argv.includes("--runtime")
  ? process.argv[process.argv.indexOf("--runtime") + 1]
  : "local_runtime";

if (process.argv.includes("--version")) {
  console.log(`${runtime} 0.1.0`);
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let context = {};

  try {
    context = input.trim() ? JSON.parse(input) : {};
  } catch (error) {
    console.error(`${runtime} received invalid JSON input: ${error.message}`);
    process.exit(1);
  }

  if (
    context.expected_workspace_path
    && context.expected_workspace_path !== process.cwd()
  ) {
    console.error(`unexpected workspace: ${process.cwd()}`);
    process.exit(2);
  }

  const summary = context.summary
    ?? context.prompt
    ?? context.task?.title
    ?? "local runtime executed";

  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    summary: `${runtime}:${summary}`,
    next_actions: [],
    artifacts: [],
    cost: {
      input_tokens: 150,
      output_tokens: 42,
      estimated_usd: 0.003,
    },
    completion_signal: true,
    self_assessment: null,
    error: null,
  }));
});
