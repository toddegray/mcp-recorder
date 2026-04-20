// `mcp-recorder show` and `list`: pretty-printers for session files.
//
// Formatting is tuned for eyeballing a live session: requests and responses are
// paired by id so the `200ms` latency is visible at a glance; long payloads are
// truncated in the default view; `--json` emits the raw entries for piping.

import { readSession, listSessions, type LogEntry } from "./session.ts";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";

export interface ShowOptions {
  filter?: string; // method filter, e.g. "tools/call"
  slowerThanMs?: number;
  json?: boolean;
  noColor?: boolean;
  maxPayloadChars?: number; // default 120
}

export async function showSession(
  path: string,
  opts: ShowOptions = {},
): Promise<string> {
  const session = await readSession(path);
  if (opts.json) {
    return session.entries.map((e) => JSON.stringify(e)).join("\n");
  }

  const use = (code: string, text: string) =>
    opts.noColor ? text : `${code}${text}${RESET}`;

  const lines: string[] = [];
  const header =
    (opts.noColor ? "" : BOLD) +
    `session ${session.path}` +
    (opts.noColor ? "" : RESET);
  lines.push(header);
  if (session.summary) {
    const s = session.summary;
    lines.push(
      use(
        DIM,
        `server: ${s.server.command} ${s.server.args.join(" ")}    ` +
          `duration: ${s.durationSec}s    ` +
          `requests: ${s.requests}    ` +
          `responses: ${s.responses}    ` +
          `notifications: ${s.notifications}    ` +
          `errors: ${s.errors}`,
      ),
    );
  }
  lines.push("");

  // Build response map for latency pairing.
  const responsesById = new Map<string | number, LogEntry>();
  for (const e of session.entries) {
    const msg = e.msg as any;
    if (e.dir === "s2c" && msg && typeof msg === "object" && "id" in msg && ("result" in msg || "error" in msg)) {
      responsesById.set(msg.id, e);
    }
  }

  const maxLen = opts.maxPayloadChars ?? 120;

  for (const e of session.entries) {
    const m = e.msg as any;
    if (!m || typeof m !== "object") continue;

    if (e.dir === "c2s" && typeof m.method === "string") {
      const isRequest = "id" in m;
      if (opts.filter && m.method !== opts.filter) continue;

      // Pair with response for latency.
      let latencyMs: number | null = null;
      let isError = false;
      if (isRequest) {
        const resp = responsesById.get(m.id);
        if (resp) {
          latencyMs = Math.round((resp.t - e.t) * 1000);
          isError = !!(resp.msg as any)?.error;
        }
      }
      if (
        opts.slowerThanMs !== undefined &&
        (latencyMs === null || latencyMs < opts.slowerThanMs)
      ) {
        continue;
      }

      const kind = isRequest ? "→" : "⇢"; // request vs notification
      const kindColor = isRequest ? BLUE : MAGENTA;
      const methodText = use(kindColor, `${kind} ${m.method}`);
      const paramsText = truncate(
        m.params ? JSON.stringify(m.params) : "",
        maxLen,
      );
      const latencyText =
        latencyMs !== null
          ? " " + use(isError ? RED : latencyMs > 500 ? YELLOW : GREEN, `${latencyMs}ms`)
          : "";
      const errorMark = isError ? " " + use(RED, "✗") : "";

      lines.push(
        `  ${methodText}  ${use(DIM, paramsText)}${latencyText}${errorMark}`,
      );
    }
  }

  return lines.join("\n");
}

export async function formatList(dir: string): Promise<string> {
  const sessions = listSessions(dir);
  if (sessions.length === 0) {
    return `no sessions in ${dir}`;
  }
  const lines: string[] = [];
  lines.push(`${BOLD}${sessions.length} session(s) in ${dir}${RESET}`);
  lines.push("");
  lines.push(`${"NAME".padEnd(30)}  ${"SIZE".padStart(8)}  WHEN`);
  for (const s of sessions) {
    lines.push(
      `${s.name.padEnd(30)}  ${humanSize(s.size).padStart(8)}  ${s.mtime.toLocaleString()}`,
    );
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Avoid unused-import warnings for CYAN (reserved for future).
void CYAN;
