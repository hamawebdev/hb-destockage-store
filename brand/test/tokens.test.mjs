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

// Evaluates "clamp(Arem, Brem + Cvw, Drem)" (or a bare "Arem") at a viewport width, in px.
function evalFluid(expr, vw) {
  const rems = [...expr.matchAll(/(-?[\d.]+)rem/g)].map((m) => parseFloat(m[1]) * 16);
  if (rems.length === 1) return rems[0];
  const slope = parseFloat(/(-?[\d.]+)vw/.exec(expr)[1]);
  return Math.min(Math.max(rems[1] + (slope * vw) / 100, rems[0]), rems[2]);
}

test("every fluid value (type scale and layout) equals its px at each stated viewport", () => {
  const entries = [
    ...Object.entries(tokens.typeScale.steps).map(([k, v]) => [`typeScale.${k}`, v]),
    ...Object.entries(tokens.layout).filter(([, v]) => v && v.fluid).map(([k, v]) => [`layout.${k}`, v]),
  ];
  assert.ok(entries.length >= 11);
  for (const [name, v] of entries) {
    for (const vw of [360, 768, 1440]) {
      const px = v[`px${vw}`];
      if (px === undefined) continue;
      assert.ok(Math.abs(evalFluid(v.fluid, vw) - px) < 0.55, `${name} @${vw}: ${evalFluid(v.fluid, vw).toFixed(2)} != ${px}`);
    }
  }
});

test("breakpoints match the 360/768/1024/1440 contract", () => {
  const bp = Object.fromEntries(Object.entries(tokens.breakpoint).filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, v.$value]));
  assert.deepEqual(bp, { base: "360px", md: "768px", lg: "1024px", xl: "1440px" });
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

test("contrast CLI runs when invoked through a symlink", async () => {
  const { mkdtempSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "brand-contrast-"));
  const link = join(dir, "c.mjs");
  symlinkSync(fileURLToPath(new URL("../scripts/contrast.mjs", import.meta.url)), link);
  const out = execFileSync(process.execPath, [link], { encoding: "utf8" });
  assert.match(out, /pairs, \d+ pass, 0 fail/);
});
