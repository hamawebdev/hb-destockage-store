// Run: node --test brand/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/build-guide.mjs", import.meta.url));
const html = readFileSync(new URL("../guide.html", import.meta.url), "utf8");

test("GUIDE.md contrast table and guide.html are up to date with tokens, logo, copy and icons", () => {
  execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" });
});

test("guide.html is self-contained: no scripts, no external resources", () => {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\s(src|srcset)=["']?https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /url\((?!data:)/i);
  assert.doesNotMatch(html, /@import/i);
});

test("guide covers every required section", () => {
  for (const h of ["Personality", "Logo", "Colour", "Typography", "Iconography", "Photography", "Layout and spacing", "Motion", "Voice", "Accessibility checklist", "Templates"]) {
    assert.match(html, new RegExp(`<h2[^>]*>\\d+\\. ${h}</h2>`), h);
  }
  assert.match(html, /Contrast table/);
  assert.match(html, /@media print/);
});
