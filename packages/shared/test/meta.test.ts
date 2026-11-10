/**
 * Meta server event (META-2). Digests below were computed outside this code, with
 * `printf '<value>' | sha256sum`, and committed as literals. Meta's published vector comes from
 * .claude/skills/meta-conversions-api/references/normalization.md.
 */
import { describe, expect, test } from 'vitest';
import { META_ID_RE, buildPurchaseEvent, isMetaPixelId, metaPhoneDigits, parseMetaSignals, sha256Hex } from '../src/meta.ts';
import { normalizePhone, type PhoneE164 } from '../src/phone.ts';

const PH_213770123456 = 'dd3dea3b3c8160042672c4dd2b4e95a91dca39dac8b95de1ff3bf63de922d738';
const COUNTRY_DZ = '2a92270185a50d8020949f2cfb2125d1af1c2bd3dd92eada9210fcdb5c4310bf';
const META_US_PHONE = 'e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176';

const e164 = (input: string): PhoneE164 => {
  const r = normalizePhone(input);
  if (!r.ok) throw new Error(`not a phone: ${input}`);
  return r.e164;
};

const input = (over: Partial<Parameters<typeof buildPurchaseEvent>[0]> = {}): Parameters<typeof buildPurchaseEvent>[0] => ({
  ref: 'HB-7K2Q9',
  createdAtMs: 1_790_000_000_987,
  lang: 'ar',
  siteHost: 'comptoirdeluxe.com',
  phoneE164: '+213770123456',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 test',
  signals: { pixel: '100000000000001', fbp: 'fb.1.1596403881668.1116446470', fbc: 'fb.1.1554763741205.IwAR2F4-dbP0l7Mn1' },
  totalDzd: 15200,
  items: [{ variantId: 11, qty: 2 }, { variantId: 12, qty: 1 }],
  ...over,
});

describe('sha256Hex and phone digits', () => {
  test.each([
    ['email', 'john_smith@gmail.com', '62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f'],
    ['phone', '16505551212', META_US_PHONE],
    ['first name', 'mary', '6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec'],
    ['non-Roman name', '정', '8fa8cd9c440be61d0151429310034083132b35975c4bea67fdd74158eb51db14'],
    ['accented name', 'valéry', '08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c'],
    ['date of birth', '19970216', '01acdbf6ec7b4f478a225f1a246e5d6767eeab1a7ffa17f025265b5b94f40f0c'],
    ['country', 'us', '79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621'],
  ])("Meta's published vector: %s", async (_n, normalized, digest) => {
    expect(await sha256Hex(normalized)).toBe(digest);
  });
  test('refuses an empty string', async () => {
    await expect(sha256Hex('')).rejects.toThrow(RangeError);
  });
  test.each(['0770123456', '+213770123456', '٠٧٧٠١٢٣٤٥٦', '00213 770 12 34 56'])('%s hashes to the committed digest', async (typed) => {
    expect(metaPhoneDigits(e164(typed))).toBe('213770123456');
    expect(await sha256Hex(metaPhoneDigits(e164(typed)))).toBe(PH_213770123456);
  });
});

