// `mcp-recorder record` — spawn the target MCP server as a child, wire up four
// pipes so bytes flow transparently between the real client (us, via stdio
// inherited from the parent that launched us) and the server, and log every
// message on both directions to a JSONL session file.
//
// Transparency contract:
//   - Bytes between client and server are forwarded VERBATIM.
//   - If this recorder dies, the server dies with it (the client sees the pipe
//     close — exact same failure mode as calling the server directly).
//   - If the server's stderr emits anything, we proxy it to our stderr so the
//     client/user can see it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LineFramer } from "./framing.ts";
import {
  SessionWriter,
  defaultSessionDir,
  timestampSessionName,
  type SessionSummary,
} from "./session.ts";
import { join } from "node:path";

export interface RecordOptions {
  /** Logical session name, used for the JSONL filename. */
  session?: string;
  /** Directory to write session files into. Defaults to ~/.mcp-recorder/sessions. */
  dir?: string;
  /** The child process to spawn (the real MCP server). */
  command: string;
  args: string[];
  /** Write logs here too (for tests); if absent, stderr only on errors. */
  logger?: (line: string) => void;
}

export interface RecordResult {
  sessionPath: string;
  summary: SessionSummary;
  exitCode: number | null;
}

export async function record(opts: RecordOptions): Promise<RecordResult> {
  const dir = opts.dir ?? defaultSessionDir();
  const name = opts.session ?? timestampSessionName();
  const sessionPath = join(dir, `${name}.jsonl`);
  const writer = new SessionWriter(sessionPath, {
    server: { command: opts.command, args: opts.args },
  });

  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const c2sFramer = new LineFramer();
  const s2cFramer = new LineFramer();

  // Client -> Server: read our stdin, log, forward.
  process.stdin.on("data", (chunk: Buffer) => {
    // Forward first to minimize added latency.
    if (!child.stdin.destroyed) child.stdin.write(chunk);
    const frames = c2sFramer.push(chunk);
    for (const f of frames) writer.record("c2s", f);
  });
  process.stdin.on("end", () => {
    const tail = c2sFramer.flush();
    if (tail) writer.record("c2s", tail);
    child.stdin.end();
  });

  // Server -> Client: read child stdout, log, forward.
  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    const frames = s2cFramer.push(chunk);
    for (const f of frames) writer.record("s2c", f);
  });
  child.stdout.on("end", () => {
    const tail = s2cFramer.flush();
    if (tail) writer.record("s2c", tail);
  });

  // Server stderr: pass through to our stderr verbatim; we do not interpret it.
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  // If parent gets SIGTERM/SIGINT, forward to child so it can clean up.
  const forwardSignal = (sig: NodeJS.Signals) => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  const summary = await writer.close();

  return { sessionPath, summary, exitCode };
}
