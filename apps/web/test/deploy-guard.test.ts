// WEB-7: a real deploy of a storefront built for a non-production origin is refused; dev and
// --dry-run are never broken. Unit cases + the guard run as wrangler runs it (child process with
// WRANGLER_COMMAND and a parent argv).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { assetsOverride, checkDist, distFor, flagOn, originProblems, publishedOrigins, runMode, type Ancestor } from '../scripts/deploy-guard.ts';

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/deploy-guard.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal built site whose sitemap, robots and pages all publish `origin`. */
function site(origin: string, opts: { pageOrigin?: string } = {}): string {
  const d = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'hb-guard-'));
  dirs.push(d);
  const page = (lang: string) =>
    `<!doctype html><html lang="${lang}"><head><link rel="canonical" href="${opts.pageOrigin ?? origin}/${lang}/">` +
    `<link rel="alternate" hreflang="ar" href="${origin}/ar/"><link rel="alternate" hreflang="fr" href="${origin}/fr/">` +
    `<meta property="og:url" content="${opts.pageOrigin ?? origin}/${lang}/"></head><body><a href="/ar/p/x/">x</a></body></html>`;
  for (const lang of ['ar', 'fr']) {
    mkdirSync(join(d, lang), { recursive: true });
    writeFileSync(join(d, lang, 'index.html'), page(lang));
  }
  writeFileSync(
    join(d, 'sitemap.xml'),
    `<?xml version="1.0"?><urlset><url><loc>${origin}/ar/</loc><xhtml:link rel="alternate" hreflang="fr" href="${origin}/fr/"/></url></urlset>`,
  );
  writeFileSync(join(d, 'robots.txt'), `User-agent: *\nSitemap: ${origin}/sitemap.xml\n`);
  return d;
}

describe('originProblems', () => {
  test.each([
    'http://localhost:8787',
    'https://localhost',
    'http://127.0.0.1:8787',
    'https://192.168.1.10',
    'https://[::1]',
    'https://shop.dz:8443',
    'http://comptoirdeluxe.com',
    'https://comptoirdeluxe.example',
    'https://shop.test',
    'https://shop.local',
    'https://example.com',
    'https://intranet',
  ])('%s is refused', (origin) => {
    expect(originProblems(origin).length).toBeGreaterThan(0);
  });

  test.each(['https://comptoirdeluxe.com', 'https://www.comptoirdeluxe.com', 'https://shop.comptoirdeluxe.com'])('%s is allowed', (origin) => {
    expect(originProblems(origin)).toEqual([]);
  });

  test('a workers.dev origin passes only for a temporary deploy', () => {
    const o = 'https://hb-web.thankful-servant.workers.dev';
    expect(originProblems(o).join()).toMatch(/only for `wrangler deploy --temporary`/);
    expect(originProblems(o, { allowWorkersDev: true })).toEqual([]);
    // never http, even for a temporary deploy
    expect(originProblems('http://hb-web.x.workers.dev', { allowWorkersDev: true }).length).toBeGreaterThan(0);
  });
});

describe('checkDist', () => {
  test('localhost build (the clean-checkout one) is refused, with every published origin read', () => {
    const d = site('http://localhost:8787');
    expect([...publishedOrigins(d)]).toEqual(['http://localhost:8787']);
    expect(checkDist(d).join('\n')).toMatch(/not https|non-default port/);
  });

  test('IP build is refused', () => {
    expect(checkDist(site('https://203.0.113.7')).join('\n')).toMatch(/IP literal/);
  });

  test('proper https production domain is allowed', () => {
    expect(checkDist(site('https://comptoirdeluxe.com'))).toEqual([]);
  });

  test('mixed origins (sitemap prod, pages localhost) are refused', () => {
    const problems = checkDist(site('https://comptoirdeluxe.com', { pageOrigin: 'http://localhost:8787' }));
    expect(problems.join('\n')).toMatch(/more than one site origin/);
  });

  test('no absolute URL at all, or no build, is refused (cannot verify)', () => {
    const d = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'hb-guard-'));
    dirs.push(d);
    writeFileSync(join(d, 'index.html'), '<html><body>x</body></html>');
    expect(checkDist(d).join('\n')).toMatch(/cannot verify/);
    expect(checkDist(join(d, 'missing')).join('\n')).toMatch(/not found/);
  });
});

