// Renders the placeholder photo SVGs written by build.py into JPEGs with system Chrome (headless,
// DevTools protocol, no npm dependency). Chrome is used for correct Arabic text shaping.
//
//   node data/catalog/placeholders/render.mjs <svg dir> <data/photos dir>
//
// <svg dir>/<slug>/<n>.svg  ->  <data/photos dir>/<slug>/<n>.jpg  (1200×1200, JPEG quality 82, sRGB)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [svgDir, outDir] = process.argv.slice(2);
if (!svgDir || !outDir) {
  console.error('usage: node render.mjs <svg dir> <data/photos dir>');
  process.exit(2);
}
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const PORT = Number(process.env.CDP_PORT ?? 4172);
const SIZE = 1200;

const profile = mkdtempSync(join(tmpdir(), 'seed-render-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
  if (!wsUrl) await sleep(100);
}
if (!wsUrl) throw new Error('Chrome did not start');

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  const p = m.id && pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false });
  const { frameTree } = await send('Page.getFrameTree');
  let count = 0;
  for (const slug of readdirSync(svgDir).sort()) {
    for (const file of readdirSync(join(svgDir, slug)).filter((f) => f.endsWith('.svg')).sort()) {
      const svg = readFileSync(join(svgDir, slug, file), 'utf8');
      const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#f3f1ee}svg{display:block}</style>${svg}`;
      await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
      await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
      const shot = await send('Page.captureScreenshot', {
        format: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 },
      });
      mkdirSync(join(outDir, slug), { recursive: true });
      writeFileSync(join(outDir, slug, file.replace(/\.svg$/, '.jpg')), Buffer.from(shot.data, 'base64'));
      count++;
    }
  }
  console.log(`rendered ${count} placeholder photos into ${outDir}`);
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
