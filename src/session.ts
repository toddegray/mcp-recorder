// Session file: one JSONL per session, one line per observed message.
// Schema kept tight and human-readable.

import {
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import type { Frame } from "./framing.ts";

export type Direction = "c2s" | "s2c";

export interface LogEntry {
  seq: number;
  /** Unix seconds, float with μs precision. */
  t: number;
  dir: Direction;
  /** The parsed JSON-RPC message. For malformed frames, the raw string. */
  msg: unknown;
  /** Only present for malformed frames. */
  malformed?: true;
}

export interface SessionSummary {
  type: "summary";
  startedAt: number;
  endedAt: number;
  durationSec: number;
  requests: number;
  responses: number;
  notifications: number;
  batches: number;
  malformed: number;
  errors: number; // response messages with an "error" field
  server: { command: string; args: string[] };
}

export interface ReadSession {
  path: string;
  entries: LogEntry[];
  summary: SessionSummary | null;
}

export class SessionWriter {
  private stream: WriteStream;
  private seq = 0;
  readonly startedAt: number;
  private counts = {
    requests: 0,
    responses: 0,
    notifications: 0,
    batches: 0,
    malformed: 0,
    errors: 0,
  };

  constructor(
    readonly path: string,
    readonly meta: { server: { command: string; args: string[] } },
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "w" });
    this.startedAt = nowSec();
  }

  record(dir: Direction, frame: Frame): void {
    const entry: LogEntry = {
      seq: this.seq++,
      t: nowSec(),
      dir,
      msg: frame.kind === "malformed" ? frame.raw.toString("utf8") : frame.parsed,
    };
    if (frame.kind === "malformed") {
      entry.malformed = true;
      this.counts.malformed++;
    } else if (frame.kind === "request") {
      this.counts.requests++;
    } else if (frame.kind === "response") {
      this.counts.responses++;
      if (frame.isError) this.counts.errors++;
    } else if (frame.kind === "notification") {
      this.counts.notifications++;
    } else if (frame.kind === "batch") {
      this.counts.batches++;
    }
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  close(): Promise<SessionSummary> {
    const endedAt = nowSec();
    const summary: SessionSummary = {
      type: "summary",
      startedAt: this.startedAt,
      endedAt,
      durationSec: round3(endedAt - this.startedAt),
      ...this.counts,
      server: this.meta.server,
    };
    return new Promise((resolve) => {
      this.stream.end(JSON.stringify(summary) + "\n", () => resolve(summary));
    });
  }
}

export async function readSession(path: string): Promise<ReadSession> {
  if (!existsSync(path)) {
    throw new Error(`session file not found: ${path}`);
  }
  const entries: LogEntry[] = [];
  let summary: SessionSummary | null = null;

  const text = await Bun.file(path).text();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && (obj as any).type === "summary") {
      summary = obj as SessionSummary;
    } else if (obj && typeof obj === "object" && "seq" in (obj as any)) {
      entries.push(obj as LogEntry);
    }
  }
  return { path, entries, summary };
}

export function listSessions(dir: string): Array<{
  path: string;
  name: string;
  size: number;
  mtime: Date;
}> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = join(dir, f);
      const st = statSync(full);
      return {
        path: full,
        name: basename(f, ".jsonl"),
        size: st.size,
        mtime: st.mtime,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function defaultSessionDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".mcp-recorder", "sessions");
}

export function timestampSessionName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function nowSec(): number {
  return round3(Date.now() / 1000);
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
// Avoid dead-code warnings — we export classify-only functions from framing.ts
// but createReadStream is imported for future streamed reads.
void createReadStream;
