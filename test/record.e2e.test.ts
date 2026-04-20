// End-to-end: spawn the CLI's `record` command with the mock MCP server as its
// child, drive a small protocol conversation by feeding JSON-RPC lines to the
// recorder's stdin, read back the server's responses from the recorder's
// stdout (proving transparent passthrough), then read the session file and
// assert every message was logged correctly on both directions.

import { describe, expect, test, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readSession } from "../src/session.ts";

const workdir = mkdtempSync(join(tmpdir(), "mcpr-e2e-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const cliPath = resolve(__dirname, "..", "src", "cli.ts");
const mockPath = resolve(__dirname, "fixtures", "mock-server.ts");

interface CapturedLine {
  t: number;
  text: string;
}

function spawnRecorder(sessionName: string) {
  return spawn(
    process.execPath, // bun
    [
      cliPath,
      "record",
      "--session",
      sessionName,
      "--dir",
      workdir,
      "--",
      process.execPath,
      mockPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env },
  );
}

describe("record: end-to-end through mock MCP server", () => {
  test("captures a full initialize + tools/list + tools/call conversation", async () => {
    const proc = spawnRecorder("e2e-happy");

    const outLines: CapturedLine[] = [];
    let outBuf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      outBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = outBuf.indexOf("\n")) !== -1) {
        const line = outBuf.slice(0, nl);
        outBuf = outBuf.slice(nl + 1);
        if (line.trim()) outLines.push({ t: Date.now(), text: line });
      }
    });

    const send = (obj: any) => proc.stdin.write(JSON.stringify(obj) + "\n");

    // Wait until we have N server responses back.
    const waitFor = async (n: number, timeoutMs = 3000) => {
      const start = Date.now();
      while (outLines.length < n) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `timeout waiting for ${n} responses (got ${outLines.length}): ${outLines.map((l) => l.text).join(" | ")}`,
          );
        }
        await Bun.sleep(15);
      }
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(2);
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hi" } },
    });
    await waitFor(3);
    // Notification (no id) — server should not respond.
    send({ jsonrpc: "2.0", method: "notifications/ping" });
    // Force unknown method to produce an error response.
    send({ jsonrpc: "2.0", id: 4, method: "nope/nope" });
    await waitFor(4);

    // EOF → triggers graceful child exit.
    proc.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("exit", (c) => resolve(c));
    });
    expect(exitCode).toBe(0);

    // Transparent passthrough: third response is the tools/call result.
    const echoResp = JSON.parse(outLines[2]!.text);
    expect(echoResp.result.content[0].text).toBe("echo: hi");

    // Session file assertions.
    const session = await readSession(join(workdir, "e2e-happy.jsonl"));
    expect(session.summary).not.toBeNull();
    expect(session.summary!.requests).toBe(4);
    expect(session.summary!.responses).toBe(4);
    expect(session.summary!.notifications).toBe(1);
    expect(session.summary!.errors).toBe(1); // the unknown-method error

    // c2s and s2c are both present and ordered by seq.
    const dirs = session.entries.map((e) => e.dir);
    expect(dirs).toContain("c2s");
    expect(dirs).toContain("s2c");
    expect(session.entries[0]!.seq).toBe(0);

    // Request 3 -> response 3 pair looks right.
    const respForEcho = session.entries.find(
      (e) => e.dir === "s2c" && (e.msg as any).id === 3,
    );
    expect((respForEcho?.msg as any).result.content[0].text).toBe("echo: hi");
  });
});
