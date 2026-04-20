// `.mcp-recorder.toml` loader for per-project normalization rules.
//
// We support a deliberately small TOML subset — enough for diff configuration,
// no more. Zero runtime deps. Keeping our own tiny parser means the binary
// stays single-file and the config surface is obvious.
//
// Supported schema:
//
//   [diff]
//   strip_ids = true
//   normalize_timestamps = true
//   normalize_uuids = true
//
//   [[diff.path_prefix]]
//   prefix = "/tmp/session-"
//   replacement = "<TMP>"
//
//   [[diff.sorted_array]]
//   field = "tools"
//   sort_by = "name"

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { NormalizeOptions } from "./normalizers.ts";

export interface LoadedConfig {
  /** Absolute path to the loaded config file, or null if none found. */
  path: string | null;
  options: NormalizeOptions;
}

/**
 * Walk up from `startDir` looking for a `.mcp-recorder.toml` file. Returns
 * the first one found (closest wins). If none is found, returns defaults.
 */
export function loadConfig(startDir: string): LoadedConfig {
  const found = findUp(startDir, ".mcp-recorder.toml");
  if (!found) {
    return { path: null, options: {} };
  }
  const text = readFileSync(found, "utf8");
  const parsed = parseTomlLite(text);
  return { path: found, options: toOptions(parsed) };
}

function findUp(startDir: string, filename: string): string | null {
  let dir = resolve(startDir);
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// --------------------------------------------------------------------------
// Minimal TOML parser: key = value, [section], [[array_of_tables]]. Supports
// string, integer, float, boolean. Arrays and inline tables are NOT supported
// — on purpose. Use [[array_of_tables]] for multi-row config instead.
// --------------------------------------------------------------------------

type Scalar = string | number | boolean;
type TomlValue = Scalar | TomlTable | TomlTable[];
interface TomlTable {
  [key: string]: TomlValue;
}

export function parseTomlLite(text: string): TomlTable {
  const root: TomlTable = {};
  let currentTable: TomlTable = root;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Strip comments (outside of strings — we don't support strings with #
    // intentionally; keep it simple).
    const hashIdx = indexOfOutsideQuotes(line, "#");
    if (hashIdx !== -1) line = line.slice(0, hashIdx);
    line = line.trim();
    if (line === "") continue;

    // [[array.of.tables]]
    const arrHead = line.match(/^\[\[\s*([A-Za-z_][\w.]*)\s*\]\]$/);
    if (arrHead) {
      const path = arrHead[1]!.split(".");
      const arr = ensureArrayPath(root, path);
      const next: TomlTable = {};
      arr.push(next);
      currentTable = next;
      continue;
    }

    // [section]
    const tblHead = line.match(/^\[\s*([A-Za-z_][\w.]*)\s*\]$/);
    if (tblHead) {
      const path = tblHead[1]!.split(".");
      currentTable = ensureTablePath(root, path);
      continue;
    }

    // key = value
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const rawVal = kv[2]!.trim();
    currentTable[key] = parseScalar(rawVal);
  }
  return root;
}

function indexOfOutsideQuotes(s: string, needle: string): number {
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inQuote) inQuote = null;
    } else if (c === '"' || c === "'") {
      inQuote = c;
    } else if (c === needle) {
      return i;
    }
  }
  return -1;
}

function parseScalar(raw: string): Scalar {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }
  return raw;
}

function ensureTablePath(root: TomlTable, path: string[]): TomlTable {
  let cur: TomlTable = root;
  for (const seg of path) {
    const next = cur[seg];
    if (next === undefined) {
      const t: TomlTable = {};
      cur[seg] = t;
      cur = t;
    } else if (
      next !== null &&
      typeof next === "object" &&
      !Array.isArray(next)
    ) {
      cur = next as TomlTable;
    } else {
      // Conflicts with a non-table: we overwrite. Simple parser, consistent behavior.
      const t: TomlTable = {};
      cur[seg] = t;
      cur = t;
    }
  }
  return cur;
}

function ensureArrayPath(root: TomlTable, path: string[]): TomlTable[] {
  // Walk to the parent of the last segment, which becomes the array key.
  let cur: TomlTable = root;
  for (let i = 0; i < path.length - 1; i++) {
    cur = ensureTablePath(cur, [path[i]!]);
  }
  const leaf = path[path.length - 1]!;
  const existing = cur[leaf];
  if (Array.isArray(existing)) return existing as TomlTable[];
  const arr: TomlTable[] = [];
  cur[leaf] = arr;
  return arr;
}

// --------------------------------------------------------------------------

function toOptions(parsed: TomlTable): NormalizeOptions {
  const opts: NormalizeOptions = {};
  const diff = (parsed.diff as TomlTable | undefined) ?? {};

  if (typeof diff.strip_ids === "boolean") opts.stripIds = diff.strip_ids;
  if (typeof diff.normalize_timestamps === "boolean") {
    opts.normalizeTimestamps = diff.normalize_timestamps;
  }
  if (typeof diff.normalize_uuids === "boolean") {
    opts.normalizeUuids = diff.normalize_uuids;
  }

  const prefixes = diff.path_prefix;
  if (Array.isArray(prefixes)) {
    opts.pathPrefixes = prefixes
      .map((p) => ({
        prefix: String((p as TomlTable).prefix ?? ""),
        replacement: String((p as TomlTable).replacement ?? ""),
      }))
      .filter((p) => p.prefix.length > 0);
  }

  const sorted = diff.sorted_array;
  if (Array.isArray(sorted)) {
    opts.sortedArrays = sorted
      .map((s) => ({
        fieldName: String((s as TomlTable).field ?? ""),
        sortBy: String((s as TomlTable).sort_by ?? ""),
      }))
      .filter((s) => s.fieldName.length > 0 && s.sortBy.length > 0);
  }

  return opts;
}

// Silence unused-import warning for `isAbsolute` that we export for future use.
void isAbsolute;
