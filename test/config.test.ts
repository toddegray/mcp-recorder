import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTomlLite, loadConfig } from "../src/config.ts";

const root = mkdtempSync(join(tmpdir(), "mcpr-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseTomlLite", () => {
  test("parses sections and scalars", () => {
    const out = parseTomlLite(`
# a comment
[diff]
strip_ids = true
normalize_timestamps = false
name = "echo"
count = 3
ratio = 0.25
`);
    expect((out.diff as any).strip_ids).toBe(true);
    expect((out.diff as any).normalize_timestamps).toBe(false);
    expect((out.diff as any).name).toBe("echo");
    expect((out.diff as any).count).toBe(3);
    expect((out.diff as any).ratio).toBe(0.25);
  });

  test("parses [[array.of.tables]]", () => {
    const out = parseTomlLite(`
[[diff.path_prefix]]
prefix = "/tmp/a"
replacement = "<A>"

[[diff.path_prefix]]
prefix = "/tmp/b"
replacement = "<B>"
`);
    const arr = (out.diff as any).path_prefix;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(2);
    expect(arr[0].prefix).toBe("/tmp/a");
    expect(arr[1].replacement).toBe("<B>");
  });

  test("ignores comments outside quoted strings", () => {
    const out = parseTomlLite(`
[diff]
name = "contains # hash"  # trailing comment
`);
    expect((out.diff as any).name).toBe("contains # hash");
  });
});

describe("loadConfig", () => {
  test("returns defaults when no config file exists", () => {
    const dir = mkdtempSync(join(root, "empty-"));
    const { path, options } = loadConfig(dir);
    expect(path).toBeNull();
    expect(options).toEqual({});
  });

  test("loads path_prefix + sorted_array rules", () => {
    const dir = mkdtempSync(join(root, "withconfig-"));
    writeFileSync(
      join(dir, ".mcp-recorder.toml"),
      `
[diff]
strip_ids = true

[[diff.path_prefix]]
prefix = "/tmp/work"
replacement = "<WORK>"

[[diff.sorted_array]]
field = "tools"
sort_by = "name"
`,
    );
    const { path, options } = loadConfig(dir);
    expect(path).not.toBeNull();
    expect(options.stripIds).toBe(true);
    expect(options.pathPrefixes?.[0]).toEqual({
      prefix: "/tmp/work",
      replacement: "<WORK>",
    });
    expect(options.sortedArrays?.[0]).toEqual({
      fieldName: "tools",
      sortBy: "name",
    });
  });

  test("walks up to find parent config", () => {
    const parent = mkdtempSync(join(root, "parent-"));
    writeFileSync(
      join(parent, ".mcp-recorder.toml"),
      `[diff]\nstrip_ids = false\n`,
    );
    const child = join(parent, "nested", "deep");
    mkdirSync(child, { recursive: true });
    const { path, options } = loadConfig(child);
    expect(path).not.toBeNull();
    expect(options.stripIds).toBe(false);
  });
});
