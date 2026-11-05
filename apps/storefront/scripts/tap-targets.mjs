#!/usr/bin/env node
// Tap-target check (CLAUDE.md: tap targets >= 44 px; WCAG 2.5.8 is 24 px, the project rule is 44).
// Serves dist/ on 127.0.0.1, loads one page per template x language (every page with --all) at
// 360 and 1440 px in Chrome, and fails if any visible interactive element's hit box is under
// 44 x 44 CSS px. Opens the mobile menu (popover) and checks its links too.
// Exempt by WCAG 2.5.8's "inline" exception: links inside running text (an <a> whose parent is a
// <p>, <li> or <dd> that also contains other text). Mark anything else exempt with
// data-tap-exempt="<reason>" (reviewed).
// Usage: node apps/storefront/scripts/tap-targets.mjs [--dist apps/storefront/dist] [--port 4152] [--all] [--out dir]
// Exit 0 = pass, 1 = violations, 2 = setup error. Owner: shell. Run it under /tmp/hb-locks/heavy.sh on the shared machine.
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(opt('--dist', join(here, '..', 'dist')));
const port = Number(opt('--port', '4152'));
const out = opt('--out', null);
const all = args.includes('--all');
const MIN = 44;

const types = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.avif': 'image/avif', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.js': 'text/javascript', '.json': 'application/json' };

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** One URL per (template, lang) from <html data-tpl lang>, or every page with --all. */
async function pages() {
  const seen = new Map();
  for await (const f of walk(dist)) {
    if (!f.endsWith('.html')) continue;
    const html = await readFile(f, 'utf8');
    const m = /<html\b[^>]*\blang="(ar|fr)"[^>]*\bdata-tpl="([\w-]+)"/.exec(html);
    const rel = '/' + relative(dist, f).split(sep).join('/');
    const url = rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel;
    const key = all ? url : `${m?.[2] ?? 'other'}/${m?.[1] ?? '?'}`;
    if (!seen.has(key)) seen.set(key, url);
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('tap-targets: playwright is not installed');
  process.exit(2);
}
try {
  await stat(dist);
} catch {
  console.error(`tap-targets: no build at ${dist} (run the storefront build first)`);
  process.exit(2);
}

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let f = join(dist, p);
  try {
    if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1');

// Runs in the page: every visible interactive element smaller than MIN in either direction.
const probe = (min) => {
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [tabindex]:not([tabindex="-1"])';
  const bad = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[data-tap-exempt]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // not rendered (e.g. closed popover, visually-hidden)
    if (el.matches('.skip-link, .visually-hidden') && !el.matches(':focus')) continue; // off-screen until focused
    const parent = el.parentElement;
    if (el.tagName === 'A' && parent && /^(P|LI|DD)$/.test(parent.tagName) && parent.textContent.trim() !== el.textContent.trim()) continue; // inline link in running text
    // Half a pixel of tolerance: layout is sub-pixel (e.g. 43.98 px) and devices snap hit boxes to pixels.
    if (r.width < min - 0.5 || r.height < min - 0.5) {
      bad.push({ tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') ?? '', text: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40), w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 });
    }
  }
  return bad;
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [];
let failures = 0;
try {
  const list = await pages();
  for (const width of [360, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    for (const [key, url] of list) {
      await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'load' });
      const bad = await page.evaluate(probe, MIN);
      // The skip link is checked focused (it is only on screen then).
      await page.keyboard.press('Tab');
      const skip = await page.evaluate((min) => {
        const el = document.activeElement;
        if (!el || !el.matches('.skip-link')) return null;
        const r = el.getBoundingClientRect();
        return r.width < min || r.height < min ? { tag: 'a', cls: 'skip-link', text: el.textContent.trim(), w: r.width, h: r.height } : null;
      }, MIN);
      if (skip) bad.push(skip);
      // Mobile menu sheet, when present and visible.
      const btn = page.locator('[popovertarget="hd-menu"]:not([popovertargetaction])');
      if (await btn.isVisible()) {
        await btn.click();
        bad.push(...(await page.evaluate(probe, MIN)).map((b) => ({ ...b, where: 'menu' })));
        await page.keyboard.press('Escape');
      }
      report.push({ width, key, url, violations: bad });
      for (const b of bad) {
        failures++;
        console.log(`FAIL ${width}px ${url} ${b.where ?? ''} <${b.tag} class="${b.cls}"> "${b.text}" ${b.w}x${b.h}`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (out) {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'tap-targets.json'), JSON.stringify({ min: MIN, report }, null, 2));
}
console.log(failures ? `tap-targets: ${failures} element(s) under ${MIN}x${MIN}` : `tap-targets: OK (${report.length} page loads, every interactive element >= ${MIN}x${MIN})`);
process.exit(failures ? 1 : 0);
