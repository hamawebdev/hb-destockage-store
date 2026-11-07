// Root / → /ar/ is a static redirect (Workers static assets _redirects), never Accept-Language based
// (CLAUDE.md; lead ruling: 302, browsers cache a 301 forever).
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const rules = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

test('exactly one rule: / → /ar/ 302', () => expect(rules.map((r) => r.split(/\s+/))).toEqual([['/', '/ar/', '302']]));
test('no conditional rule (language, country, cookie): only source, target, status', () => {
  for (const r of rules) {
    expect(r.split(/\s+/)).toHaveLength(3);
    expect(r).not.toMatch(/Language|Country|Cookie|accept/i);
  }
});
