// Run: node --test brand/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";

const dir = new URL("../logo/", import.meta.url);
const svgs = readdirSync(dir).filter((f) => f.endsWith(".svg"));

test("all logo variants exist", () => {
  for (const f of [
    "wordmark.svg", "wordmark-inverse.svg", "wordmark-mono.svg", "wordmark-header.svg", "wordmark-header-static.svg",
    "monogram.svg", "monogram-inverse.svg", "monogram-accent.svg", "monogram-mono.svg", "lockup.svg",
  ]) assert.ok(svgs.includes(f), f);
});

test("logos are outlined: no <text>, no font references, no external refs", () => {
  for (const f of svgs) {
    const s = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(s, /<text|<tspan|font-family|@font-face|@import|<image|href=/, f);
  }
});

test("header wordmark is <= 2 KB brotli and hidden from AT (the link is labelled)", () => {
  const s = readFileSync(new URL("wordmark-header.svg", dir));
  const br = brotliCompressSync(s, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  assert.ok(br <= 2048, `wordmark-header.svg is ${br} B brotli`);
  assert.match(s.toString(), /aria-hidden="true"/);
  assert.match(s.toString(), /fill="currentColor"/);
});

test("standalone marks carry an accessible name", () => {
  // header variants are named by their context: the <a> label (inline) or the <img alt> (static)
  for (const f of svgs.filter((f) => !f.startsWith("wordmark-header"))) {
    const s = readFileSync(new URL(f, dir), "utf8");
    assert.match(s, /aria-label="HB Destockage"/, f);
  }
});

test("logo colours come from the brand palette", () => {
  const tokens = JSON.parse(readFileSync(new URL("../tokens.json", import.meta.url), "utf8"));
  const allowed = new Set(Object.values(tokens.color).map((c) => c.$value.toLowerCase()));
  for (const f of svgs) {
    const s = readFileSync(new URL(f, dir), "utf8");
    for (const [, hex] of s.matchAll(/(#[0-9a-f]{6})/gi)) assert.ok(allowed.has(hex.toLowerCase()), `${f}: ${hex}`);
  }
});

test("static header wordmark: literal brand colours, <= 2 KB brotli, same geometry as the inline one", () => {
  const st = readFileSync(new URL("wordmark-header-static.svg", dir), "utf8");
  const inl = readFileSync(new URL("wordmark-header.svg", dir), "utf8");
  const br = brotliCompressSync(Buffer.from(st), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  assert.ok(br <= 2048, `${br} B brotli`);
  assert.doesNotMatch(st, /currentColor|var\(/);
  assert.match(st, /fill="#1d1d1f"/);
  assert.match(st, /fill="#0071e3"/);
  const d = (s) => /<path[^>]* d="([^"]+)"/.exec(s)[1];
  assert.equal(d(st), d(inl));
});
