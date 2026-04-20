#!/usr/bin/env bun
// Render a terminal-style screenshot of the record→replay→diff flow catching
// a real regression. Pair with rsvg-convert to get a PNG.

const BG = "#0b0e14";
const FG = "#c6cad4";
const DIM = "#6a7080";
const BLUE = "#7aa2f7";
const RED = "#f7768e";
const YELLOW = "#e0af68";
const GREEN = "#9ece6a";
const FONT = "'SF Mono', Menlo, Monaco, Consolas, monospace";

interface Span { text: string; color?: string; bold?: boolean; }
interface Line { spans: Span[]; }
const L = (...s: Span[]): Line => ({ spans: s });

const lines: Line[] = [
  L(
    { text: "$ ", color: GREEN, bold: true },
    { text: "mcp-recorder record ", color: FG, bold: true },
    { text: "--session orig -- bun mock-server.ts", color: BLUE },
  ),
  L({ text: "[mcp-recorder] wrote orig.jsonl (3 req, 3 resp, 0 err, 0.04s)", color: DIM }),
  L({ text: "" }),
  L(
    { text: "$ ", color: GREEN, bold: true },
    { text: "mcp-recorder replay ", color: FG, bold: true },
    { text: "orig --out orig.broken -- bun mock-server-broken.ts", color: BLUE },
  ),
  L({ text: "[mcp-recorder] wrote orig.broken.jsonl (replayed 3 messages)", color: DIM }),
  L({ text: "" }),
  L(
    { text: "$ ", color: GREEN, bold: true },
    { text: "mcp-recorder diff ", color: FG, bold: true },
    { text: "orig orig.broken", color: BLUE },
  ),
  L({ text: "" }),
  L({ text: "diff  A: orig.jsonl  ↔  B: orig.broken.jsonl", color: FG, bold: true }),
  L({ text: "equal: 2    changed: 1    only-A: 0    only-B: 0", color: DIM }),
  L({ text: "" }),
  L(
    { text: "  = ", color: GREEN, bold: true },
    { text: "initialize  ", color: FG },
    { text: "{}", color: DIM },
  ),
  L(
    { text: "  = ", color: GREEN, bold: true },
    { text: "tools/list", color: FG },
  ),
  L(
    { text: "  ~ ", color: YELLOW, bold: true },
    { text: "tools/call  ", color: FG, bold: true },
    { text: '{"name":"echo","arguments":{"message":"ship it"}}', color: DIM },
  ),
  L(
    { text: "      result.content[0].text:  ", color: DIM },
    { text: '"echo: ship it"', color: FG },
    { text: "  → ", color: YELLOW, bold: true },
    { text: '"ECHOED: ship it"', color: RED, bold: true },
  ),
];

const fontSize = 14;
const lineHeight = 20;
const charWidth = 8.4;
const padX = 20;
const padY = 48;
const titleHeight = 36;

const maxChars = Math.max(
  ...lines.map((l) => l.spans.reduce((n, s) => n + s.text.length, 0)),
);
const width = Math.ceil(padX * 2 + maxChars * charWidth);
const height = Math.ceil(padY + lines.length * lineHeight + 24);

const parts: string[] = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
parts.push(`<rect width="${width}" height="${height}" rx="10" ry="10" fill="${BG}"/>`);
parts.push(`<rect x="0" y="0" width="${width}" height="${titleHeight}" rx="10" ry="10" fill="#141925"/>`);
parts.push(`<rect x="0" y="${titleHeight - 10}" width="${width}" height="10" fill="#141925"/>`);
parts.push(`<circle cx="18" cy="18" r="6" fill="#f7768e"/>`);
parts.push(`<circle cx="38" cy="18" r="6" fill="#e0af68"/>`);
parts.push(`<circle cx="58" cy="18" r="6" fill="#9ece6a"/>`);
parts.push(`<text x="${width/2}" y="22" fill="${DIM}" font-family="${FONT}" font-size="12" text-anchor="middle">mcp-recorder — zsh</text>`);

for (let i = 0; i < lines.length; i++) {
  const y = padY + i * lineHeight;
  let x = padX;
  for (const span of lines[i]!.spans) {
    const color = span.color ?? FG;
    const weight = span.bold ? "bold" : "normal";
    parts.push(`<text x="${x}" y="${y}" fill="${color}" font-family="${FONT}" font-size="${fontSize}" font-weight="${weight}" xml:space="preserve">${escape(span.text)}</text>`);
    x += span.text.length * charWidth;
  }
}
parts.push("</svg>");

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

process.stdout.write(parts.join("\n"));
