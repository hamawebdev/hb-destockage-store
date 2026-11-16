// The deployed configuration is the production one: no development defaults in wrangler.jsonc
// (class check from rev-f's apps/web finding). Dev-only settings live in the dev script / .dev.vars.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc'), 'utf8');
// JSONC → JSON: this file keeps comments on their own lines (asserted below).
const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;

describe('apps/jobs/wrangler.jsonc: production by default', () => {
  test('parses, and comments are whole-line only (so the parse above is faithful)', () => {
    expect(cfg['name']).toBe('hb-jobs');
    expect(raw.split('\n').filter((l) => /\S.*\/\/(?!\/)/.test(l) && !/^\s*\/\//.test(l) && !/"\$schema"/.test(l))).toEqual([]);
  });

  test('no top-level vars: ENV only the fail-safe production default, OTP flag off, no notification addresses', () => {
    const vars = (cfg['vars'] ?? {}) as Record<string, unknown>;
    // D-010: courier and Google HTTP is held to loopback unless ENV is exactly "production", so the
    // deployed jobs Worker declares it, as admin and web do; `npm run dev` passes ENV:development.
    expect([undefined, 'production']).toContain(vars['ENV']);
    expect(JSON.stringify(vars)).not.toMatch(/development|localhost/i);
    expect(vars['SMS_OTP_ENABLED']).toBeUndefined();
    expect(vars['NOTIFY_EMAIL_FROM']).toBeUndefined();
    expect(vars['NOTIFY_EMAIL_TO']).toBeUndefined();
    // TGS-2: Telegram has no variable or secret in this Worker at all (the admin is the only source),
    // and the stand-in URL is a local-only setting.
    expect(Object.keys(vars).filter((k) => /telegram/i.test(k))).toEqual([]);
    expect(raw).not.toMatch(/TELEGRAM_(BOT_TOKEN|CHAT_ID|STANDIN_URL)/);
  });

  test('no env overrides that could flip behaviour; the "dev" block only sets the local port', () => {
    expect(cfg['env']).toBeUndefined();
    expect(Object.keys((cfg['dev'] ?? {}) as object)).toEqual(['port']);
  });

  test('the backups bucket is a private R2 binding (no public domain configured here)', () => {
    expect(cfg['r2_buckets']).toEqual([{ binding: 'BACKUPS', bucket_name: 'hb-backups' }]);
    expect(JSON.stringify(cfg)).not.toMatch(/r2\.dev|custom_domain/);
  });
});

describe('TGS-2: the Telegram env secrets are gone from the jobs Worker', () => {
  const read = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
  test.each(['src/env.ts', 'src/index.ts', 'src/notify/providers.ts', 'src/notify/telegram.ts', '.dev.vars.example'])('%s names no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID', (rel) => {
    expect(read(rel)).not.toMatch(/TELEGRAM_(BOT_TOKEN|CHAT_ID)/);
  });
  test('.dev.vars.example offers only the commented loopback stand-in line', () => {
    const lines = read('.dev.vars.example').split('\n').filter((l) => /TELEGRAM_/.test(l));
    expect(lines).toEqual(['# TELEGRAM_STANDIN_URL=http://127.0.0.1:4430']);
  });
});
