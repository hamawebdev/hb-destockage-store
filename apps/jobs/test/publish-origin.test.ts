// JOBS-8: publish.ts uses the catalogue's site-origin rule (refused before any D1/R2 is touched).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const publish = (origin: string) =>
  spawnSync(process.execPath, ['scripts/publish.ts', '--site-origin', origin], { cwd: APP, encoding: 'utf8', env: { ...process.env, HB_SITE_ORIGIN: '' } });

describe('publish --site-origin (pagedata parseSiteOrigin, publish mode)', { timeout: 60_000 }, () => {
  test.each([
    ['IPv4 literal', 'https://127.0.0.1'],
    ['IPv6 literal', 'https://[::1]'],
    ['localhost', 'https://localhost'],
    ['*.localhost', 'https://shop.localhost'],
    ['*.local', 'https://shop.local'],
    ['*.internal', 'https://x.internal'],
    ['*.test', 'https://a.test'],
    ['port', 'https://hbdestockagedz.com:8443'],
    ['path', 'https://hbdestockagedz.com/fr'],
    ['credentials', 'https://user@hbdestockagedz.com'],
    ['http', 'http://hbdestockagedz.com'],
    ['uppercase', 'https://HBdestockagedz.com'],
  ])('refuses %s (exit 2, reason printed)', (_l, origin) => {
    const r = publish(origin);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refused: \S/);
  });

  test('--budget accepts only enforce, report or skip', () => {
    const r = spawnSync(process.execPath, ['scripts/publish.ts', '--budget', 'off', '--site-origin', 'https://comptoirdeluxe.com'], { cwd: APP, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--budget must be enforce, report or skip');
  });

  test('missing origin is refused too', () => {
    const r = spawnSync(process.execPath, ['scripts/publish.ts'], { cwd: APP, encoding: 'utf8', env: { ...process.env, HB_SITE_ORIGIN: '' } });
    expect(r.status).toBe(2);
  });
});
