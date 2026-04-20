// Semantic diff of two MCP sessions.
//
// Pairing strategy: walk c2s requests in order. For each request, look up the
// corresponding response in both sessions (by id). Compare the *normalized*
// response messages. Emit one DiffEntry per request, classified as:
//
//   "="  — normalized responses are deep-equal
//   "~"  — both exist but differ
//   "!a" — request exists only in session A (replay missed it)
//   "!b" — request exists only in session B (replay added something)
//
// Notifications and orphan messages are not paired (ids are absent or already
// handled). They're reported in a summary count.

import { readSession, type LogEntry } from "./session.ts";
import { normalize, type NormalizeOptions, DEFAULT_OPTIONS } from "./normalizers.ts";

export type DiffState = "=" | "~" | "!a" | "!b";

export interface DiffEntry {
  state: DiffState;
  method: string;
  paramsA?: unknown;
  paramsB?: unknown;
  /** JSON path diffs (dotted), present when state === "~". */
  changes?: Array<{ path: string; a: unknown; b: unknown }>;
}

export interface DiffReport {
  a: string;
  b: string;
  entries: DiffEntry[];
  counts: {
    equal: number;
    changed: number;
    onlyA: number;
    onlyB: number;
  };
}

export async function diffSessions(
  pathA: string,
  pathB: string,
  opts: NormalizeOptions = DEFAULT_OPTIONS,
): Promise<DiffReport> {
  const a = await readSession(pathA);
  const b = await readSession(pathB);
  return diffEntries(a.entries, b.entries, pathA, pathB, opts);
}

export function diffEntries(
  entriesA: LogEntry[],
  entriesB: LogEntry[],
  labelA: string,
  labelB: string,
  opts: NormalizeOptions = DEFAULT_OPTIONS,
): DiffReport {
  // Index requests by (method + stable params hash) in arrival order.
  // Using method+params rather than id lets us compare sessions even when
  // the replay server assigns different ids.
  const requestsA = collectRequests(entriesA);
  const requestsB = collectRequests(entriesB);

  const entries: DiffEntry[] = [];
  const counts = { equal: 0, changed: 0, onlyA: 0, onlyB: 0 };

  // Greedy match: for each request in A, find the first un-matched B request
  // with the same method. Within same-method, match in order of appearance.
  const matched = new Set<number>();

  for (const reqA of requestsA) {
    let partnerIdx = -1;
    for (let i = 0; i < requestsB.length; i++) {
      if (matched.has(i)) continue;
      if (requestsB[i]!.method === reqA.method) {
        partnerIdx = i;
        break;
      }
    }

    if (partnerIdx === -1) {
      entries.push({
        state: "!a",
        method: reqA.method,
        paramsA: reqA.params,
      });
      counts.onlyA++;
      continue;
    }
    matched.add(partnerIdx);
    const reqB = requestsB[partnerIdx]!;

    const normA = reqA.response ? normalize(reqA.response, opts) : undefined;
    const normB = reqB.response ? normalize(reqB.response, opts) : undefined;

    if (deepEqual(normA, normB)) {
      entries.push({
        state: "=",
        method: reqA.method,
        paramsA: reqA.params,
        paramsB: reqB.params,
      });
      counts.equal++;
    } else {
      entries.push({
        state: "~",
        method: reqA.method,
        paramsA: reqA.params,
        paramsB: reqB.params,
        changes: collectChanges(normA, normB),
      });
      counts.changed++;
    }
  }

  // Any requests in B with no partner.
  for (let i = 0; i < requestsB.length; i++) {
    if (matched.has(i)) continue;
    entries.push({
      state: "!b",
      method: requestsB[i]!.method,
      paramsB: requestsB[i]!.params,
    });
    counts.onlyB++;
  }

  return { a: labelA, b: labelB, entries, counts };
}

interface CollectedRequest {
  method: string;
  params: unknown;
  response: unknown; // the s2c result or error object (the full message)
}

function collectRequests(entries: LogEntry[]): CollectedRequest[] {
  const out: CollectedRequest[] = [];
  // Map request id → method+params so we can pair when we see the response.
  const pending = new Map<string | number, { method: string; params: unknown }>();

  for (const e of entries) {
    const m = e.msg as any;
    if (!m || typeof m !== "object") continue;
    if (e.dir === "c2s" && m.method && "id" in m) {
      pending.set(m.id, { method: m.method, params: m.params });
    } else if (e.dir === "s2c" && "id" in m && ("result" in m || "error" in m)) {
      const req = pending.get(m.id);
      if (req) {
        pending.delete(m.id);
        out.push({ ...req, response: m });
      }
    }
  }
  // Any pending requests with no response: record them anyway with undefined response.
  for (const req of pending.values()) {
    out.push({ ...req, response: undefined });
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual((a as any)[k], (b as any)[k])) return false;
  }
  return true;
}

function collectChanges(
  a: unknown,
  b: unknown,
  path = "",
): Array<{ path: string; a: unknown; b: unknown }> {
  const out: Array<{ path: string; a: unknown; b: unknown }> = [];
  if (deepEqual(a, b)) return out;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    out.push({ path: path || "(root)", a, b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      out.push(...collectChanges(a[i], b[i], `${path}[${i}]`));
    }
    return out;
  }
  const keys = new Set([
    ...Object.keys(a as object),
    ...Object.keys(b as object),
  ]);
  for (const k of keys) {
    const va = (a as any)[k];
    const vb = (b as any)[k];
    const childPath = path ? `${path}.${k}` : k;
    if (!deepEqual(va, vb)) out.push(...collectChanges(va, vb, childPath));
  }
  return out;
}

// --------------------------------------------------------------------------

export function formatDiff(report: DiffReport, useColor = true): string {
  const c = (code: string, text: string) =>
    useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = (t: string) => c("2", t);
  const green = (t: string) => c("32", t);
  const yellow = (t: string) => c("33", t);
  const red = (t: string) => c("31", t);
  const bold = (t: string) => c("1", t);

  const lines: string[] = [];
  lines.push(bold(`diff  A: ${report.a}  ↔  B: ${report.b}`));
  lines.push(
    dim(
      `equal: ${report.counts.equal}    changed: ${report.counts.changed}    ` +
        `only-A: ${report.counts.onlyA}    only-B: ${report.counts.onlyB}`,
    ),
  );
  lines.push("");

  if (
    report.counts.changed === 0 &&
    report.counts.onlyA === 0 &&
    report.counts.onlyB === 0
  ) {
    lines.push(green("✓ sessions are semantically equivalent"));
    return lines.join("\n");
  }

  for (const e of report.entries) {
    const paramsStr = e.paramsA
      ? truncate(JSON.stringify(e.paramsA), 80)
      : e.paramsB
      ? truncate(JSON.stringify(e.paramsB), 80)
      : "";
    if (e.state === "=") {
      lines.push(`  ${green("=")} ${e.method}  ${dim(paramsStr)}`);
    } else if (e.state === "~") {
      lines.push(`  ${yellow("~")} ${bold(e.method)}  ${dim(paramsStr)}`);
      for (const ch of e.changes ?? []) {
        lines.push(
          `      ${dim(ch.path)}:  ${truncate(JSON.stringify(ch.a), 60)}  ${yellow("→")}  ${truncate(JSON.stringify(ch.b), 60)}`,
        );
      }
    } else if (e.state === "!a") {
      lines.push(`  ${red("!")} ${e.method}  ${dim(paramsStr)}  ${dim("(only in A)")}`);
    } else if (e.state === "!b") {
      lines.push(`  ${red("!")} ${e.method}  ${dim(paramsStr)}  ${dim("(only in B)")}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
