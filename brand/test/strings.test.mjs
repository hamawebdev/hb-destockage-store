// Run: node --test brand/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = (lang) => JSON.parse(readFileSync(new URL(`../copy/strings.${lang}.json`, import.meta.url), "utf8"));
const ar = load("ar");
const fr = load("fr");
const PLURAL = ["zero", "one", "two", "few", "many", "other"];
const vars = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const pluralBase = (k) => {
  const m = /^(.*)\.(zero|one|two|few|many|other)$/.exec(k);
  return m ? m[1] : null;
};

// Copied from packages/shared/src/order-schema.ts ORDER_ERROR_CODES (SHARED-1 f76df3d) + client-only codes.
const ERROR_CODES = [
  "invalid_request", "lang_invalid", "name_invalid", "phone_required", "phone_invalid", "phone_not_mobile",
  "wilaya_invalid", "commune_invalid", "items_empty", "items_invalid", "qty_invalid", "variant_unavailable",
  "out_of_stock", "delivery_unavailable", "idempotency_key_invalid", "rate_limited", "server_error",
  // client-side only (orderform JS):
  "network_error", "quote_failed", "variant_required", "name_required", "wilaya_required", "commune_required", "total_changed", "validation", "forbidden_origin", "payload_too_large", "unsupported_media_type",
];

test("both files have identical key sets", () => {
  const a = Object.keys(ar).sort();
  const f = Object.keys(fr).sort();
  assert.deepEqual(a.filter((k) => !fr[k] && fr[k] !== ""), [], "keys only in ar");
  assert.deepEqual(f.filter((k) => !ar[k] && ar[k] !== ""), [], "keys only in fr");
  assert.equal(a.length, f.length);
});

test("every value is a non-empty, trimmed string", () => {
  for (const [lang, t] of [["ar", ar], ["fr", fr]]) {
    for (const [k, v] of Object.entries(t)) {
      assert.equal(typeof v, "string", `${lang} ${k}`);
      assert.ok(v.trim().length > 0, `${lang} ${k} is empty`);
      assert.equal(v, v.trim(), `${lang} ${k} has outer whitespace`);
    }
  }
});

test("keys are flat dotted camelCase/snake_case segments", () => {
  for (const k of Object.keys(fr)) assert.match(k, /^_?[a-zA-Z0-9]+(\.[a-zA-Z0-9_]+)+$/, k);
});

test("plural groups carry all six CLDR categories in both files", () => {
  const bases = new Set(Object.keys(fr).map(pluralBase).filter(Boolean));
  assert.ok(bases.size >= 4);
  for (const b of bases) for (const c of PLURAL) assert.ok(b + "." + c in fr && b + "." + c in ar, `${b}.${c}`);
});

test("variables match across languages", () => {
  for (const k of Object.keys(fr)) {
    const base = pluralBase(k);
    if (base) {
      // A plural form may drop {count} (Arabic one/two spell the number out), never add a variable.
      for (const t of [ar, fr]) for (const v of vars(t[k])) assert.ok(vars(t[base + ".other"]).has(v), `${k}: {${v}}`);
      continue;
    }
    assert.deepEqual([...vars(ar[k])].sort(), [...vars(fr[k])].sort(), k);
  }
});

test("placeholders are marked in both languages together, and only where expected", () => {
  for (const k of Object.keys(fr)) {
    assert.equal(ar[k].includes("[PLACEHOLDER]"), fr[k].includes("[PLACEHOLDER]"), k);
  }
});

test("every order error code has a message", () => {
  for (const c of ERROR_CODES) assert.ok(`order.errors.${c}` in fr, c);
});

test("Arabic values are translated (differ from French) unless language-neutral", () => {
  const neutral = new Set([
    "common.brandName", "footer.phoneDisplay", "footer.whatsappDisplay", "footer.copyright", "order.phone.placeholder",
    "product.pack.qty", "meta.titleTemplate", "meta.siteName", "meta.category.title", "meta.product.title",
    "dev.placeholder",
  ]);
  for (const k of Object.keys(fr)) {
    if (k.startsWith("_meta.") || neutral.has(k)) continue;
    assert.notEqual(ar[k], fr[k], `${k} looks untranslated`);
  }
});

test("Arabic sentences never contain spaced digit groups (they reorder in RTL)", () => {
  const isolated = new Set(["footer.phoneDisplay", "footer.whatsappDisplay", "order.phone.placeholder"]);
  for (const [k, v] of Object.entries(ar)) {
    if (isolated.has(k)) continue;
    assert.doesNotMatch(v, /\d\s+\d/, k);
  }
});

test("contact numbers are the ones in CLAUDE.md", () => {
  for (const t of [ar, fr]) {
    assert.equal(t["footer.phoneDisplay"].replace(/\s/g, ""), "0560417403");
    assert.equal(t["footer.whatsappDisplay"].replace(/\s/g, ""), "+213779942022");
  }
});

test("language switch labels are the other language's name", () => {
  assert.equal(fr["chrome.langSwitch"], "العربية");
  assert.equal(fr["chrome.langSwitchLang"], "ar");
  assert.equal(ar["chrome.langSwitch"], "Français");
  assert.equal(ar["chrome.langSwitchLang"], "fr");
});

test("no exclamation marks (calm voice)", () => {
  for (const [lang, t] of [["ar", ar], ["fr", fr]]) for (const [k, v] of Object.entries(t)) assert.doesNotMatch(v, /!/, `${lang} ${k}`);
});

test("no message lets the customer confirm without a total or promises the fee by phone", () => {
  // Lead rule: a failed fee quote = retry or contact us; never "confirm anyway", never "fee told by phone".
  assert.doesNotMatch(fr["order.errors.quote_failed"], /confirm|au téléphone|par téléphone/i);
  assert.doesNotMatch(ar["order.errors.quote_failed"], /تأكيد|أكّد|عبر الهاتف/);
  for (const k of ["order.errors.quote_failed", "order.errors.rate_limited", "order.errors.delivery_unavailable"]) {
    assert.match(fr[k], /\{phone\}.*WhatsApp/, k);
    assert.match(ar[k], /\{phone\}.*واتساب/, k);
  }
});

test("server error messages render without variables except {phone}/{max} (no-JS review step has no option name)", () => {
  for (const k of ["order.errors.variant_required", "order.errors.validation", "order.errors.total_changed", "order.errors.name_required"]) {
    assert.deepEqual([...vars(fr[k])], [], k);
  }
});
