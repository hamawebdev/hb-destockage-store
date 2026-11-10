import { describe, expect, test } from 'vitest';
import { assertSameOriginPath, isContentLinkHref, isImageKey, isPublicSiteOrigin, isSameOriginPath, isSiteOrigin, isSiteUrl, parseSiteOrigin, UnsafeUrlError } from '../src/url.ts';

/** Strings that browsers resolve off-site or to script (CAT-1 r1 Important 1 + lead's list). */
export const OFF_SITE: readonly string[] = [
  '//evil.example/',
  '/\\evil.example',
  '/\\\\evil.example',
  '\\/evil.example',
  '/\t/evil.example',
  '/\n/evil.example',
  '/\r/evil.example',
  '/ /evil.example',
  ' /fr/',
  '/fr/ ',
  '/%2f%2fevil.example',
  '/%5cevil.example',
  '/fr/../../x',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'jAvAsCrIpT:alert(1)',
  'data:text/html,x',
  'https://evil.example/',
  'HTTPS://wa.me/213779942022',
  'https://WA.ME/213779942022',
  'https://wa.me.evil.example/213779942022',
  'https://wa.me/213779942022@evil.example',
  'https://wa.me/213779942022/../x',
  'http://wa.me/213779942022',
  'tel:+213 560',
  'tel:javascript:alert(1)',
  'TEL:+213560417403',
  '/fr/‮/',
  '/fr/\u0000',
  '',
];

describe('isContentLinkHref / isSameOriginPath', () => {
  test.each(OFF_SITE)('rejects %j', (s) => {
    expect(isContentLinkHref(s)).toBe(false);
    expect(isSameOriginPath(s)).toBe(false);
  });
  test.each(['/', '/ar/', '/ar/p/pack-luxe-4-en-1/', '/img/0a1b2c3d4e5f6a7b-360.avif', '/ar/404.html', '/search/ar.json', '/fr/livraison/#frais'])(
    'accepts path %j',
    (s) => {
      expect(isSameOriginPath(s)).toBe(true);
      expect(isContentLinkHref(s)).toBe(true);
    },
  );
  test.each(['tel:+213560417403', 'tel:0560417403', 'https://wa.me/213779942022', 'https://wa.me/213779942022?text=Bonjour%20HB'])('accepts external %j', (s) => {
    expect(isContentLinkHref(s)).toBe(true);
    expect(isSameOriginPath(s)).toBe(false);
  });
  test('assertSameOriginPath throws UnsafeUrlError', () => {
    expect(() => assertSameOriginPath('//evil.example/', 'x')).toThrow(UnsafeUrlError);
    expect(assertSameOriginPath('/ar/', 'x')).toBe('/ar/');
  });
});

describe('isImageKey', () => {
  test.each(['pack-a-3-en-1-colonne-piano-led/1.jpg', 'fixture/tablier.jpg', 'a.jpg'])('accepts %j', (k) => expect(isImageKey(k)).toBe(true));
  test.each(['../x.jpg', 'a/../b.jpg', '/etc/passwd', 'https://x/y.jpg', 'a\\b.jpg', 'a//b.jpg', '.x/y.jpg', 'A.jpg', 'a b.jpg', ''])('rejects %j', (k) =>
    expect(isImageKey(k)).toBe(false),
  );
});

describe('parseSiteOrigin (publish builds need a public https origin)', () => {
  test.each([
    'http://comptoirdeluxe.com',
    'https://127.0.0.1',
    'https://10.1',
    'https://192.168.1.10',
    'https://[::1]',
    'https://[2001:db8::1]',
    'https://localhost',
    'https://shop.localhost',
    'https://hb.local',
    'https://hb.internal',
    'https://hb.test',
    'https://comptoirdeluxe.example',
    'https://hb.invalid',
    'https://example.com',
    'https://www.example.org',
    'https://shop.example.net',
    'https://comptoirdeluxe.com:8443',
    'https://comptoirdeluxe.com/shop',
    'https://comptoirdeluxe.com?x=1',
    'https://comptoirdeluxe.com#x',
    'https://user@comptoirdeluxe.com',
    'https://user:pw@comptoirdeluxe.com',
    'https://comptoirdeluxe',
    'https://COMPTOIRDELUXE.COM',
    'https://-bad.dz',
    'http://localhost:8787',
    'http://127.0.0.1:4180',
    'javascript:alert(1)',
    '',
  ])('publish refuses %j', (o) => {
    const r = parseSiteOrigin(o, { publish: true });
    expect(r.ok).toBe(false);
    expect(isPublicSiteOrigin(o)).toBe(false);
  });
  test.each(['https://comptoirdeluxe.com', 'https://www.comptoirdeluxe.com', 'https://comptoir-de-luxe.com', 'https://myexample.com'])(
    'publish accepts %j',
    (o) => {
      expect(parseSiteOrigin(o, { publish: true })).toEqual({ ok: true, origin: o });
      expect(isSiteOrigin(o)).toBe(true);
    },
  );
  test('a trailing slash is normalised', () => {
    expect(parseSiteOrigin('https://comptoirdeluxe.com/', { publish: true })).toEqual({ ok: true, origin: 'https://comptoirdeluxe.com' });
  });
  test.each(['http://localhost:8787', 'http://localhost', 'http://127.0.0.1', 'http://127.0.0.1:4180', 'https://comptoirdeluxe.example'])(
    'non-publish also accepts %j (local dev origin; the fixture origin)',
    (o) => {
      expect(parseSiteOrigin(o, { publish: false }).ok).toBe(true);
      expect(isSiteOrigin(o)).toBe(true);
    },
  );
  test('publish refusal of reserved names cites RFC 2606/6761; fixture mode keeps its .example origin', async () => {
    expect(parseSiteOrigin('https://comptoirdeluxe.example', { publish: true })).toEqual({
      ok: false,
      reason: 'reserved documentation/invalid hostname (RFC 2606/6761): comptoirdeluxe.example',
    });
    const { siteOriginFromEnv, FIXTURE_ORIGIN } = await import('../src/sources.ts');
    expect(siteOriginFromEnv({ HB_SNAPSHOT: 'fixture' })).toBe(FIXTURE_ORIGIN);
    expect(() => siteOriginFromEnv({ HB_SNAPSHOT: 'seed', HB_PUBLISH: '1', HB_SITE_ORIGIN: FIXTURE_ORIGIN })).toThrow(/RFC 2606/);
  });
  test.each(['https://127.0.0.1', 'https://localhost', 'https://hb.test', 'http://comptoirdeluxe.com', 'https://hb.dz:8443'])('non-publish still refuses %j', (o) => {
    expect(parseSiteOrigin(o, { publish: false }).ok).toBe(false);
    expect(isSiteOrigin(o)).toBe(false);
  });
});

describe('isSiteUrl', () => {
  test('absolute URL on the origin only', () => {
    expect(isSiteUrl('https://hb.dz/ar/p/x/', 'https://hb.dz')).toBe(true);
    expect(isSiteUrl('https://hb.dz//evil.example/', 'https://hb.dz')).toBe(false);
    expect(isSiteUrl('https://hb.dz.evil.example/ar/', 'https://hb.dz')).toBe(false);
    expect(isSiteUrl('https://127.0.0.1/ar/', 'https://127.0.0.1')).toBe(false);
  });
});
