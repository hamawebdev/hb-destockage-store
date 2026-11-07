#!/usr/bin/env node
// Full-page screenshots of built pages at 360 / 768 / 1440 px (360 at DPR 2), plus the open mobile
// menu at 360 for the first two paths, and a horizontal-overflow check (fails on any page wider
// than the viewport). Serves dist/ through the contained server.
// Usage: node apps/storefront/scripts/screenshots.mjs --out <dir> [--dist dir] [--port 4157] path…
// Exit 0 ok, 1 overflow, 2 setup error. Run under /tmp/hb-locks/heavy.sh with TMPDIR on /mnt/data.
// Owner: shell.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDist } from './serve-dist.mjs';

const argv = process.argv.slice(2);
const flags = new Map();
const paths = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i]?.startsWith('--')) flags.set(argv[i], argv[++i]);
  else paths.push(argv[i] ?? '');
}
const out = flags.get('--out');
if (!out || !paths.length) {
  console.error('usage: screenshots.mjs --out <dir> [--dist dir] [--port n] path…');
  process.exit(2);
}
const dist = resolve(flags.get('--dist') ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist'));
const port = Number(flags.get('--port') ?? '4157');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('screenshots: playwright is not installed');
  process.exit(2);
}
await mkdir(out, { recursive: true });
const server = serveDist(dist, port);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let overflow = 0;
try {
  for (const width of [360, 768, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: width === 360 ? 800 : width === 768 ? 1024 : 900 }, deviceScaleFactor: width === 360 ? 2 : 1 });
    const page = await ctx.newPage();
    for (const [i, p] of paths.entries()) {
      const res = await page.goto(`http://127.0.0.1:${port}${p}`, { waitUntil: 'load' }).catch((e) => e);
      if (res instanceof Error || !res || !res.ok()) {
        // 404.html is served with 200 by this static server; anything else not-ok is a wrong path.
        overflow++;
        console.log(`MISSING ${p} @${width}: ${res instanceof Error ? res.message.split('\n')[0] : res?.status()}`);
        continue;
      }
      await page.evaluate(() => document.fonts.ready);
      const name = p.replace(/^\/|\/$/g, '').replace(/\//g, '_') || 'root';
      await page.screenshot({ path: join(out, `${name}-${width}.png`), fullPage: true });
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (ov > 0) {
        overflow++;
        console.log(`OVERFLOW ${p} @${width}: ${ov}px`);
      }
      if (width === 360 && i < 2) {
        const btn = page.locator('[popovertarget="hd-menu"]:not([popovertargetaction])');
        if (await btn.isVisible()) {
          await btn.click();
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(out, `${name}-${width}-menu.png`) });
          await page.keyboard.press('Escape');
        }
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(overflow ? `screenshots: ${overflow} problem(s) (overflow or missing page)` : `screenshots: ${paths.length * 3} pages, no horizontal overflow`);
process.exit(overflow ? 1 : 0);
