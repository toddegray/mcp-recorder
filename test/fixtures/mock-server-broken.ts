#!/usr/bin/env bun
// Same protocol as mock-server.ts, but the `echo` tool's output format has
// changed — the text now has a different prefix. A faithful semantic diff
// should catch this regression and nothing else.

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
      // REGRESSION: prefix changed from "echo: " to "ECHOED: "
      result: { content: [{ type: "text", text: `ECHOED: ${msg}` }] },
    });
    return;
  }

  if (req.method && !("id" in req)) return;

  if (req.id !== undefined) {
    respond({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    });
  }
});

rl.on("close", () => process.exit(0));
