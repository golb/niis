let buffer = Buffer.alloc(0);

function writeMessage(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${json}`);
}

function extractMessages() {
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
      throw new Error("missing Content-Length");
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (buffer.length < bodyEnd) {
      break;
    }

    messages.push(JSON.parse(buffer.toString("utf8", bodyStart, bodyEnd)));
    offset = bodyEnd;
  }

  buffer = buffer.subarray(offset);
  return messages;
}

function respond(message) {
  if (message.method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2026-03-21",
        serverInfo: {
          name: "fixture-mcp-server",
          version: "0.1.0",
        },
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Return the provided text.",
            inputSchema: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                },
              },
              required: ["text"],
            },
          },
          {
            name: "sum",
            description: "Return the sum of provided numbers.",
            inputSchema: {
              type: "object",
              properties: {
                values: {
                  type: "array",
                  items: {
                    type: "number",
                  },
                },
              },
              required: ["values"],
            },
          },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call") {
    const toolName = message.params?.name;

    if (toolName === "echo") {
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: `echo:${message.params?.arguments?.text ?? ""}`,
            },
          ],
          isError: false,
        },
      });
      return;
    }

    if (toolName === "sum") {
      const values = Array.isArray(message.params?.arguments?.values)
        ? message.params.arguments.values
        : [];
      const sum = values.reduce((total, value) => total + Number(value), 0);

      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: `sum:${sum}`,
            },
          ],
          isError: false,
        },
      });
      return;
    }

    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: `unknown:${toolName ?? ""}`,
          },
        ],
        isError: true,
      },
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  try {
    const messages = extractMessages();

    for (const message of messages) {
      if (message.method === "notifications/initialized") {
        continue;
      }

      respond(message);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
});
