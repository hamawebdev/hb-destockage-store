// Run: node --test brand/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrast, checkTokens } from "../scripts/contrast.mjs";

const tokens = JSON.parse(readFileSync(new URL("../tokens.json", import.meta.url), "utf8"));

test("contrast() matches known WCAG values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#ffffff", "#ffffff").toFixed(2), "1.00");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
});

test("every contrast pair meets its minimum", () => {
  const failed = checkTokens(tokens).filter((r) => !r.pass);
  assert.deepEqual(failed.map((r) => `${r.fg} on ${r.bg}: ${r.ratio.toFixed(2)} < ${r.min}`), []);
});

test("every opaque colour role is a 6-digit hex", () => {
  for (const [k, v] of Object.entries(tokens.color)) {
    if (k === "scrim") continue;
    assert.match(v.$value, /^#[0-9a-f]{6}$/, k);
  }
});

test("every colour role used for text appears in at least one checked pair", () => {
  const used = new Set(tokens.contrastPairs.pairs.flatMap((p) => [p.fg, p.bg]));
  const decorative = new Set(["border", "scrim", "surface-raised"]);
  for (const k of Object.keys(tokens.color)) {
    if (!decorative.has(k)) assert.ok(used.has(k), `${k} is not in contrastPairs`);
  }
});

test("Arabic rules: single weight 400, letter-spacing 0, line-heights unitless 1.6–1.8", () => {
  assert.equal(tokens.font.weight.regular.$value, 400);
  assert.equal(tokens.font.letterSpacing.arabic.$value, "0");
  for (const k of ["arabic-body", "arabic-heading", "arabic-ui"]) {
    const v = tokens.font.lineHeight[k].$value;
    assert.equal(typeof v, "number", k);
    assert.ok(v >= 1.6 && v <= 1.8, `${k}=${v}`);
  }
  assert.equal(tokens.font.lineHeight["arabic-body"].$value, 1.7);
  assert.ok(!tokens.font.family.switcher.$value.includes("Noto Sans Arabic"), "switcher must not pull the webfont");
  assert.ok(!/Noto|webfont/i.test(tokens.font.family.latin.$value.split(",")[0]), "Latin stack starts with a system font");
});

test("type scale: px at 360/1440 match the fluid clamp endpoints", () => {
  for (const [step, s] of Object.entries(tokens.typeScale.steps)) {
    const nums = [...s.fluid.matchAll(/([\d.]+)rem/g)].map((m) => parseFloat(m[1]) * 16);
    if (s.px360 === s.px1440) assert.equal(nums[0], s.px360, step);
    else {
      assert.equal(nums[0], s.px360, `${step} min`);
      assert.equal(nums[2], s.px1440, `${step} max`);
      const vw = parseFloat(/([\d.]+)vw/.exec(s.fluid)[1]);
      assert.ok(Math.abs(nums[1] + (vw * 360) / 100 - s.px360) < 0.05, `${step} at 360`);
      assert.ok(Math.abs(nums[1] + (vw * 1440) / 100 - s.px1440) < 0.05, `${step} at 1440`);
    }
  }
});

test("spacing is on the 4px grid", () => {
  for (const [k, v] of Object.entries(tokens.space)) {
    if (k.startsWith("$")) continue;
    assert.equal(parseInt(v.$value, 10) % 4, 0, k);
  }
});
