import { describe, expect, test } from 'vitest';
import { resolveInside } from '../scripts/serve-dist.mjs';

const root = '/srv/dist';

describe('resolveInside (local check server containment)', () => {
  test('paths inside dist resolve', () => {
    expect(resolveInside(root, '/')).toBe('/srv/dist');
    expect(resolveInside(root, '/ar/index.html?x=1')).toBe('/srv/dist/ar/index.html');
    expect(resolveInside(root, '/fr/%C3%A9t%C3%A9/')).toBe('/srv/dist/fr/été');
  });
  test.each(['/..%2F..%2Fetc%2Fpasswd', '/ar/..%2F..%2F..%2Fetc/passwd'])('refuses encoded escape %s', (u) => {
    expect(resolveInside(root, u)).toBeNull();
  });
  // The URL parser collapses dot segments (/%2e%2e/) before decoding, and a backslash is just a
  // file-name character on POSIX: whatever comes back must stay inside dist.
  test.each(['/%2e%2e/%2e%2e/etc/passwd', '/..%5c..%5cx', '/../../etc/passwd'])('never resolves outside dist: %s', (u) => {
    const r = resolveInside(root, u);
    expect(r === null || r === root || r.startsWith(`${root}/`)).toBe(true);
  });
  test('bad escapes and NUL are refused', () => {
    expect(resolveInside(root, '/%E0%A4%A')).toBeNull();
    expect(resolveInside(root, '/a%00b')).toBeNull();
  });
  test('a sibling directory with the same prefix is outside', () => expect(resolveInside(root, '/..%2Fdist-evil/x')).toBeNull());
});