describe('parseMetaSignals', () => {
  const fbp = 'fb.1.1596403881668.1116446470';
  const pixel = '100000000000001';
  test('consent true: signals kept', () => {
    expect(parseMetaSignals({ meta: { consent: true, pixel, fbp, fbc: 'fb.1.1554763741205.AbC_d-E' } })).toEqual({ pixel, fbp, fbc: 'fb.1.1554763741205.AbC_d-E' });
  });
  test('consent true with no ids is still consent', () => {
    expect(parseMetaSignals({ meta: { consent: true, pixel } })).toEqual({ pixel });
  });
  test.each<[string, unknown]>([
    ['missing', undefined],
    ['14 digits', '10000000000001'],
    ['17 digits', '10000000000000001'],
    ['a number', 100000000000001],
    ['a trailing newline', `${pixel}\n`],
    ['empty', ''],
  ])('consent true but the page Pixel ID %s: null (MSET-3)', (_label, p) => {
    expect(parseMetaSignals({ meta: { consent: true, fbp, ...(p === undefined ? {} : { pixel: p }) } })).toBeNull();
  });
  test.each([
    ['absent', {}],
    ['meta a string', { meta: 'true' }],
    ['meta an array', { meta: [true] }],
    ['meta null', { meta: null }],
    ['consent a string', { meta: { consent: 'true' } }],
    ['consent 1', { meta: { consent: 1 } }],
    ['consent false', { meta: { consent: false, pixel: '100000000000001', fbp } }],
    ['not an object', 'meta'],
    ['null body', null],
  ])('%s: no consent', (_n, raw) => {
    expect(parseMetaSignals(raw)).toBeNull();
  });
  test.each([
    ['newline', `${fbp}\n`],
    ['over the cap', `fb.1.1596403881668.${'a'.repeat(481)}`],
    ['wrong prefix', 'fx.1.1596403881668.1'],
    ['a number', 12],
  ])('malformed fbp (%s) is dropped, consent stands', (_n, bad) => {
    expect(parseMetaSignals({ meta: { consent: true, pixel, fbp: bad, fbc: 'fb.1.1554763741205.AbC' } })).toEqual({ pixel, fbc: 'fb.1.1554763741205.AbC' });
  });
  test('480 characters is the cap', () => {
    const id = `fb.1.1596403881668.${'a'.repeat(480)}`;
    expect(META_ID_RE.test(id)).toBe(true);
    expect(parseMetaSignals({ meta: { consent: true, pixel, fbp: id } })).toEqual({ pixel, fbp: id });
  });
});

describe('buildPurchaseEvent', () => {
  test('full payload', async () => {
    expect(await buildPurchaseEvent(input())).toEqual({
      event_name: 'Purchase',
      event_time: 1_790_000_000,
      event_id: 'HB-7K2Q9',
      event_source_url: 'https://comptoirdeluxe.com/ar/order/confirmation/',
      action_source: 'website',
      user_data: {
        ph: [PH_213770123456],
        country: [COUNTRY_DZ],
        client_user_agent: 'Mozilla/5.0 test',
        client_ip_address: '203.0.113.7',
        fbp: 'fb.1.1596403881668.1116446470',
        fbc: 'fb.1.1554763741205.IwAR2F4-dbP0l7Mn1',
      },
      custom_data: {
        currency: 'DZD',
        value: 15200,
        content_type: 'product',
        contents: [{ id: '11', quantity: 2 }, { id: '12', quantity: 1 }],
        order_id: 'HB-7K2Q9',
      },
    });
  });
  test('fbp, fbc and ip are omitted when absent, not sent empty', async () => {
    const e = await buildPurchaseEvent(input({ ip: null, signals: { pixel: '100000000000001' } }));
    expect(Object.keys(e!.user_data).sort()).toEqual(['client_user_agent', 'country', 'ph']);
  });
  test('value is a number, event URL has no query', async () => {
    const e = await buildPurchaseEvent(input({ lang: 'fr' }));
    expect(typeof e!.custom_data.value).toBe('number');
    expect(e!.event_source_url).toBe('https://comptoirdeluxe.com/fr/order/confirmation/');
  });
  test.each([[null], ['']])('no user agent (%j): no event', async (userAgent) => {
    expect(await buildPurchaseEvent(input({ userAgent }))).toBeNull();
  });
});

describe('isMetaPixelId (MSET-1)', () => {
  test.each(['100000000000001', '1234567890123456'])('%s: a Pixel ID', (id) => {
    expect(isMetaPixelId(id)).toBe(true);
  });
  test.each<[string, unknown]>([
    ['all zeros (15)', '000000000000000'],
    ['all zeros (16)', '0000000000000000'],
    ['14 digits', '10000000000001'],
    ['17 digits', '10000000000000001'],
    ['letters', '10000000000000a'],
    ['spaces', ' 100000000000001'],
    ['a trailing newline', '100000000000001\n'],
    ['Eastern Arabic digits', '١٠٠٠٠٠٠٠٠٠٠٠٠٠١'],
    ['a number', 100000000000001],
    ['empty', ''],
    ['null', null],
  ])('%s: refused', (_label, id) => {
    expect(isMetaPixelId(id)).toBe(false);
  });
});
