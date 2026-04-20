import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWriter, readSession, listSessions } from "../src/session.ts";
import { classify } from "../src/framing.ts";

const dir = mkdtempSync(join(tmpdir(), "mcpr-session-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionWriter + readSession", () => {
  test("round-trips a small session", async () => {
    const path = join(dir, "roundtrip.jsonl");
    const w = new SessionWriter(path, {
      server: { command: "mock", args: ["--flag"] },
    });
    w.record(
      "c2s",
      classify(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n')),
    );
    w.record(
      "s2c",
      classify(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n')),
    );
    w.record(
      "c2s",
      classify(Buffer.from('{"jsonrpc":"2.0","method":"notifications/ping"}\n')),
    );
    const summary = await w.close();

    expect(summary.requests).toBe(1);
    expect(summary.responses).toBe(1);
    expect(summary.notifications).toBe(1);
    expect(summary.errors).toBe(0);

    const session = await readSession(path);
    expect(session.entries.length).toBe(3);
    expect(session.summary?.server.command).toBe("mock");
    expect((session.entries[0]!.msg as any).method).toBe("tools/list");
    expect(session.entries[0]!.seq).toBe(0);
    expect(session.entries[1]!.seq).toBe(1);
  });

  test("counts errors correctly", async () => {
    const path = join(dir, "errors.jsonl");
    const w = new SessionWriter(path, { server: { command: "m", args: [] } });
    w.record(
      "s2c",
      classify(
        Buffer.from('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"x"}}\n'),
      ),
    );
    const s = await w.close();
    expect(s.errors).toBe(1);
    expect(s.responses).toBe(1);
  });

  test("preserves malformed lines as strings with malformed:true", async () => {
    const path = join(dir, "malformed.jsonl");
    const w = new SessionWriter(path, { server: { command: "m", args: [] } });
    w.record("c2s", classify(Buffer.from("this is not json\n")));
    await w.close();

    const session = await readSession(path);
    expect(session.entries[0]!.malformed).toBe(true);
    expect(typeof session.entries[0]!.msg).toBe("string");
  });
});

describe("listSessions", () => {
  test("finds *.jsonl files sorted newest-first", () => {
    const sessions = listSessions(dir);
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(s.path.endsWith(".jsonl")).toBe(true);
  });
});
