// Normalization rules applied to messages before diffing. The goal: strip out
// noise that legitimately changes run-to-run (timestamps, UUIDs, request ids,
// ephemeral paths) without masking real semantic changes.
//
// Normalizers operate on a *cloned* JSON value and return the transformed
// value. They never mutate the input. The diff engine applies them to both
// sides before comparing, so any value that survives normalization in one
// session must survive it identically in the other.

export interface NormalizeOptions {
  /** Strip JSON-RPC id fields. Default: true. */
  stripIds?: boolean;
  /** Replace ISO-8601 timestamps with <TIME>. Default: true. */
  normalizeTimestamps?: boolean;
  /** Replace UUIDs with <UUID>. Default: true. */
  normalizeUuids?: boolean;
  /** Replace absolute paths under this prefix with <prefix>. */
  pathPrefixes?: Array<{ prefix: string; replacement: string }>;
  /** Numeric fields whose names match are compared with tolerance (0 disables). */
  numericTolerance?: { fieldPattern: RegExp; relativeTolerance: number };
  /** Arrays whose names match are sorted by the given key before compare. */
  sortedArrays?: Array<{ fieldName: string; sortBy: string }>;
}

export const DEFAULT_OPTIONS: NormalizeOptions = {
  stripIds: true,
  normalizeTimestamps: true,
  normalizeUuids: true,
  pathPrefixes: [],
  sortedArrays: [],
};

const ISO_TS = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Deep-clone and normalize a JSON value. Returns a new value; the input is
 * untouched.
 */
export function normalize(value: unknown, opts: NormalizeOptions = DEFAULT_OPTIONS): unknown {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  return walk(value, o, "");
}

function walk(v: unknown, o: NormalizeOptions, keyPath: string): unknown {
  if (Array.isArray(v)) {
    const normalizedChildren = v.map((item, i) => walk(item, o, `${keyPath}[${i}]`));
    // If this array key matches a sortedArrays rule, sort by the configured key.
    const leafKey = extractLeafKey(keyPath);
    const rule = o.sortedArrays?.find((r) => r.fieldName === leafKey);
    if (rule) {
      return [...normalizedChildren].sort((a, b) =>
        compareByKey(a, b, rule.sortBy),
      );
    }
    return normalizedChildren;
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (o.stripIds && k === "id" && isScalarId(val)) continue;
      out[k] = walk(val, o, keyPath ? `${keyPath}.${k}` : k);
    }
    return out;
  }
  if (typeof v === "string") {
    let s = v;
    if (o.normalizeUuids) s = s.replace(UUID, "<UUID>");
    if (o.normalizeTimestamps) s = s.replace(ISO_TS, "<TIME>");
    if (o.pathPrefixes) {
      for (const { prefix, replacement } of o.pathPrefixes) {
        if (s.startsWith(prefix)) {
          s = replacement + s.slice(prefix.length);
        }
      }
    }
    return s;
  }
  return v;
}

function isScalarId(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || v === null;
}

function extractLeafKey(path: string): string {
  if (!path) return "";
  const lastDot = path.lastIndexOf(".");
  const key = lastDot === -1 ? path : path.slice(lastDot + 1);
  // Strip trailing array indices, e.g. "tools[3]" → "tools".
  return key.replace(/\[\d+\]$/, "");
}

function compareByKey(a: unknown, b: unknown, key: string): number {
  const av = (a as any)?.[key];
  const bv = (b as any)?.[key];
  if (av === bv) return 0;
  if (av === undefined) return 1;
  if (bv === undefined) return -1;
  return String(av) < String(bv) ? -1 : 1;
}
