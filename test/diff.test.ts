import { describe, expect, test } from "bun:test";
import { diffEntries } from "../src/diff.ts";
import type { LogEntry } from "../src/session.ts";

function req(seq: number, id: number, method: string, params: any): LogEntry {
  return {
    seq,
    t: 0,
    dir: "c2s",
    msg: { jsonrpc: "2.0", id, method, params },
  };
}
function resp(seq: number, id: number, result: any): LogEntry {
  return {
    seq,
    t: 0,
    dir: "s2c",
    msg: { jsonrpc: "2.0", id, result },
  };
}
function errResp(seq: number, id: number, code: number, message: string): LogEntry {
  return {
    seq,
    t: 0,
    dir: "s2c",
    msg: { jsonrpc: "2.0", id, error: { code, message } },
  };
}

describe("diffEntries", () => {
  test("identical sessions produce all equal entries", () => {
    const a: LogEntry[] = [
      req(0, 1, "tools/list", null),
      resp(1, 1, { tools: [{ name: "echo" }] }),
    ];
    const b: LogEntry[] = [
      req(0, 7, "tools/list", null), // different id — should still equal after normalization
      resp(1, 7, { tools: [{ name: "echo" }] }),
    ];
    const r = diffEntries(a, b, "a", "b");
    expect(r.counts.equal).toBe(1);
    expect(r.counts.changed).toBe(0);
    expect(r.counts.onlyA).toBe(0);
    expect(r.counts.onlyB).toBe(0);
  });

  test("catches a real change in the tool-call result", () => {
    const a: LogEntry[] = [
      req(0, 1, "tools/call", { name: "echo", arguments: { message: "hi" } }),
      resp(1, 1, { content: [{ type: "text", text: "echo: hi" }] }),
    ];
    const b: LogEntry[] = [
      req(0, 1, "tools/call", { name: "echo", arguments: { message: "hi" } }),
      resp(1, 1, { content: [{ type: "text", text: "ECHO: hi" }] }), // changed
    ];
    const r = diffEntries(a, b, "a", "b");
    expect(r.counts.changed).toBe(1);
    const change = r.entries[0]!;
    expect(change.state).toBe("~");
    expect(change.changes?.length).toBeGreaterThan(0);
    expect(change.changes?.[0]?.path).toContain("content");
  });

  test("catches an error that wasn't there before", () => {
    const a: LogEntry[] = [
      req(0, 1, "tools/call", { name: "echo" }),
      resp(1, 1, { content: [{ type: "text", text: "ok" }] }),
    ];
    const b: LogEntry[] = [
      req(0, 1, "tools/call", { name: "echo" }),
      errResp(1, 1, -32603, "broken"),
    ];
    const r = diffEntries(a, b, "a", "b");
    expect(r.counts.changed).toBe(1);
    expect(r.entries[0]!.state).toBe("~");
  });

  test("reports !a when a request is missing from B", () => {
    const a: LogEntry[] = [
      req(0, 1, "tools/list", null),
      resp(1, 1, { tools: [] }),
      req(2, 2, "tools/call", { name: "echo" }),
      resp(3, 2, { content: [] }),
    ];
    const b: LogEntry[] = [
      req(0, 1, "tools/list", null),
      resp(1, 1, { tools: [] }),
    ];
    const r = diffEntries(a, b, "a", "b");
    expect(r.counts.equal).toBe(1);
    expect(r.counts.onlyA).toBe(1);
    const only = r.entries.find((e) => e.state === "!a")!;
    expect(only.method).toBe("tools/call");
  });

  test("timestamps are normalized before compare", () => {
    const a: LogEntry[] = [
      req(0, 1, "tools/call", { name: "log" }),
      resp(1, 1, { content: [{ type: "text", text: "at 2026-04-19T10:23:44Z" }] }),
    ];
    const b: LogEntry[] = [
      req(0, 1, "tools/call", { name: "log" }),
      resp(1, 1, { content: [{ type: "text", text: "at 2026-04-20T14:01:05Z" }] }),
    ];
    const r = diffEntries(a, b, "a", "b");
    expect(r.counts.equal).toBe(1); // different timestamps should normalize to <TIME>
  });
});
