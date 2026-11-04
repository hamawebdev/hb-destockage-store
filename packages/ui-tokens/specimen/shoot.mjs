// Screenshots + axe for the specimen pages. Usage (repo root):
//   node packages/ui-tokens/specimen/shoot.mjs "/mnt/data/ecom website/artifacts/TOKENS-5"
// Uses the workspace's pinned playwright + @axe-core/playwright and the system Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const out = process.argv[2];
if (!out) throw new Error('usage: shoot.mjs <output dir>');
mkdirSync(out, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
const report = [];
for (const lang of ['fr', 'ar']) {
  for (const width of [360, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const fonts = [];
    page.on('request', (r) => r.url().endsWith('.woff2') && fonts.push(r.url().split('/').pop()));
    await page.goto(`file://${join(here, `${lang}.html`)}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.screenshot({ path: join(out, `specimen-${lang}-${width}.png`), fullPage: true });
    const axe = width === 360 ? await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze() : null;
    report.push({
      lang, width, horizontalOverflowPx: overflow, fontRequests: fonts,
      axeViolations: axe ? axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })) : 'run at 360 only',
    });
    await context.close();
  }
}
await browser.close();
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
