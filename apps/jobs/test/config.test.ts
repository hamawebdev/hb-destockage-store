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

  test('no top-level vars: no ENV/development default, OTP flag off, no notification addresses', () => {
    const vars = (cfg['vars'] ?? {}) as Record<string, unknown>;
    expect(vars['ENV']).toBeUndefined();
    expect(JSON.stringify(vars)).not.toMatch(/development|localhost/i);
    expect(vars['SMS_OTP_ENABLED']).toBeUndefined();
    expect(vars['NOTIFY_EMAIL_FROM']).toBeUndefined();
    expect(vars['NOTIFY_EMAIL_TO']).toBeUndefined();
    expect(vars['TELEGRAM_BOT_TOKEN']).toBeUndefined(); // secrets never in config
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
