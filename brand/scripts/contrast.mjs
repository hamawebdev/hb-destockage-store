#!/usr/bin/env node
// Verifies every contrastPairs entry in brand/tokens.json against WCAG 2.2 relative luminance.
// Usage: node brand/scripts/contrast.mjs [--out <file>]
// Exit 1 if any pair is below its minimum, or references an unknown / non-hex colour.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function checkTokens(tokens) {
  const colours = tokens.color;
  const rows = [];
  for (const p of tokens.contrastPairs.pairs) {
    const fg = colours[p.fg]?.$value;
    const bg = colours[p.bg]?.$value;
    if (!fg || !bg) {
      rows.push({ ...p, fgHex: fg ?? "?", bgHex: bg ?? "?", ratio: 0, pass: false, error: "unknown colour role" });
      continue;
    }
    const ratio = contrast(fg, bg);
    // Compare on the value rounded down to 2 decimals, as published contrast checkers do not round up.
    const pass = Math.floor(ratio * 100) / 100 >= p.min;
    rows.push({ ...p, fgHex: fg, bgHex: bg, ratio, pass });
  }
  return rows;
}

export function report(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [
    "HB Destockage — colour contrast check (WCAG 2.2, relative luminance)",
    "Source: brand/tokens.json contrastPairs. min 4.5 = text; 3 = large text / non-text UI (1.4.11).",
    "",
    `${pad("fg", 24)}${pad("bg", 17)}${pad("fg hex", 9)}${pad("bg hex", 9)}${pad("ratio", 8)}${pad("min", 5)}${pad("result", 7)}use`,
  ];
  for (const r of rows) {
    lines.push(
      `${pad(r.fg, 24)}${pad(r.bg, 17)}${pad(r.fgHex, 9)}${pad(r.bgHex, 9)}${pad(r.ratio.toFixed(2), 8)}${pad(r.min, 5)}${pad(r.pass ? "PASS" : "FAIL", 7)}${r.use}${r.error ? ` (${r.error})` : ""}`,
    );
  }
  const failed = rows.filter((r) => !r.pass).length;
  lines.push("", `${rows.length} pairs, ${rows.length - failed} pass, ${failed} fail.`);
  return { text: lines.join("\n") + "\n", failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tokens = JSON.parse(readFileSync(resolve(here, "../tokens.json"), "utf8"));
  const { text, failed } = report(checkTokens(tokens));
  process.stdout.write(text);
  const i = process.argv.indexOf("--out");
  if (i > 0 && process.argv[i + 1]) {
    mkdirSync(dirname(resolve(process.argv[i + 1])), { recursive: true });
    writeFileSync(resolve(process.argv[i + 1]), text);
  }
  process.exit(failed ? 1 : 0);
}
