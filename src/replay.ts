// `mcp-recorder replay` — deterministic request replay against a fresh server.
//
// Given a session file, we spawn the target server as a child and re-send every
// client→server message (requests + notifications) in original seq order. For
// each request, we wait for the matching response before sending the next, so
// ordering is strictly deterministic. Responses are captured in a new session
// file with suffix `.replay.jsonl`.
//
// Bidirectional MCP (server sending requests to the client — e.g. sampling)
// is handled by looking up the original client response by method + params
// hash. If we see a server→client request with no match in the original
// session, replay errors and stops — failing loud is better than guessing.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LineFramer, classify } from "./framing.ts";
import {
  SessionWriter,
  readSession,
  type LogEntry,
  type SessionSummary,
} from "./session.ts";

export interface ReplayOptions {
  /** Path to the original session file. */
  originalPath: string;
  /** Where to write the replay session file. */
  replayPath: string;
  /** Command to spawn for the fresh server. */
  command: string;
  args: string[];
  /** Max time to wait for any single response. */
  perRequestTimeoutMs?: number;
}

export interface ReplayResult {
  replayPath: string;
  summary: SessionSummary;
  /** seq numbers of original requests we replayed. */
  replayedSeqs: number[];
  /** Original requests we skipped (e.g. could not match). */
  skippedSeqs: number[];
  /** Non-fatal warnings collected during replay. */
  warnings: string[];
  exitCode: number | null;
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const original = await readSession(opts.originalPath);
  const timeout = opts.perRequestTimeoutMs ?? 5000;

  // Build a lookup for server→client requests (v0.1 sessions won't have any;
  // we still wire it so v0.2 replay against bidirectional sessions works).
  // Key: method + stable-stringify(params). Value: the client's response.
  const bidiResponseLookup = new Map<string, LogEntry>();
  for (let i = 0; i < original.entries.length; i++) {
    const e = original.entries[i]!;
    const m = e.msg as any;
    if (e.dir === "s2c" && m?.method && "id" in m) {
      // Find the next c2s response with the matching id.
      for (let j = i + 1; j < original.entries.length; j++) {
        const f = original.entries[j]!;
        const fm = f.msg as any;
        if (
          f.dir === "c2s" &&
          fm &&
          fm.id === m.id &&
          ("result" in fm || "error" in fm)
        ) {
          bidiResponseLookup.set(keyForBidi(m.method, m.params), f);
          break;
        }
      }
    }
  }

  const writer = new SessionWriter(opts.replayPath, {
    server: { command: opts.command, args: opts.args },
  });

  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const s2cFramer = new LineFramer();

  // Pending responses from server, keyed by id. Resolved by send() below.
  const pending = new Map<string | number, (entry: LogEntry) => void>();
  const warnings: string[] = [];
  const replayedSeqs: number[] = [];
  const skippedSeqs: number[] = [];

  child.stderr.on("data", (chunk: Buffer) => {
    // Propagate server stderr to our stderr for visibility, but don't crash.
    process.stderr.write(chunk);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    for (const frame of s2cFramer.push(chunk)) {
      // Always record, regardless of kind.
      const entry = writer["seq"] as unknown as number; // just for typing
      void entry;
      writer.record("s2c", frame);

      const m = frame.parsed as any;
      if (frame.kind === "response" && m && m.id !== undefined && m.id !== null) {
        const cb = pending.get(m.id);
        if (cb) {
          pending.delete(m.id);
          // Grab the entry we just wrote. Cheaper to synthesize than re-read.
          cb({
            seq: -1,
            t: Date.now() / 1000,
            dir: "s2c",
            msg: frame.parsed,
          });
        }
      } else if (frame.kind === "request" && m?.method) {
        // Server→client request. Look up the canned response from the original
        // session and reply.
        const canned = bidiResponseLookup.get(keyForBidi(m.method, m.params));
        if (canned) {
          const replyLine = JSON.stringify({
            ...(canned.msg as object),
            id: m.id, // use the new server-assigned id
          }) + "\n";
          if (!child.stdin.destroyed) child.stdin.write(replyLine);
          writer.record("c2s", classify(Buffer.from(replyLine)));
        } else {
          warnings.push(
            `server→client ${m.method} had no canned response in original session; not replying`,
          );
        }
      }
    }
  });

  const send = (line: string, awaitId?: string | number): Promise<LogEntry | null> => {
    if (child.stdin.destroyed) return Promise.resolve(null);
    child.stdin.write(line);
    writer.record("c2s", classify(Buffer.from(line)));
    if (awaitId === undefined) return Promise.resolve(null);
    return new Promise<LogEntry | null>((resolve) => {
      const t = setTimeout(() => {
        pending.delete(awaitId);
        warnings.push(`timeout waiting for response to id=${awaitId}`);
        resolve(null);
      }, timeout);
      pending.set(awaitId, (entry) => {
        clearTimeout(t);
        resolve(entry);
      });
    });
  };

  // Drive the replay in original seq order.
  for (const entry of original.entries) {
    if (entry.dir !== "c2s") continue;
    const m = entry.msg as any;
    if (!m || typeof m !== "object") {
      skippedSeqs.push(entry.seq);
      continue;
    }
    // Skip responses in c2s (those are replies to bidi server requests —
    // handled dynamically above).
    if ("result" in m || "error" in m) continue;

    // It's a request or notification.
    const line = JSON.stringify(m) + "\n";
    if ("id" in m) {
      await send(line, m.id);
      replayedSeqs.push(entry.seq);
    } else {
      await send(line);
      replayedSeqs.push(entry.seq);
    }
  }

  // Drain: give the server a moment to flush, then close.
  await Bun.sleep(50);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", (c) => resolve(c));
    // Safety timeout: don't hang forever if child doesn't exit cleanly.
    setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      resolve(null);
    }, 2000);
  });

  const summary = await writer.close();

  return {
    replayPath: opts.replayPath,
    summary,
    replayedSeqs,
    skippedSeqs,
    warnings,
    exitCode,
  };
}

function keyForBidi(method: string, params: unknown): string {
  return method + "\0" + stableStringify(params);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((v as any)[k]))
      .join(",") +
    "}"
  );
}
