// Configures Meta the way the owner does: through the admin's /meta screen over HTTP (MSET-6). Used by
// tests/e2e/meta-run.sh, so that every Meta value in an end-to-end run comes from the admin and D1,
// never from an environment variable. Saves every admin response (status, headers, body) for the
// sentinel-token grep.
//   node tests/e2e/meta-admin.ts <admin-url> <out-dir> <step>...
// Steps: pixel | pixel-consent-off | token | test-code | remove-pixel
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [BASE, OUT, ...steps] = process.argv.slice(2);
if (!BASE || !OUT || steps.length === 0) throw new Error('usage: meta-admin.ts <admin-url> <out-dir> <step>...');
const PIXEL = process.env['HB_META_E2E_PIXEL'] ?? '';
const TOKEN = process.env['HB_META_E2E_TOKEN'] ?? '';
const TEST_CODE = process.env['HB_META_E2E_TEST_CODE'] ?? '';
mkdirSync(OUT, { recursive: true });

let cookie = '';
let n = 0;
async function call(path: string, form?: Record<string, string>): Promise<{ status: number; body: string; location: string | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method: form ? 'POST' : 'GET',
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const body = await res.text();
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const headers = [...res.headers].map(([k, v]) => `${k}: ${k === 'set-cookie' ? '[session cookie]' : v}`).join('\n');
  writeFileSync(join(OUT, `${String(n++).padStart(2, '0')}-${form ? 'POST' : 'GET'}${path.replace(/[^a-z0-9]+/gi, '_')}.txt`), `${res.status}\n${headers}\n\n${body}`);
  return { status: res.status, body, location: res.headers.get('location') };
}

const login = await call('/__dev/login', { email: 'owner@dev.local' });
if (login.status !== 303) throw new Error(`dev login failed: ${login.status}`);

async function post(path: string, fields: Record<string, string> = {}): Promise<void> {
  const page = await call('/meta');
  if (page.status !== 200) throw new Error(`GET /meta: ${page.status}`);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1];
  if (!csrf) throw new Error('no CSRF token on /meta');
  const res = await call(path, { _csrf: csrf, ...fields });
  if (res.status !== 303) throw new Error(`POST ${path}: ${res.status}`);
  console.log(`admin: POST ${path} -> ${res.status} ${res.location}`);
}

for (const step of steps) {
  if (step === 'pixel') await post('/meta/pixel', { pixelId: PIXEL, consent: 'required' });
  else if (step === 'pixel-consent-off') await post('/meta/pixel', { pixelId: PIXEL, consent: 'off' });
  else if (step === 'token') await post('/meta/token', { token: TOKEN });
  else if (step === 'test-code') await post('/meta/test-code', { testEventCode: TEST_CODE });
  else if (step === 'remove-pixel') await post('/meta/pixel/remove');
  else throw new Error(`unknown step ${step}`);
}
await call('/meta'); // the final state of the screen, saved for the grep