describe('flagOn: a run is a dry run only in the unambiguous forms (fail safe)', () => {
  test.each([
    [['--dry-run']],
    [['--dry-run', '--env=', '--outdir', 'dist']],
    [['--env=', '--dry-run']],
    [['--dry-run', 'true']],
    [['--dry-run', 'true', '--env=']],
    [['--dry-run=true']],
  ])('%j → dry run', (args) => {
    expect(flagOn(['wrangler', 'deploy', ...args], 'dry-run')).toBe(true);
  });

  test.each([
    [[]],
    [['--dry-run', 'false']], // rev-d WEB-7 r1: yargs reads this as false: a REAL deploy
    [['--dry-run', 'false', '--env=']],
    [['--dry-run', '0']],
    [['--dry-run', 'no']],
    [['--dry-run', 'dist']], // a stray value: not one of the forms we trust
    [['--dry-run=false']],
    [['--dry-run=0']],
    [['--dry-run=']],
    [['--no-dry-run']],
    [['--no-dry-run=true']],
    [['--dryRun']], // alias: wrangler may read it, we do not rely on it
    [['--noDryRun']],
    [['--dry-run', '--dry-run']], // repeated
    [['--dry-run', '--no-dry-run']], // conflicting
    [['--dry-run', '--dry-run=false']],
    [['--dry-run=true', '--dry-run', 'false']],
  ])('%j → NOT a dry run: fully checked', (args) => {
    expect(flagOn(['wrangler', 'deploy', ...args], 'dry-run')).toBe(false);
  });
});

describe('runMode', () => {
  const chain = (...argvs: string[][]): Ancestor[] => argvs.map((argv) => ({ argv, cwd: '/w' }));
  test.each([
    [{}, null, 'local'],
    [{ WRANGLER_COMMAND: 'dev' }, chain(['node', 'wrangler', 'dev']), 'local'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['sh', '-c', 'node scripts/deploy-guard.ts'], ['node', '/x/wrangler-dist/cli.js', 'deploy', '--dry-run', '--env=', '--outdir', 'dist']), 'dry-run'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/node_modules/.bin/wrangler', 'deploy', '--dry-run=true']), 'dry-run'],
    [{ WRANGLER_COMMAND: 'versions upload' }, chain(['node', '/x/bin/wrangler', 'versions', 'upload', '--dry-run']), 'dry-run'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/bin/wrangler', 'deploy', '--env=']), 'deploy'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/bin/wrangler', 'deploy', '--dry-run', 'false']), 'deploy'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/bin/wrangler', 'deploy', '--no-dry-run']), 'deploy'],
    [{ WRANGLER_COMMAND: 'versions upload' }, chain(['node', '/x/bin/wrangler', 'versions', 'upload']), 'deploy'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/bin/wrangler', 'deploy', '--temporary']), 'temporary'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/bin/wrangler', 'deploy', '--temporary', 'false']), 'deploy'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/bin/wrangler', 'deploy', '--temporary', '--no-temporary']), 'deploy'],
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['node', '/x/bin/wrangler', 'deploy', '--dry-run', '--temporary']), 'dry-run'],
    [{ WRANGLER_COMMAND: 'deploy' }, null, 'deploy'], // cannot read the parent: fail closed
    [{ WRANGLER_COMMAND: 'deploy' }, chain(['bash']), 'deploy'], // no wrangler found: fail closed
  ] as const)('%j + %j → %s', (env, ancestors, mode) => {
    expect(runMode(env, ancestors as Ancestor[] | null)).toBe(mode);
  });
});

