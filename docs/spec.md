# mcp-recorder — design spec

## 1. Problem

MCP servers expose tools to agents over stdio using JSON-RPC 2.0. When you modify a server (rename a tool, change an output schema, tighten an argument validator), nothing tells you whether an existing agent still works. The feedback loop is:

1. Change server code
2. Restart Claude Code / Cursor
3. Manually retry whatever prompts used to work
4. Notice something feels different
5. Dig through scrollback

That's not a debug loop. It's vibes. `mcp-recorder` replaces it with **record once, replay forever, diff automatically.**

## 2. Non-goals

- Not a protocol validator (there are linters for that).
- Not a full MCP client — we pipe bytes, we don't interpret semantics beyond JSON-RPC framing.
- Not an HTTP MCP proxy. Stdio transport only for v0.1. HTTP/SSE transport added only if the plumbing is clean.
- Not cloud-hosted. Local file output only.

## 3. User stories

**Record.** "I want to capture everything Claude Code says to my MCP server during one 10-minute session, so I can hand the recording to a teammate or re-run it tomorrow."

**Replay.** "I just refactored my server. Before I ship, I want to re-run yesterday's session and confirm every tool call still returns something equivalent."

**Diff.** "Three tool calls returned differently after my refactor — tell me exactly which and how."

**Inspect.** "Show me every `tools/call` that took > 500ms."

## 4. JSON-RPC framing

MCP stdio uses **newline-delimited JSON** (one JSON object per line, per spec §3.1). Parsing rule: read until `\n`, parse as JSON, emit. Simple, but edge cases matter:

- **Partial reads.** Buffer until a newline is seen; never assume one `read()` = one message.
- **Invalid JSON.** Forward the bytes untouched to the peer and log a malformed entry to the session file. Never break the pipe.
- **Notifications** have no `id`; requests have an `id` and a `method`; responses have an `id` and either `result` or `error`. Infer and tag.
- **Batched requests** (JSON array): log as one message with its array intact; don't split.

## 5. Semantic diff (v0.2)

`diff` is the hard part. Raw JSON diff on tool-call outputs produces noise — timestamps, UUIDs, file mtimes, non-deterministic ordering. The diff engine applies these normalizations before comparing:

| Rule | Example |
|------|---------|
| Strip request/response `id` fields | `id:42` ≡ `id:43` |
| Normalize ISO timestamps within messages to `<TIME>` | `"2026-04-19T10:23:44Z"` → `<TIME>` |
| Normalize UUIDs | `"550e8400-..."` → `<UUID>` |
| Normalize absolute paths under a prefix (configurable) | `/tmp/abc123/file` → `<TMP>/file` |
| Sort arrays declared order-independent via a config file | `tools` by `name`, `content` kept in order |
| Tolerance for numeric latency fields | `elapsed_ms: 127` ≈ `elapsed_ms: 131` (within 20%) |

Normalizations live in `.mcp-recorder.toml` at the session dir.

Diff output has three states per message pair: `=` (equivalent), `~` (changed), `!` (only one side). A session with zero `~` or `!` is a clean replay.

## 6. Replay semantics (v0.2)

- Replay **only** sends `c2s` requests, in order, waiting for each response before sending the next (keeps ordering deterministic).
- Notifications from the original session are also replayed at their relative timestamps (some servers expect them, e.g. `notifications/initialized`).
- Replay sessions get suffix `.replay.jsonl`; diff is always original vs. replay.
- If the server sends a request to the client (MCP allows this — e.g. `sampling/createMessage`), replay auto-responds with the response captured in the original session, looked up by method + params hash. If no match, replay errors and stops.

## 7. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| MCP spec churn (HTTP/SSE transport, new methods) | v0.1 stdio-only. Framing code is < 100 LOC and agnostic to semantics below the JSON-RPC layer. |
| Stdout buffering delays in child processes | Set `stdio: 'pipe'` and ensure the child doesn't line-buffer. Most MCP servers already flush per message. |
| Bidirectional requests (server→client) during replay | Look up response by method + params hash from original session. Error clearly if unmatched. |
| Diff false positives (non-determinism we didn't anticipate) | Config file lets users add normalization rules without code changes. Ship with a sensible default set. |

## 8. What ships at v0.1 vs later

**v0.1 (shipped):**
- `record` — transparent middleman with JSONL output + summary
- `list` — session index
- `show` — pretty-printer with request/response pairing, latency, filters
- JSON-RPC line framer (handles partial reads, batches, malformed)
- End-to-end test with a mock MCP server
- Single binary via `bun build --compile`

**v0.2 (shipped):**
- `replay` — deterministic request replay; bidi server→client requests served from canned original responses
- `diff` — semantic diff with normalization (id stripping, ISO timestamps, UUIDs, path prefixes, sorted-array rules)
- Regression-catching end-to-end test: record → replay against deliberately-broken server → diff catches exactly the regression
- Exit codes: `diff` exits 1 on any drift (CI-friendly)

**v0.3:**
- `serve` — expose list/show/diff/replay as MCP tools
- `.mcp-recorder.toml` config loader for per-project normalization rules

**later:**
- HTTP/SSE transport support
- Web viewer for sessions
- Latency/error dashboards
- zstd session compression
- Argument redaction rules
