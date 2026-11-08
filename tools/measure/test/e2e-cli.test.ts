/** MEAS-4: the e2e entry point (node tools/measure/src/e2e/cli.ts). */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_CONFIG, e2eCommand, skippedIn, verdict } from '../src/e2e/cli.ts';
import { REPO_ROOT } from '../src/lib/paths.ts';

describe('e2e entry point', () => {
  it('runs vitest on tests/e2e with the results file in HB_E2E_OUT, passing extra args through', () => {
    const c = e2eCommand(['admin-auth'], { HB_E2E_OUT: '/x/out' });
    expect(E2E_CONFIG).toBe(path.join(REPO_ROOT, 'tests/e2e/vitest.config.ts'));
    expect(c.bin).toBe(path.join(REPO_ROOT, 'node_modules/.bin/vitest'));
    expect(c.args).toEqual(['run', '--config', E2E_CONFIG, '--outputFile.json=/x/out/e2e-results.json', 'admin-auth']);
    expect(c.env['HB_E2E_OUT']).toBe('/x/out');
  });

  it('defaults the output to <artifacts>/e2e', () => {
    const prev = process.env['HB_ARTIFACTS'];
    process.env['HB_ARTIFACTS'] = '/a'; // read by artifactsRoot()
    const c = e2eCommand([], {});
    if (prev === undefined) delete process.env['HB_ARTIFACTS']; else process.env['HB_ARTIFACTS'] = prev;
    expect(c.env['HB_E2E_OUT']).toBe('/a/e2e');
    expect(c.args).toContain('--outputFile.json=/a/e2e/e2e-results.json');
  });

  it('lists skipped specs and fails a run with skips unless HB_E2E_ALLOW_SKIP=1 (rev-a r1 nit)', () => {
    const report = { testResults: [{ assertionResults: [
      { status: 'passed', fullName: 'a' },
      { status: 'pending', fullName: 'order [waiting: POST /api/order not in this checkout]' },
      { status: 'skipped', fullName: 'geo [waiting: data/geo]' },
    ] }] };
    const skipped = skippedIn(report);
    expect(skipped).toEqual(['order [waiting: POST /api/order not in this checkout]', 'geo [waiting: data/geo]']);
    const strictish = verdict(0, skipped, false);
    expect(strictish.code).toBe(1);
    expect(strictish.lines[0]).toBe('e2e: 2 SKIPPED:');
    expect(verdict(0, skipped, true).code).toBe(0);
    expect(verdict(1, skipped, false).code).toBe(1); // a real failure keeps vitest's code
    expect(verdict(0, [], false)).toEqual({ code: 0, lines: [] });
    expect(skippedIn({})).toEqual([]);
  });
});
