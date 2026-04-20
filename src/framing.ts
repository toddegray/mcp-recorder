// JSON-RPC 2.0 framing for MCP stdio transport.
//
// MCP's stdio transport uses newline-delimited JSON: one complete JSON object
// (or array, for batched requests) per line. We read bytes from a stream,
// buffer until we see '\n', attempt to parse, and emit one FrameEvent per line.
//
// Invariants:
//   - Bytes are forwarded verbatim to the peer. Framing is purely observational.
//   - If a line is not valid JSON, we still emit a Frame (with kind="malformed")
//     and still forward the bytes. Never break the pipe.
//   - Notifications, requests, and responses are all classified from a single
//     parsed message object per JSON-RPC 2.0 §4.

export type MessageKind =
  | "request"
  | "response"
  | "notification"
  | "batch"
  | "malformed";

export interface Frame {
  /** Raw bytes (including trailing \n) as seen on the wire. Forward this. */
  raw: Buffer;
  /** Parsed JSON, if parseable. For "batch" kind this is the array. */
  parsed: unknown;
  kind: MessageKind;
  /** For single messages: the JSON-RPC method, if this is a request/notification. */
  method?: string;
  /** For single messages: the JSON-RPC id, if present. */
  id?: string | number | null;
  /** True if this message has "error" set (response error). */
  isError?: boolean;
}

/**
 * Stateful line-framer. Feed bytes in with `push()`, pull complete Frames out.
 * Handles partial reads: bytes that don't end on a \n boundary are retained
 * until the next push().
 */
export class LineFramer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];

    while (true) {
      const nl = this.buf.indexOf(0x0a); // '\n'
      if (nl === -1) break;
      const line = this.buf.subarray(0, nl + 1); // include the newline
      this.buf = this.buf.subarray(nl + 1);
      // MCP permits blank lines between messages? Not per spec, but tolerate.
      if (line.length === 1) continue;
      out.push(classify(line));
    }
    return out;
  }

  /** Any un-terminated bytes still in the buffer (e.g. on stream end). */
  flush(): Frame | null {
    if (this.buf.length === 0) return null;
    const leftover = this.buf;
    this.buf = Buffer.alloc(0);
    return classify(leftover);
  }
}

export function classify(raw: Buffer): Frame {
  const text = raw.toString("utf8").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw, parsed: null, kind: "malformed" };
  }

  if (Array.isArray(parsed)) {
    return { raw, parsed, kind: "batch" };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { raw, parsed, kind: "malformed" };
  }

  const obj = parsed as Record<string, unknown>;
  // JSON-RPC 2.0 classification:
  //   request:      has method + id
  //   notification: has method, no id
  //   response:     has id + (result XOR error), no method
  if (typeof obj.method === "string") {
    if ("id" in obj) {
      return {
        raw,
        parsed,
        kind: "request",
        method: obj.method,
        id: obj.id as string | number | null,
      };
    }
    return { raw, parsed, kind: "notification", method: obj.method };
  }
  if ("id" in obj && ("result" in obj || "error" in obj)) {
    return {
      raw,
      parsed,
      kind: "response",
      id: obj.id as string | number | null,
      isError: "error" in obj,
    };
  }
  return { raw, parsed, kind: "malformed" };
}
