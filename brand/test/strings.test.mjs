// Run: node --test brand/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ERROR_CODES as SERVER_CODES } from "@hb/shared/order-schema";

const load = (lang) => JSON.parse(readFileSync(new URL(`../copy/strings.${lang}.json`, import.meta.url), "utf8"));
const ar = load("ar");
const fr = load("fr");
const PLURAL = ["zero", "one", "two", "few", "many", "other"];
const vars = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const pluralBase = (k) => {
  const m = /^(.*)\.(zero|one|two|few|many|other)$/.exec(k);
  return m ? m[1] : null;
};

// Server codes come from the contract itself, so a code added in @hb/shared turns this test red
// until it has copy. Client-only codes are emitted by orderform's JS, never by the Worker.
const CLIENT_ONLY_CODES = ["network_error", "quote_failed", "wilaya_required", "commune_required"];
const ERROR_CODES = [...SERVER_CODES, ...CLIENT_ONLY_CODES];

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

test("every order error code (all of @hb/shared ERROR_CODES + client-only) has a message in both languages", () => {
  assert.ok(SERVER_CODES.length >= 24, "contract list looks truncated");
  for (const c of ERROR_CODES) {
    assert.ok(`order.errors.${c}` in fr, `fr order.errors.${c}`);
    assert.ok(`order.errors.${c}` in ar, `ar order.errors.${c}`);
  }
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
  // Lead rule: a failed fee quote = retry; never "confirm anyway", never "fee told by phone".
  assert.doesNotMatch(fr["order.errors.quote_failed"], /confirm|au téléphone|par téléphone/i);
  assert.doesNotMatch(ar["order.errors.quote_failed"], /تأكيد|أكّد|عبر الهاتف/);
});

test("before an order no message gives the shop's phone or WhatsApp, and each still gives a next step (D-029)", () => {
  const preOrder = ["quote_failed", "rate_limited", "delivery_unavailable", "server_error", "order_total_out_of_range"].map((c) => `order.errors.${c}`);
  // order.whatsappCta is the confirmation page's button (after the order): the one order.* key allowed to name WhatsApp.
  const before = (k) => (k.startsWith("order.") || k.startsWith("cart.") || k.startsWith("product.")) && k !== "order.whatsappCta";
  for (const k of Object.keys(fr).filter(before)) {
    assert.doesNotMatch(fr[k], /\{phone\}|\{whatsapp\}|WhatsApp|appelez-nous/i, k);
    assert.doesNotMatch(ar[k], /\{phone\}|\{whatsapp\}|واتساب|اتصل بنا/, k);
  }
  for (const k of preOrder) {
    assert.match(fr[k], /Réessayez|réessayez|Réduisez|Choisissez/, k);
    assert.match(ar[k], /حاول|قلّل|اختر/, k);
  }
});

test("server error messages render without variables except {phone}/{max} (no-JS review step has no option name)", () => {
  for (const k of ["order.errors.variant_required", "order.errors.validation", "order.errors.total_changed", "order.errors.name_required"]) {
    assert.deepEqual([...vars(fr[k])], [], k);
  }
});

test("Arabic: a sign before a number or variable is anchored with U+200E (else it renders on the wrong side, e.g. '20%−')", () => {
  for (const [k, v] of Object.entries(ar)) {
    if (k === "footer.whatsappDisplay") continue; // rendered inside <bdi dir="ltr">
    assert.doesNotMatch(v, /(^|[^\u200E])[\u2212+\-](\{|\d)/u, k);
  }
});

test("French typography: no breaking space before : ; ? ! % » or after «, and none inside '9 h'", () => {
  for (const [k, v] of Object.entries(fr)) {
    if (k.startsWith("_meta.")) continue;
    assert.doesNotMatch(v, / [:;?!%»]/, `${k}: breaking space before punctuation`);
    assert.doesNotMatch(v, /« /, `${k}: breaking space after «`);
    assert.doesNotMatch(v, /\d h\b/, `${k}: breaking space in hour`);
  }
});
