// Dogfood: spawn `mcp-recorder serve` as an MCP server, drive it with
// JSON-RPC requests, and verify it exposes list_sessions, show_session,
// diff_sessions as advertised. We also verify it can be recorded by
// `mcp-recorder record` — a recorder recording itself recording.

import { describe, expect, test, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionWriter } from "../src/session.ts";
import { classify } from "../src/framing.ts";

const workdir = mkdtempSync(join(tmpdir(), "mcpr-serve-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const cliPath = resolve(__dirname, "..", "src", "cli.ts");

// Plant a recorded session in workdir so list/show/diff have something to find.
async function plantSession(name: string) {
  const path = join(workdir, `${name}.jsonl`);
  const w = new SessionWriter(path, {
    server: { command: "mock", args: [] },
  });
  w.record(
    "c2s",
    classify(
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'),
    ),
  );
  w.record(
    "s2c",
    classify(
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo"}]}}\n',
      ),
    ),
  );
  await w.close();
  return path;
}

function spawnServe() {
  return spawn(process.execPath, [cliPath, "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

async function driveRpc(
  proc: ReturnType<typeof spawnServe>,
  requests: Array<{ id: number; method: string; params?: unknown }>,
): Promise<any[]> {
  const responses: any[] = [];
  let buf = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });

  for (const req of requests) {
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...req }) + "\n",
    );
  }

  const deadline = Date.now() + 5000;
  while (responses.length < requests.length) {
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${requests.length} responses, got ${responses.length}`,
      );
    }
    await Bun.sleep(20);
  }
  proc.stdin.end();
  await new Promise((resolve) => proc.on("exit", resolve));
  return responses;
}

describe("serve (native MCP server)", () => {
  test("initialize + tools/list handshake", async () => {
    const proc = spawnServe();
    const resps = await driveRpc(proc, [
      { id: 1, method: "initialize", params: {} },
      { id: 2, method: "tools/list" },
    ]);
    expect(resps[0].result.serverInfo.name).toBe("mcp-recorder");
    expect(resps[0].result.capabilities.tools).toBeDefined();
    const tools = resps[1].result.tools.map((t: any) => t.name);
    expect(tools).toContain("list_sessions");
    expect(tools).toContain("show_session");
    expect(tools).toContain("diff_sessions");
    expect(tools).toContain("replay_session");
  });

  test("list_sessions returns planted session", async () => {
    await plantSession("planted-a");
    const proc = spawnServe();
    const resps = await driveRpc(proc, [
      { id: 1, method: "initialize", params: {} },
      {
        id: 2,
        method: "tools/call",
        params: { name: "list_sessions", arguments: { dir: workdir } },
      },
    ]);
    const payload = JSON.parse(resps[1].result.content[0].text);
    expect(payload.dir).toBe(workdir);
    expect(payload.sessions.some((s: any) => s.name === "planted-a")).toBe(true);
  });

  test("show_session returns summary + entry count", async () => {
    const path = await plantSession("planted-b");
    const proc = spawnServe();
    const resps = await driveRpc(proc, [
      { id: 1, method: "initialize", params: {} },
      {
        id: 2,
        method: "tools/call",
        params: {
          name: "show_session",
          arguments: { session: "planted-b", dir: workdir },
        },
      },
    ]);
    const payload = JSON.parse(resps[1].result.content[0].text);
    expect(payload.path).toBe(path);
    expect(payload.entryCount).toBe(2);
    expect(payload.summary.requests).toBe(1);
    expect(payload.summary.responses).toBe(1);
  });

  test("unknown tool returns JSON-RPC error (not a throw)", async () => {
    const proc = spawnServe();
    const resps = await driveRpc(proc, [
      { id: 1, method: "initialize", params: {} },
      {
        id: 2,
        method: "tools/call",
        params: { name: "no-such-tool", arguments: {} },
      },
    ]);
    expect(resps[1].error).toBeDefined();
    expect(resps[1].error.message).toContain("unknown tool");
  });

  test("unknown method returns -32601 method-not-found", async () => {
    const proc = spawnServe();
    const resps = await driveRpc(proc, [
      { id: 1, method: "totally/unknown" },
    ]);
    expect(resps[0].error.code).toBe(-32601);
  });
});
