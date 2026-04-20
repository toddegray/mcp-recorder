// `mcp-recorder serve` — expose recording/analysis as MCP tools.
//
// We implement a minimal native MCP server over stdio (JSON-RPC 2.0) using
// our own LineFramer. This avoids a runtime dependency on
// @modelcontextprotocol/sdk, keeps the single-binary story intact, and
// dogfoods our own framing code.
//
// Supported RPC methods:
//   initialize       → capability handshake
//   tools/list       → enumerate our four introspection tools
//   tools/call       → dispatch to the relevant handler
//   shutdown         → clean exit

import { createInterface } from "node:readline";
import {
  readSession,
  listSessions,
  defaultSessionDir,
} from "./session.ts";
import { replay as runReplay } from "./replay.ts";
import { diffSessions } from "./diff.ts";
import { loadConfig } from "./config.ts";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";

const SERVER_NAME = "mcp-recorder";
const SERVER_VERSION = "0.3.0";
const PROTOCOL_VERSION = "2024-11-05";

interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}
interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "List recorded MCP sessions in a directory (default ~/.mcp-recorder/sessions)",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string" } },
    },
  },
  {
    name: "show_session",
    description:
      "Read a recorded session and return its entries + summary as JSON",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "session name or path" },
        dir: { type: "string" },
      },
      required: ["session"],
    },
  },
  {
    name: "diff_sessions",
    description:
      "Semantically diff two sessions. Returns per-request entries and summary counts.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        dir: { type: "string" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "replay_session",
    description:
      "Replay a recorded session against a fresh server, write <name>.replay.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        dir: { type: "string" },
        command: {
          type: "string",
          description: "command to spawn for the fresh server",
        },
        args: { type: "array", items: { type: "string" } },
        out: { type: "string" },
      },
      required: ["session", "command"],
    },
  },
];

export async function serve(): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  const send = (msg: RpcResponse) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };

  const errorResponse = (
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message, data } });

  const handleRequest = async (req: RpcRequest): Promise<RpcResponse | null> => {
    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
    }

    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } };
    }

    if (req.method === "tools/call") {
      const p = (req.params ?? {}) as Record<string, unknown>;
      const name = String(p.name ?? "");
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await dispatchTool(name, args);
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err) {
        return errorResponse(
          req.id,
          -32000,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (req.method === "shutdown") {
      setImmediate(() => process.exit(0));
      return { jsonrpc: "2.0", id: req.id, result: null };
    }

    return errorResponse(req.id, -32601, `method not found: ${req.method}`);
  };

  // Track in-flight handlers so we don't exit before they finish on EOF.
  const inflight = new Set<Promise<void>>();

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // silently drop malformed input, like most MCP servers
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as RpcRequest;
    // Only requests (method + id) get a response. Notifications are accepted.
    if (typeof msg.method !== "string") return;
    if (!("id" in msg)) return;
    const work = (async () => {
      const resp = await handleRequest(msg);
      if (resp) send(resp);
    })();
    inflight.add(work);
    work.finally(() => inflight.delete(work));
  });

  await new Promise<void>((resolve) => {
    rl.on("close", async () => {
      await Promise.allSettled([...inflight]);
      resolve();
    });
  });
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_sessions": {
      const dir = String(args.dir ?? defaultSessionDir());
      return {
        dir,
        sessions: listSessions(dir).map((s) => ({
          name: s.name,
          path: s.path,
          sizeBytes: s.size,
          mtime: s.mtime.toISOString(),
        })),
      };
    }
    case "show_session": {
      const dir = String(args.dir ?? defaultSessionDir());
      const path = resolveSessionPath(String(args.session ?? ""), dir);
      if (!existsSync(path)) throw new Error(`session not found: ${path}`);
      const session = await readSession(path);
      return { path, summary: session.summary, entryCount: session.entries.length };
    }
    case "diff_sessions": {
      const dir = String(args.dir ?? defaultSessionDir());
      const a = resolveSessionPath(String(args.a ?? ""), dir);
      const b = resolveSessionPath(String(args.b ?? ""), dir);
      if (!existsSync(a)) throw new Error(`session not found: ${a}`);
      if (!existsSync(b)) throw new Error(`session not found: ${b}`);
      const { options } = loadConfig(dir);
      const report = await diffSessions(a, b, options);
      return {
        counts: report.counts,
        entries: report.entries.map((e) => ({
          state: e.state,
          method: e.method,
          changes: e.changes ?? [],
        })),
      };
    }
    case "replay_session": {
      const dir = String(args.dir ?? defaultSessionDir());
      const session = resolveSessionPath(String(args.session ?? ""), dir);
      if (!existsSync(session)) throw new Error(`session not found: ${session}`);
      const command = String(args.command ?? "");
      if (!command) throw new Error("command is required");
      const argArr = Array.isArray(args.args)
        ? (args.args as unknown[]).map(String)
        : [];
      const outName = String(args.out ?? session.replace(/\.jsonl$/, ".replay"));
      const replayPath = resolveSessionPath(outName, dir);
      const result = await runReplay({
        originalPath: session,
        replayPath,
        command,
        args: argArr,
      });
      return {
        replayPath: result.replayPath,
        replayedSeqs: result.replayedSeqs.length,
        warnings: result.warnings,
        summary: result.summary,
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function resolveSessionPath(name: string, dir: string): string {
  if (!name) return "";
  if (name.endsWith(".jsonl") || isAbsolute(name) || name.includes("/")) {
    return name;
  }
  return join(dir, name + ".jsonl");
}
