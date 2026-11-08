import { describe, expect, test } from 'vitest';
import { errorLine } from '../scripts/lib/output.ts';

describe('errorLine (JOBS-8: real cause, not npm noise)', () => {
  test('a failed astro build reports the pre-build failure, not npm\'s trailer or a stack frame', () => {
    const out = [
      'd1 snapshots need --originals <dir>: the R2 objects copied to a directory under their keys',
      '06:47:15 [ERROR] [hb-prebuild] An unhandled error occurred while running the "astro:build:start" hook',
      'catalogue pre-build failed (exit 2); see its output above',
      '  at astro:build:start (file:///x/hb-prebuild.mjs:51:35)',
      'npm error Lifecycle script `build` failed with error:',
      'npm error command sh -c astro build',
    ].join('\n');
    expect(errorLine(out)).toBe('catalogue pre-build failed (exit 2); see its output above');
  });
  test('falls back to the last line when nothing looks like an error', () => {
    expect(errorLine('one\ntwo\n')).toBe('two');
    expect(errorLine('')).toBe('');
  });
});
