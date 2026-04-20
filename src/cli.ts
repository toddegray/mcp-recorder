#!/usr/bin/env bun
// mcp-recorder CLI.
//
//   mcp-recorder record [--session <name>] [--dir <path>] -- <cmd> [args...]
//   mcp-recorder list   [--dir <path>]
//   mcp-recorder show   <session-file-or-name> [--filter m] [--slow >500]
//                                              [--json] [--no-color]
//                                              [--dir <path>]

import { record } from "./record.ts";
import { replay } from "./replay.ts";
import { diffSessions, formatDiff } from "./diff.ts";
import { showSession, formatList } from "./show.ts";
import { defaultSessionDir } from "./session.ts";
import { existsSync } from "node:fs";
import { join, isAbsolute, dirname, basename } from "node:path";

const VERSION = "0.2.0";

function usage(): string {
  return `mcp-recorder ${VERSION} — record, replay, and diff MCP sessions

USAGE
  mcp-recorder record <name> [--dir <path>] -- <cmd> [args...]
  mcp-recorder list   [--dir <path>]
  mcp-recorder show   <session> [--filter <method>] [--slow <ms>] [--json] [--no-color] [--dir <path>]
  mcp-recorder replay <session> [--out <name>] [--dir <path>] -- <cmd> [args...]
  mcp-recorder diff   <session-a> <session-b> [--no-color] [--dir <path>]

COMMANDS
  record   Spawn an MCP server as a subprocess and record every JSON-RPC
           message flowing in either direction to ~/.mcp-recorder/sessions/
  list     Show all recorded sessions in a directory
  show     Pretty-print a recorded session
  replay   Replay a session's requests against a fresh server, recording the
           new responses to <name>.replay.jsonl
  diff     Semantically diff two sessions, with id / timestamp / UUID / path
           normalization. Exit non-zero if sessions differ.

EXAMPLES
  mcp-recorder record --session fs-debug -- \\
      npx @modelcontextprotocol/server-filesystem /tmp

  mcp-recorder list
  mcp-recorder show fs-debug
  mcp-recorder replay fs-debug -- npx @modelcontextprotocol/server-filesystem /tmp
  mcp-recorder diff fs-debug fs-debug.replay
`;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(usage());
    return 0;
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    process.stdout.write(`mcp-recorder ${VERSION}\n`);
    return 0;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case "record":
      return runRecord(rest);
    case "list":
      return runList(rest);
    case "show":
      return runShow(rest);
    case "replay":
      return runReplay(rest);
    case "diff":
      return runDiff(rest);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${usage()}`);
      return 2;
  }
}

/**
 * record parses: [--session name] [--dir path] -- <cmd> [args...]
 * The "--" is mandatory to separate our flags from the server command.
 */
function parseRecordArgs(args: string[]): {
  session?: string;
  dir?: string;
  command: string;
  commandArgs: string[];
} | null {
  const dashIdx = args.indexOf("--");
  if (dashIdx === -1) return null;

  const pre = args.slice(0, dashIdx);
  const post = args.slice(dashIdx + 1);
  if (post.length === 0) return null;

  let session: string | undefined;
  let dir: string | undefined;

  for (let i = 0; i < pre.length; i++) {
    const a = pre[i]!;
    if (a === "--session") {
      session = pre[++i];
    } else if (a.startsWith("--session=")) {
      session = a.slice("--session=".length);
    } else if (a === "--dir") {
      dir = pre[++i];
    } else if (a.startsWith("--dir=")) {
      dir = a.slice("--dir=".length);
    } else {
      process.stderr.write(`unknown record flag: ${a}\n`);
      return null;
    }
  }

  return {
    session,
    dir,
    command: post[0]!,
    commandArgs: post.slice(1),
  };
}

async function runRecord(args: string[]): Promise<number> {
  const parsed = parseRecordArgs(args);
  if (!parsed) {
    process.stderr.write(
      "usage: mcp-recorder record [--session <name>] [--dir <path>] -- <cmd> [args...]\n",
    );
    return 2;
  }

  // Stdin is already connected to the parent (the real MCP client). We do NOT
  // write any chatter to stdout here — it would corrupt the JSON-RPC stream.
  // Status messages go to stderr after the session ends.
  const result = await record({
    session: parsed.session,
    dir: parsed.dir,
    command: parsed.command,
    args: parsed.commandArgs,
  });

  process.stderr.write(
    `\n[mcp-recorder] wrote ${result.sessionPath} ` +
      `(${result.summary.requests} req, ${result.summary.responses} resp, ` +
      `${result.summary.notifications} notif, ${result.summary.errors} err, ` +
      `${result.summary.durationSec}s)\n`,
  );

  return result.exitCode ?? 0;
}

async function runList(args: string[]): Promise<number> {
  const dir = flagValue(args, "--dir") ?? defaultSessionDir();
  process.stdout.write((await formatList(dir)) + "\n");
  return 0;
}

async function runShow(args: string[]): Promise<number> {
  const positional = args.find((a) => !a.startsWith("-"));
  if (!positional) {
    process.stderr.write("usage: mcp-recorder show <session> [flags]\n");
    return 2;
  }
  const dir = flagValue(args, "--dir") ?? defaultSessionDir();
  const path = resolveSessionPath(positional, dir);
  if (!existsSync(path)) {
    process.stderr.write(`session not found: ${path}\n`);
    return 2;
  }

  const output = await showSession(path, {
    filter: flagValue(args, "--filter"),
    slowerThanMs: numberFlag(args, "--slow"),
    json: args.includes("--json"),
    noColor: args.includes("--no-color") || !process.stdout.isTTY,
  });
  process.stdout.write(output + "\n");
  return 0;
}

async function runReplay(args: string[]): Promise<number> {
  const dashIdx = args.indexOf("--");
  if (dashIdx === -1) {
    process.stderr.write(
      "usage: mcp-recorder replay <session> [--out <name>] [--dir <path>] -- <cmd> [args...]\n",
    );
    return 2;
  }
  const pre = args.slice(0, dashIdx);
  const post = args.slice(dashIdx + 1);
  if (post.length === 0) {
    process.stderr.write("missing server command after --\n");
    return 2;
  }

  const positional = pre.find((a) => !a.startsWith("-"));
  if (!positional) {
    process.stderr.write("usage: mcp-recorder replay <session> -- <cmd> [args...]\n");
    return 2;
  }
  const dir = flagValue(pre, "--dir") ?? defaultSessionDir();
  const outName = flagValue(pre, "--out");
  const originalPath = resolveSessionPath(positional, dir);
  if (!existsSync(originalPath)) {
    process.stderr.write(`session not found: ${originalPath}\n`);
    return 2;
  }
  const baseName = outName ?? basename(originalPath, ".jsonl") + ".replay";
  const replayPath = resolveSessionPath(baseName, dirname(originalPath));

  const result = await replay({
    originalPath,
    replayPath,
    command: post[0]!,
    args: post.slice(1),
  });

  process.stderr.write(
    `[mcp-recorder] wrote ${result.replayPath} (replayed ${result.replayedSeqs.length} messages` +
      (result.warnings.length ? `, warnings: ${result.warnings.length}` : "") +
      `)\n`,
  );
  for (const w of result.warnings) process.stderr.write(`  warn: ${w}\n`);
  return result.exitCode ?? 0;
}

async function runDiff(args: string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  if (positionals.length < 2) {
    process.stderr.write("usage: mcp-recorder diff <session-a> <session-b>\n");
    return 2;
  }
  const dir = flagValue(args, "--dir") ?? defaultSessionDir();
  const pathA = resolveSessionPath(positionals[0]!, dir);
  const pathB = resolveSessionPath(positionals[1]!, dir);
  if (!existsSync(pathA)) {
    process.stderr.write(`session not found: ${pathA}\n`);
    return 2;
  }
  if (!existsSync(pathB)) {
    process.stderr.write(`session not found: ${pathB}\n`);
    return 2;
  }
  const report = await diffSessions(pathA, pathB);
  const useColor = !args.includes("--no-color") && process.stdout.isTTY;
  process.stdout.write(formatDiff(report, useColor) + "\n");

  const hasDrift =
    report.counts.changed > 0 ||
    report.counts.onlyA > 0 ||
    report.counts.onlyB > 0;
  return hasDrift ? 1 : 0;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const kv = args.find((a) => a.startsWith(flag + "="));
  return kv ? kv.slice(flag.length + 1) : undefined;
}
function numberFlag(args: string[], flag: string): number | undefined {
  const v = flagValue(args, flag);
  return v ? parseInt(v, 10) : undefined;
}
function resolveSessionPath(name: string, dir: string): string {
  if (name.endsWith(".jsonl") || isAbsolute(name) || name.includes("/")) return name;
  return join(dir, name + ".jsonl");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `mcp-recorder: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
