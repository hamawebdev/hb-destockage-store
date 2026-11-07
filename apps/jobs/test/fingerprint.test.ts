// The real fingerprint over a scratch git repository (Node).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { budgetVerdict, buildFingerprint, stableStringify, TEMPLATE_PATHS } from '../scripts/lib/fingerprint.ts';

let repo: string;
const PATHS = ['apps/storefront', 'tools/measure'];
const git = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const manifest = () => join(repo, 'apps/storefront/.catalog/image-manifest.json');
const fpNow = () => buildFingerprint(repo, manifest(), PATHS);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'hb-fp-'));
  git('init', '-q');
  mkdirSync(join(repo, 'apps/storefront/src'), { recursive: true });
  mkdirSync(join(repo, 'apps/storefront/.catalog'), { recursive: true });
  mkdirSync(join(repo, 'tools/measure'), { recursive: true });
  writeFileSync(join(repo, 'apps/storefront/.gitignore'), '/.catalog/\n/public/img/\n');
  writeFileSync(join(repo, 'apps/storefront/src/Page.astro'), '<h1>v1</h1>\n');
  writeFileSync(join(repo, 'tools/measure/config.ts'), 'export const HTML_BR = 14336;\n');
  writeFileSync(manifest(), JSON.stringify({ 'a.jpg': { key: 'a.jpg', hash: 'h1', candidates: [360, 720] } }));
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('TEMPLATE_PATHS (review r1 nit)', () => {
  test('cover the snapshot mapping, the publish pipeline and the package manifests', () => {
    for (const p of ['packages/db/src', 'apps/jobs/scripts/publish.ts', 'apps/jobs/src/publish', 'packages/catalog/package.json', 'packages/shared/package.json', 'apps/web', 'tools/measure']) {
      expect(TEMPLATE_PATHS).toContain(p);
    }
  });
});

describe('budgetVerdict', () => {
  test('takes the BUDGET line, not the --static-only footnote (found in the e2e run)', () => {
    expect(budgetVerdict('table…\nBUDGET OK: 105 pages, 16 rules\n\n(runtime pass skipped: --static-only; not valid for the gate)\n')).toBe('BUDGET OK: 105 pages, 16 rules');
    expect(budgetVerdict('BUDGET FAILED: 2 violations (html-br: 2)\n')).toBe('BUDGET FAILED: 2 violations (html-br: 2)');
    expect(budgetVerdict('something else\n')).toBe('something else');
  });
});

describe('buildFingerprint', () => {
  test('stable: same tree and manifest → same fingerprint; manifest key order does not matter', () => {
    const a = fpNow();
    writeFileSync(manifest(), JSON.stringify({ 'a.jpg': { candidates: [360, 720], hash: 'h1', key: 'a.jpg' } }));
    expect(fpNow()).toEqual(a);
    expect(a.dirty).toBe(false);
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
  test('an image digest change changes `images` only', () => {
    const a = fpNow();
    writeFileSync(manifest(), JSON.stringify({ 'a.jpg': { key: 'a.jpg', hash: 'h2', candidates: [360, 720] } }));
    const b = fpNow();
    expect(b.images).not.toBe(a.images);
    expect(b.template).toBe(a.template);
  });
  test('a committed template change and a budget-threshold change change `template`', () => {
    const a = fpNow();
    writeFileSync(join(repo, 'apps/storefront/src/Page.astro'), '<h1>v2</h1>\n');
    git('commit', '-qam', 'tpl');
    const b = fpNow();
    expect(b.template).not.toBe(a.template);
    writeFileSync(join(repo, 'tools/measure/config.ts'), 'export const HTML_BR = 20000;\n');
    git('commit', '-qam', 'loosen');
    expect(fpNow().template).not.toBe(b.template);
  });
  test('uncommitted edits or new source files → dirty; generated (gitignored) outputs do not count', () => {
    mkdirSync(join(repo, 'apps/storefront/public/img'), { recursive: true });
    writeFileSync(join(repo, 'apps/storefront/public/img/x.avif'), 'generated');
    expect(fpNow().dirty).toBe(false);
    writeFileSync(join(repo, 'apps/storefront/src/Page.astro'), '<h1>edited</h1>\n');
    expect(fpNow().dirty).toBe(true);
    git('checkout', '--', 'apps/storefront/src/Page.astro');
    writeFileSync(join(repo, 'apps/storefront/src/New.astro'), 'new');
    expect(fpNow().dirty).toBe(true);
  });
});