describe('--assets override: the deployed directory is the one checked', () => {
  test('parsing', () => {
    expect(assetsOverride(['wrangler', 'deploy', '--assets', './public'])).toBe('./public');
    expect(assetsOverride(['wrangler', 'deploy', '--assets=/srv/site'])).toBe('/srv/site');
    expect(assetsOverride(['wrangler', 'deploy'])).toBeUndefined();
  });
  test('resolution: relative to wrangler\'s cwd; absolute as-is; unreadable cwd or missing value refused', () => {
    expect(distFor('/d', null)).toEqual({ dist: '/d' });
    expect(distFor('/d', { argv: ['wrangler', 'deploy'], cwd: '/w' })).toEqual({ dist: '/d' });
    expect(distFor('/d', { argv: ['wrangler', 'deploy', '--assets', 'pub'], cwd: '/w' })).toEqual({ dist: '/w/pub' });
    expect(distFor('/d', { argv: ['wrangler', 'deploy', '--assets=/abs'], cwd: null })).toEqual({ dist: '/abs' });
    expect(distFor('/d', { argv: ['wrangler', 'deploy', '--assets', 'pub'], cwd: null })).toMatchObject({ error: expect.stringContaining('unreadable') });
    expect(distFor('/d', { argv: ['wrangler', 'deploy', '--assets'], cwd: '/w' })).toMatchObject({ error: expect.stringContaining('without a directory') });
  });
});

describe('the guard as wrangler runs it', () => {
  const run = (dist: string, env: Record<string, string>, parentArgs?: string[]) => {
    const childEnv = { ...process.env, ...env };
    if (parentArgs === undefined) return spawnSync(process.execPath, [GUARD, dist], { env: childEnv, encoding: 'utf8' });
    // A parent process whose argv looks like wrangler's, which then runs the guard (like `sh -c`).
    const code = `const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(GUARD)},${JSON.stringify(dist)}],{stdio:'inherit'});process.exit(r.status??1)`;
    return spawnSync(process.execPath, ['-e', code, ...parentArgs], { env: childEnv, encoding: 'utf8' });
  };

  test('real deploy of a localhost build → exit 1 with a clear message', () => {
    const r = run(site('http://localhost:8787'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy', '--env=']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING to deploy/);
    expect(r.stderr).toMatch(/HB_SITE_ORIGIN=https:\/\/<production domain>/);
  });

  test('real deploy of an IP build → exit 1', () => {
    expect(run(site('https://198.51.100.4'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy']).status).toBe(1);
  });

  test('real deploy of a production build → exit 0', () => {
    const r = run(site('https://comptoirdeluxe.com'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/site origin OK \(https:\/\/comptoirdeluxe\.com\)/);
  });

  test('temporary deploy (our only remote measurement) of a build for its workers.dev host → exit 0', () => {
    const r = run(site('https://hb-web.thankful-servant.workers.dev'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy', '--temporary']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/temporary: site origin OK \(https:\/\/hb-web\.thankful-servant\.workers\.dev\)/);
  });

  test('temporary deploy of a localhost build → refused like a real deploy (not treated as a dry run)', () => {
    const r = run(site('http://localhost:8787'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy', '--temporary']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING to deploy/);
  });

  test.each([
    [['--dry-run', 'false']],
    [['--dry-run=false']],
    [['--no-dry-run']],
    [['--dry-run', '0']],
    [['--dry-run', '--dry-run']],
  ])('wrangler deploy %j of a localhost build is a real deploy → exit 1', (flags) => {
    const r = run(site('http://localhost:8787'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy', ...flags]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING/);
  });

  test('real deploy of a workers.dev build → exit 1 (only --temporary may use it)', () => {
    const r = run(site('https://hb-web.thankful-servant.workers.dev'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/workers\.dev is allowed only for/);
  });

  test('--assets <dir> with a bad build is refused even when the default dist is fine', () => {
    const good = site('https://comptoirdeluxe.com');
    const bad = site('http://localhost:8787');
    const r = run(good, { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy', '--assets', bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(bad);
  });

  test('deploy --dry-run of a localhost build → exit 0, problems reported (gate and local checks keep working)', () => {
    const r = run(site('http://localhost:8787'), { WRANGLER_COMMAND: 'deploy' }, ['wrangler', 'deploy', '--dry-run', '--env=', '--outdir', 'dist']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/dry-run: this build could NOT be deployed/);
  });

  test('wrangler dev, or the script by hand → exit 0, no check', () => {
    const d = site('http://localhost:8787');
    expect(run(d, { WRANGLER_COMMAND: 'dev' }, ['wrangler', 'dev']).status).toBe(0);
    const r = run(d, { WRANGLER_COMMAND: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/local run, site-origin check skipped/);
  });
});
