import { once } from "node:events";
import { spawn } from "node:child_process";

import { createAdapterDefinition } from "../core/src/contracts/adapter.js";

class McpServerAdapterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "McpServerAdapterError";
    this.category = options.category ?? "transient";
    this.retrySafe = options.retrySafe ?? false;
    this.escalationHint = options.escalationHint ?? null;
  }
}

function toText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

function formatMcpContent(content = []) {
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item?.text === "string") {
        return item.text;
      }

      return toText(item);
    })
    .filter((item) => item.trim() !== "")
    .join("\n");
}

function createProtocolError(message, options = {}) {
  return new McpServerAdapterError(message, {
    category: options.category ?? "transient",
    escalationHint:
      options.escalationHint
      ?? "Inspect the MCP server process, handshake, and tool contract before retrying.",
    retrySafe: options.retrySafe ?? false,
  });
}

function encodeMessage(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  return Buffer.from(`Content-Length: ${body.length}\r\n\r\n${json}`, "utf8");
}

function encodeJsonLineMessage(payload) {
  return Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
}

function extractJsonLineMessages(buffer) {
  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\n", offset, "utf8");
    if (lineEnd === -1) break;
    const line = buffer.toString("utf8", offset, lineEnd).replace(/\r$/, "");
    offset = lineEnd + 1;
    if (line.trim() === "") continue;
    messages.push(JSON.parse(line));
  }

  return {
    messages,
    remainder: buffer.subarray(offset),
  };
}

function extractMessages(buffer, framing = "content_length") {
  if (framing === "json_lines") {
    return extractJsonLineMessages(buffer);
  }

  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset, "utf8");

    if (headerEnd === -1) {
      break;
    }

    const header = buffer.toString("utf8", offset, headerEnd);
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);

    if (!contentLengthMatch) {
      throw createProtocolError("MCP server sent a frame without Content-Length header.");
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (buffer.length < bodyEnd) {
      break;
    }

    const body = buffer.toString("utf8", bodyStart, bodyEnd);
    messages.push(JSON.parse(body));
    offset = bodyEnd;
  }

  return {
    messages,
    remainder: buffer.subarray(offset),
  };
}

async function closeTransport(child) {
  if (child.exitCode !== null) {
    return;
  }

  if (child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
  }

  const exitPromise = once(child, "exit").catch(() => undefined);
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(resolve, 200);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
}

function buildErrorResponse(error, summaryPrefix) {
  const normalizedError = error instanceof McpServerAdapterError
    ? error
    : createProtocolError(error instanceof Error ? error.message : String(error), {
      retrySafe: true,
    });

  return {
    status: "ERROR",
    summary: `${summaryPrefix}: ${normalizedError.message}`,
    next_actions: [
      "Inspect the MCP server configuration and declared tool name.",
      "Retry only after the MCP transport and tool contract are healthy.",
    ],
    artifacts: [],
    cost: null,
    completion_signal: null,
    self_assessment: null,
    error: {
      root_cause: normalizedError.message,
      category: normalizedError.category,
      retry_safe: normalizedError.retrySafe,
      retry_instruction: normalizedError.retrySafe
        ? "Retry after the MCP transport or server issue is resolved."
        : null,
      stop_condition: "MCP adapter could not complete the requested server interaction.",
      escalation_hint: normalizedError.escalationHint,
    },
  };
}

