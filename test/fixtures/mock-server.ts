#!/usr/bin/env bun
// Minimal mock MCP server for end-to-end tests.
//
// Speaks just enough of the protocol to exercise mcp-recorder:
//   - initialize → returns a capabilities stub
//   - tools/list → returns one echo tool
//   - tools/call(name="echo", args.message="x") → returns a text block
//   - unknown method → returns method-not-found error
//
// Reads newline-delimited JSON from stdin, writes newline-delimited JSON to
// stdout. Exits on EOF.

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const respond = (body: any) => {
    process.stdout.write(JSON.stringify(body) + "\n");
  };

  if (req.method === "initialize") {
    respond({
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
    });
    return;
  }

  if (req.method === "tools/list") {
    respond({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Returns the message you pass it",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      },
    });
    return;
  }

  if (req.method === "tools/call") {
    const msg = req.params?.arguments?.message ?? "";
    respond({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: `echo: ${msg}` }] },
    });
    return;
  }

  // Notifications: swallow silently.
  if (req.method && !("id" in req)) return;

  // Unknown request method.
  if (req.id !== undefined) {
    respond({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    });
  }
});

rl.on("close", () => process.exit(0));
