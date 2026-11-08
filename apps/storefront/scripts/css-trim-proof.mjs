#!/usr/bin/env node
// Proof for the unused-rule CSS trim (hb-postbuild step 8): two builds of the same snapshot,
// --a without the trim (HB_CSS_TRIM=0) and --b with it, must render pixel-identical pages.
// One page per template x language (from <html data-tpl lang>), at 360 / 768 / 1440 px, full page,
// reduced motion, fonts warmed and settled. Also runs axe (WCAG 2.x A/AA + best practices) on --b.
// Usage: node apps/storefront/scripts/css-trim-proof.mjs --a <dist-off> --b <dist-on> [--out dir]
// Exit 0 = 0 changed pixels everywhere and 0 axe violations; 1 otherwise; 2 setup error.
// Run under /tmp/hb-locks/heavy.sh with TMPDIR on /mnt/data. Owner: shell.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { serveDist } from './serve-dist.mjs';

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const a = opt('--a');
const b = opt('--b');
const out = opt('--out');
if (!a || !b) {
  console.error('usage: css-trim-proof.mjs --a <dist without trim> --b <dist with trim> [--out dir]');
  process.exit(2);
}

let chromium, AxeBuilder, sharp;
try {
  ({ chromium } = await import('playwright'));
  ({ AxeBuilder } = await import('@axe-core/playwright'));
  sharp = (await import('sharp')).default;
} catch (e) {
  console.error(`css-trim-proof: missing dependency: ${e.message}`);
  process.exit(2);
}

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
/** One URL per template x language, taken from build --b. */
async function pages(dist) {
  const seen = new Map();
  for await (const f of walk(dist)) {
    if (!f.endsWith('.html')) continue;
    const m = /<html\b[^>]*\blang="(ar|fr)"[^>]*\bdata-tpl="([\w-]+)"/.exec(await readFile(f, 'utf8'));
    if (!m) continue;
    const rel = '/' + relative(dist, f).split(sep).join('/');
    const key = `${m[2]}/${m[1]}`;
    if (!seen.has(key)) seen.set(key, rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel);
  }
  return [...seen.entries()].sort(([x], [y]) => x.localeCompare(y));
}

const sa = serveDist(resolve(a), 4154);
const sb = serveDist(resolve(b), 4155);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--font-render-hinting=none'] });
const list = await pages(resolve(b));
const report = { pages: list.map(([k, u]) => ({ key: k, url: u })), diffs: [], axe: [] };
let fail = 0;

async function shot(page, origin, url) {
  // Warm-up load so the Arabic font (font-display: optional) is cached and used deterministically.
  await page.goto(origin + url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.goto(origin + url, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return page.screenshot({ fullPage: true, animations: 'disabled' });
}

try {
  for (const width of [360, 768, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    for (const [key, url] of list) {
      const [pa, pb] = [await shot(page, 'http://127.0.0.1:4154', url), await shot(page, 'http://127.0.0.1:4155', url)];
      const [ra, rb] = await Promise.all([pa, pb].map((p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
      let changed = 0;
      const sameSize = ra.info.width === rb.info.width && ra.info.height === rb.info.height;
      if (sameSize) {
        for (let i = 0; i < ra.data.length; i += 4) {
          if (ra.data[i] !== rb.data[i] || ra.data[i + 1] !== rb.data[i + 1] || ra.data[i + 2] !== rb.data[i + 2] || ra.data[i + 3] !== rb.data[i + 3]) changed++;
        }
      }
      const row = { width, key, url, size: `${ra.info.width}x${ra.info.height}`, sizeB: `${rb.info.width}x${rb.info.height}`, changed: sameSize ? changed : -1 };
      report.diffs.push(row);
      if (!sameSize || changed > 0) {
        fail++;
        if (out) {
          await mkdir(join(out, 'diff'), { recursive: true });
          const name = `${key.replace('/', '-')}-${width}`;
          await writeFile(join(out, 'diff', `${name}-a.png`), pa);
          await writeFile(join(out, 'diff', `${name}-b.png`), pb);
        }
      }
      console.log(`${!sameSize || changed ? 'FAIL' : 'ok  '} ${String(width).padStart(4)}px ${key.padEnd(22)} ${url}  changed px: ${sameSize ? changed : `size ${row.size} vs ${row.sizeB}`}`);
      if (width === 360) {
        // axe's default rule set (incl. best-practice), no tag filter: the lead's definition of "zero axe violations".
        const r = await new AxeBuilder({ page }).analyze();
        report.axe.push({ key, url, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })) });
        if (r.violations.length) {
          fail++;
          console.log(`FAIL axe ${key} ${url}: ${r.violations.map((v) => `${v.id}(${v.nodes.length})`).join(', ')}`);
        }
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  sa.close();
  sb.close();
}
if (out) {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'css-trim-proof.json'), JSON.stringify(report, null, 2));
}
const total = report.diffs.length;
console.log(fail ? `css-trim-proof: FAILED (${fail} problem(s))` : `css-trim-proof: OK, ${total} screenshots pixel-identical, axe 0 on ${report.axe.length} pages`);
process.exit(fail ? 1 : 0);
