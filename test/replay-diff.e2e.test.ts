// End-to-end: record a session against the mock server, then:
//   1) replay against the SAME server → diff should be clean
//   2) replay against the BROKEN server → diff should catch exactly the
//      echo-prefix regression, nothing else

import { describe, expect, test, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { replay } from "../src/replay.ts";
import { diffSessions } from "../src/diff.ts";

const workdir = mkdtempSync(join(tmpdir(), "mcpr-replay-e2e-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

const cliPath = resolve(__dirname, "..", "src", "cli.ts");
const mockGood = resolve(__dirname, "fixtures", "mock-server.ts");
const mockBroken = resolve(__dirname, "fixtures", "mock-server-broken.ts");

async function recordBaseline(sessionName: string): Promise<string> {
  const proc = spawn(
    process.execPath,
    [
      cliPath,
      "record",
      "--session",
      sessionName,
      "--dir",
      workdir,
      "--",
      process.execPath,
      mockGood,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env },
  );

  const outLines: string[] = [];
  let buf = "";
  proc.stdout.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (l.trim()) outLines.push(l);
    }
  });

  const send = (o: any) => proc.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = async (n: number) => {
    const start = Date.now();
    while (outLines.length < n) {
      if (Date.now() - start > 3000) throw new Error("timeout in baseline");
      await Bun.sleep(10);
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
    params: { name: "echo", arguments: { message: "hello world" } },
  });
  await waitFor(3);

  proc.stdin.end();
  await new Promise((resolve) => proc.on("exit", resolve));
  return join(workdir, `${sessionName}.jsonl`);
}

describe("replay + diff: full round trip", () => {
  test("replay against same server produces clean diff", async () => {
    const baseline = await recordBaseline("baseline-clean");
    const replayPath = join(workdir, "baseline-clean.replay.jsonl");

    const r = await replay({
      originalPath: baseline,
      replayPath,
      command: process.execPath,
      args: [mockGood],
    });
    expect(r.replayedSeqs.length).toBe(3);

    const report = await diffSessions(baseline, replayPath);
    expect(report.counts.changed).toBe(0);
    expect(report.counts.onlyA).toBe(0);
    expect(report.counts.onlyB).toBe(0);
    expect(report.counts.equal).toBe(3);
  });

  test("replay against broken server catches exactly the regression", async () => {
    const baseline = await recordBaseline("baseline-dirty");
    const replayPath = join(workdir, "baseline-dirty.replay.jsonl");

    const r = await replay({
      originalPath: baseline,
      replayPath,
      command: process.execPath,
      args: [mockBroken],
    });
    expect(r.replayedSeqs.length).toBe(3);

    const report = await diffSessions(baseline, replayPath);
    // initialize and tools/list are identical; only tools/call differs.
    expect(report.counts.changed).toBe(1);
    expect(report.counts.equal).toBe(2);
    expect(report.counts.onlyA).toBe(0);
    expect(report.counts.onlyB).toBe(0);

    const changed = report.entries.find((e) => e.state === "~")!;
    expect(changed.method).toBe("tools/call");
    expect(changed.changes?.length).toBeGreaterThan(0);
    // The specific change should point at the echoed text.
    const textChange = changed.changes!.find((c) => c.path.includes("text"));
    expect(textChange).toBeDefined();
    expect(String(textChange!.a)).toContain("echo: hello world");
    expect(String(textChange!.b)).toContain("ECHOED: hello world");
  });
});
