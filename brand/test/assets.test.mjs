// Run: node --test brand/test/*.test.mjs   (needs sharp from the root node_modules: npm ci)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import sharp from "sharp";

const at = (f) => new URL(`../assets/${f}`, import.meta.url);
const meta = (f) => sharp(readFileSync(at(f))).metadata();

test("square icons have the right size", async () => {
  for (const [f, s] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512]]) {
    const m = await meta(f);
    assert.equal(m.width, s, f);
    assert.equal(m.height, s, f);
  }
});

test("apple-touch and maskable icons are fully opaque (iOS / Android apply their own mask)", async () => {
  for (const f of ["apple-touch-icon.png", "icon-maskable-512.png"]) {
    const { channels } = await sharp(readFileSync(at(f))).stats();
    const m = await meta(f);
    if (m.hasAlpha) assert.equal(channels[3].min, 255, f);
  }
});

test("favicon.ico holds 16 and 32 px PNG images", () => {
  const b = readFileSync(at("favicon.ico"));
  assert.equal(b.readUInt16LE(2), 1);
  assert.equal(b.readUInt16LE(4), 2);
  assert.deepEqual([b[6], b[7], b[22], b[23]], [16, 16, 32, 32]);
  for (const e of [6, 22]) {
    const off = b.readUInt32LE(e + 12);
    assert.equal(b.subarray(off, off + 8).toString("hex"), "89504e470d0a1a0a");
  }
});

test("favicon.svg is small, outlined and self-contained", () => {
  const s = readFileSync(at("favicon.svg"), "utf8");
  assert.ok(s.length < 1200, `${s.length} B`);
  assert.doesNotMatch(s, /<text|font-family|href=|<image/);
  assert.match(s, /prefers-color-scheme:dark/);
});

test("social images are 1200x630 JPEG, <= 80 KB, one per language plus x-default", async () => {
  for (const f of ["og-default-ar.jpg", "og-default-fr.jpg", "og-default.jpg", "og-category-sample-ar.jpg", "og-category-sample-fr.jpg"]) {
    const m = await meta(f);
    assert.equal(m.format, "jpeg", f);
    assert.equal(m.width, 1200, f);
    assert.equal(m.height, 630, f);
    assert.ok(statSync(at(f)).size <= 80 * 1024, `${f} ${statSync(at(f)).size} B`);
  }
  assert.deepEqual(readFileSync(at("og-default.jpg")), readFileSync(at("og-default-ar.jpg")), "x-default = Arabic");
});
