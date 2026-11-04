import { describe, expect, test } from 'vitest';
import { assertSameOriginPath, isContentLinkHref, isImageKey, isSameOriginPath, isSiteOrigin, isSiteUrl, UnsafeUrlError } from '../src/url.ts';

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

describe('isSiteOrigin / isSiteUrl', () => {
  test.each(['https://hbdestockage.dz', 'https://www.hbdestockage.dz', 'https://hb.example:8443', 'http://localhost:4180', 'http://127.0.0.1'])('origin %j', (o) =>
    expect(isSiteOrigin(o)).toBe(true),
  );
  test.each(['https://hbdestockage.dz/', 'https://hb.dz/shop', 'http://hbdestockage.dz', 'https://user@evil.example', 'https://evil.example\\@hb.dz', 'javascript:x', 'https://localhost'])(
    'not an origin %j',
    (o) => expect(isSiteOrigin(o)).toBe(false),
  );
  test('isSiteUrl', () => {
    expect(isSiteUrl('https://hb.dz/ar/p/x/', 'https://hb.dz')).toBe(true);
    expect(isSiteUrl('https://hb.dz//evil.example/', 'https://hb.dz')).toBe(false);
    expect(isSiteUrl('https://hb.dz.evil.example/ar/', 'https://hb.dz')).toBe(false);
  });
});