function createMcpTransport({
  command,
  args = [],
  cwd = undefined,
  env = {},
  framing = "content_length",
}) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new McpServerAdapterError("MCP adapter requires a non-empty server command.", {
      category: "env_block",
      escalationHint: "Provide a valid stdio MCP server command before executing the adapter.",
      retrySafe: false,
    });
  }

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pendingResponses = new Map();
  let nextId = 1;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);

    try {
      const parsed = extractMessages(stdoutBuffer, framing);
      stdoutBuffer = parsed.remainder;

      for (const message of parsed.messages) {
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          const pending = pendingResponses.get(message.id);

          if (pending) {
            pendingResponses.delete(message.id);

            if (message.error) {
              pending.reject(
                createProtocolError(
                  `MCP server returned ${message.error.code ?? "error"}: ${message.error.message ?? "unknown error"}`,
                  {
                    retrySafe: false,
                  },
                ),
              );
              continue;
            }

            pending.resolve(message.result ?? null);
          }
        }
      }
    } catch (error) {
      for (const pending of pendingResponses.values()) {
        pending.reject(error);
      }
      pendingResponses.clear();
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
  });

  child.on("error", (error) => {
    const normalizedError = new McpServerAdapterError(
      `Failed to start MCP server process: ${error.message}`,
      {
        category: "env_block",
        escalationHint: "Install or fix the MCP server executable and retry diagnostics.",
        retrySafe: false,
      },
    );

    for (const pending of pendingResponses.values()) {
      pending.reject(normalizedError);
    }
    pendingResponses.clear();
  });

  child.on("exit", (code, signal) => {
    if (pendingResponses.size === 0) {
      return;
    }

    const details = stderrBuffer.trim();
    const reason = `MCP server exited before replying (code=${code ?? "null"}, signal=${signal ?? "null"})`;
    const message = details ? `${reason}: ${details}` : reason;
    const error = createProtocolError(message, {
      category: "env_block",
      retrySafe: false,
      escalationHint: "Inspect the MCP server stderr output and fix the server before retrying.",
    });

    for (const pending of pendingResponses.values()) {
      pending.reject(error);
    }
    pendingResponses.clear();
  });

  async function send(payload) {
    if (!child.stdin || child.stdin.destroyed) {
      throw createProtocolError("MCP transport is closed.", {
        category: "env_block",
        retrySafe: false,
      });
    }

    child.stdin.write(framing === "json_lines" ? encodeJsonLineMessage(payload) : encodeMessage(payload));
  }

  async function request(method, params = {}) {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      pendingResponses.set(id, {
        reject,
        resolve,
      });

      send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }).catch((error) => {
        pendingResponses.delete(id);
        reject(error);
      });
    });
  }

  async function notify(method, params = {}) {
    await send({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  return {
    async initialize({
      clientInfo = {
        name: "niis-mcp-adapter",
        version: "0.1.0",
      },
      capabilities = {},
      protocolVersion = "2026-03-21",
    } = {}) {
      const result = await request("initialize", {
        capabilities,
        clientInfo,
        protocolVersion,
      });

      await notify("notifications/initialized", {});
      return result ?? {};
    },
    listTools() {
      return request("tools/list", {});
    },
    callTool({
      name,
      arguments: toolArguments = {},
    }) {
      return request("tools/call", {
        arguments: toolArguments,
        name,
      });
    },
    close() {
      return closeTransport(child);
    },
  };
}

function createMcpServerAdapter({
  id = "mcp-server-adapter",
  command,
  args = [],
  cwd = undefined,
  env = {},
  metadata = {},
  defaultToolName = null,
  protocolType = "mcp_server",
  adapterKind = protocolType,
  capabilities = {},
  requiredEnv = [],
  optionalEnv = [],
  runtimeTools = () => [],
  messageFraming = "content_length",
}) {
  const sharedConfig = {
    args,
    command,
    cwd,
    env,
    framing: messageFraming,
  };

  return createAdapterDefinition({
    id,
    protocolType,
    capabilities: {
      adapterKind,
      operations: ["execute", "runtime_tools.execute", ...(capabilities.operations ?? [])],
      permissions: capabilities.permissions ?? [],
      privilegedOperations: capabilities.privilegedOperations ?? [],
      toolFamilies: capabilities.toolFamilies ?? ["mcp"],
      allow: capabilities.allow ?? {},
      deny: capabilities.deny ?? {},
    },
    execute: async (context = {}) => {
      const transport = createMcpTransport(sharedConfig);

      try {
        const initialization = await transport.initialize();
        const toolsResult = await transport.listTools();
        const availableTools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
        const toolCall = context.tool_call ?? context.mcp_tool_call ?? {};
        const toolName = toolCall.name ?? defaultToolName;

        if (typeof toolName !== "string" || toolName.trim() === "") {
          throw new McpServerAdapterError(
            "MCP execution requires tool_call.name or defaultToolName.",
            {
              category: "permanent",
              retrySafe: false,
              escalationHint: "Provide the MCP tool name in the run context or adapter config.",
            },
          );
        }

        if (!availableTools.some((tool) => tool?.name === toolName)) {
          throw new McpServerAdapterError(
            `MCP server does not expose tool ${toolName}.`,
            {
              category: "permanent",
              retrySafe: false,
              escalationHint: "Update the configured tool name or fix the MCP server tool list.",
            },
          );
        }

        const toolResult = await transport.callTool({
          name: toolName,
          arguments: toolCall.arguments ?? toolCall.args ?? {},
        });
        const summary = formatMcpContent(toolResult?.content)
          || `MCP tool ${toolName} completed successfully.`;

        return {
          status: toolResult?.isError ? "ERROR" : "SUCCESS",
          summary,
          next_actions: [],
          artifacts: [
            {
              type: "mcp_tool_call",
              path: `mcp://${toolName}`,
            },
          ],
          cost: null,
          completion_signal: toolResult?.isError ? null : true,
          self_assessment: null,
          error: toolResult?.isError
            ? {
              root_cause: summary,
              category: "permanent",
              retry_safe: false,
              retry_instruction: null,
              stop_condition: "MCP server returned a tool-level error result.",
              escalation_hint: "Inspect the MCP tool implementation and retry only after fixing it.",
            }
            : null,
        };
      } catch (error) {
        return buildErrorResponse(error, "MCP execution failed");
      } finally {
        await transport.close();
      }
    },
    normalize: (result) => {
      if (result?.status) {
        return result;
      }

      return buildErrorResponse(
        createProtocolError("MCP adapter received an opaque result payload.", {
          retrySafe: false,
        }),
        "MCP normalization failed",
      );
    },
    optionalEnv: () => optionalEnv,
    requiredEnv: () => requiredEnv,
    runtimeTools,
    sessionCodec: {
      serialize: (sessionParams) => ({
        ...sessionParams,
      }),
      deserialize: (stored) => ({
        ...stored,
      }),
      compactionHandoff: (sessions) =>
        `mcp-server handoff for ${sessions.length} session(s)`,
    },
    test: async () => {
      const transport = createMcpTransport(sharedConfig);

      try {
        const initialization = await transport.initialize();
        const toolsResult = await transport.listTools();
        const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];

        return {
          ok: true,
          checks: [
            {
              name: "mcp.initialize",
              status: "PASS",
              message: `Connected to MCP server ${initialization?.serverInfo?.name ?? "unknown"}.`,
            },
            {
              name: "mcp.tools.list",
              status: "PASS",
              message: `MCP server exposed ${tools.length} tool(s).`,
            },
          ],
        };
      } catch (error) {
        return {
          ok: false,
          checks: [
            {
              name: "mcp.initialize",
              status: "FAIL",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      } finally {
        await transport.close();
      }
    },
    metadata: {
      ...metadata,
      transport: "stdio",
    },
  });
}

export {
  McpServerAdapterError,
  createMcpServerAdapter,
};
