// Run: node --test brand/test/*.test.mjs
// Checks data/content/*.json against the CAT-1 SnapshotContentPage contract (packages/catalog
// schema.ts: strictObject, ASCII kebab slugs, reserved segments, link href rule) plus brand rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../../data/content/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const pages = files.map((f) => ({ f, ...JSON.parse(readFileSync(new URL(f, dir), "utf8")) }));
const LANGS = ["ar", "fr"];
const KEYS = ["about", "delivery", "returns", "contact", "legal", "privacy"];
// Mirrors packages/catalog/src/{schema,types}.ts (CAT-1).
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = ["c", "p", "search", "order", "404", "img", "js", "fonts", "geo", "api"];
const isHref = (h) => /^\/(?!\/)/.test(h) || /^tel:\+?\d+$/.test(h) || /^https:\/\/wa\.me\/\d+$/.test(h);
const FIELDS = ["id", "key", "slug", "title", "summary", "body", "sort", "active", "placeholder", "updatedAt"];
const BLOCK_FIELDS = { h2: ["type", "text"], p: ["type", "text"], ul: ["type", "items"], ol: ["type", "items"], link: ["type", "text", "href"] };
const texts = (blocks) => blocks.flatMap((b) => [b.text, ...(b.items ?? [])].filter((x) => typeof x === "string"));

test("one file per content key, named <key>.json", () => {
  assert.deepEqual(pages.map((p) => p.key).sort(), [...KEYS].sort());
  for (const p of pages) assert.equal(p.f, `${p.key}.json`);
});

test("strict SnapshotContentPage shape", () => {
  for (const p of pages) {
    const { f, ...doc } = p;
    assert.deepEqual(Object.keys(doc).sort(), [...FIELDS].sort(), f);
    assert.ok(Number.isInteger(doc.id) && doc.id >= 1, f);
    assert.ok(Number.isInteger(doc.sort) && Number.isInteger(doc.updatedAt) && doc.updatedAt > 0, f);
    assert.equal(typeof doc.active, "boolean");
    assert.equal(typeof doc.placeholder, "boolean");
    for (const field of ["slug", "title", "summary", "body"]) assert.deepEqual(Object.keys(doc[field]).sort(), LANGS, `${f} ${field}`);
    for (const l of LANGS) {
      assert.ok(doc.title[l].trim(), `${f} title.${l}`);
      assert.ok(doc.summary[l].trim().length > 20 && doc.summary[l].length <= 170, `${f} summary.${l} length ${doc.summary[l].length}`);
      for (const b of doc.body[l]) {
        assert.ok(b.type in BLOCK_FIELDS, `${f} ${b.type}`);
        assert.deepEqual(Object.keys(b).sort(), [...BLOCK_FIELDS[b.type]].sort(), `${f} ${l} block`);
        for (const t of texts([b])) assert.ok(t.trim().length > 0, `${f} ${l} empty text`);
        if (b.items) assert.ok(b.items.length >= 1);
        if (b.type === "link") assert.ok(isHref(b.href), `${f} href ${b.href}`);
      }
    }
  }
});

test("ids and slugs are unique; slugs are ASCII kebab-case and not reserved", () => {
  assert.equal(new Set(pages.map((p) => p.id)).size, pages.length);
  for (const l of LANGS) {
    const s = pages.map((p) => p.slug[l]);
    assert.equal(new Set(s).size, s.length, `duplicate ${l} slug`);
    for (const x of s) {
      assert.match(x, SLUG);
      assert.ok(!RESERVED.includes(x), x);
    }
  }
});

test("internal links point to an existing content page in the same language", () => {
  for (const p of pages)
    for (const l of LANGS)
      for (const b of p.body[l].filter((b) => b.type === "link" && b.href.startsWith("/"))) {
        const m = /^\/(ar|fr)\/([a-z0-9-]+)\/$/.exec(b.href);
        assert.ok(m, `${p.f} ${b.href}`);
        assert.equal(m[1], l, `${p.f} ${b.href} wrong language`);
        assert.ok(pages.some((q) => q.slug[l] === m[2]), `${p.f} ${b.href} unknown slug`);
      }
});

test("Arabic and French bodies have the same structure", () => {
  for (const p of pages) {
    const shape = (l) => p.body[l].map((b) => `${b.type}${b.items ? b.items.length : ""}${b.type === "link" ? b.href.replace(/^\/(ar|fr)\/[^/]+\/$/, "/page/") : ""}`);
    assert.deepEqual(shape("ar"), shape("fr"), p.f);
  }
});

test("phone numbers appear only as tel:/wa.me link blocks with the CLAUDE.md numbers", () => {
  const phoneish = /(?:\+?213|0)\s?[5-7](?:\s?\d){8}/;
  for (const p of pages)
    for (const l of LANGS) {
      for (const b of p.body[l]) {
        if (b.type === "link" && b.href.startsWith("tel:")) assert.equal(b.href, "tel:+213560417403");
        if (b.type === "link" && b.href.startsWith("https://wa.me/")) assert.equal(b.href, "https://wa.me/213779942022");
        if (b.type === "link") continue;
        for (const t of texts([b])) assert.doesNotMatch(t, phoneish, `${p.f} ${l}: phone in running text`);
      }
      for (const t of [p.title[l], p.summary[l]]) assert.doesNotMatch(t, phoneish);
    }
});

test("placeholder flag matches [PLACEHOLDER] marks, in both languages", () => {
  for (const p of pages) {
    const has = (l) => [p.title[l], p.summary[l], ...texts(p.body[l])].some((t) => t.includes("[PLACEHOLDER"));
    assert.equal(has("ar"), has("fr"), p.f);
    assert.equal(p.placeholder, has("fr"), `${p.f} placeholder flag`);
  }
});

test("legal pages (privacy, legal) are marked for the client's counsel", () => {
  for (const k of ["privacy", "legal"]) {
    const p = pages.find((x) => x.key === k);
    assert.equal(p.placeholder, true);
    for (const l of LANGS) assert.match(p.body[l][0].text, /^\[PLACEHOLDER/, `${k} ${l} must open with the counsel placeholder`);
  }
  const priv = pages.find((x) => x.key === "privacy");
  assert.match(priv.body.fr[0].text, /18-07/);
  assert.match(priv.body.ar[0].text, /18-07/);
});

test("French typography and calm voice", () => {
  for (const p of pages)
    for (const t of [p.title.fr, p.summary.fr, ...texts(p.body.fr)]) {
      assert.doesNotMatch(t, / [:;?!»]|« /, `${p.f}: ${t}`);
      assert.doesNotMatch(t, /!/);
    }
});
