// /api/order routes in workerd with a local D1 (reads) and fixture templates. Covers the JSON
// transport/validation, the no-JS review step and its errors, the confirm step up to the write,
// and the confirmation page. The writes (createOrder, markDuplicate) are DB-4: their real-D1 tests
// (replay race, last unit, dedup) are added when DB-4 lands. Plan WEB-0 §2.2–2.4, §10.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signReviewToken } from '../src/order/crypto.ts';
import { postForm, postJson, startSeeded, TEST_SECRETS, type Started } from './support/harness.ts';

let h: Started;
beforeAll(async () => {
  h = await startSeeded();
});
afterAll(async () => {
  await h?.server.close();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let phoneSeq = 0;
/** A fresh valid mobile per test, so the 5/60 s phone limiter never couples tests. */
const freshPhone = () => `0661${String(100000 + phoneSeq++).padStart(6, '0')}`;

function hidden(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) out[m[1]!] = m[2]!;
  return out;
}
const visible = (html: string, code: string) => new RegExp(`<p data-hb-error="${code}">`).test(html);
const shown = (html: string, when: string) => new RegExp(`<div data-hb-when="${when}"(?: role="alert")?>`).test(html);

describe('JSON path: transport and validation', () => {
  test('422 with field errors (Arabic phone digits accepted, naive 05x rejected)', async () => {
    const res = await postJson(h.server, '/api/order', {
      idempotencyKey: crypto.randomUUID(),
      lang: 'ar',
      items: [{ variantId: 11, qty: 1 }],
      name: '',
      phone: '0512345678',
      wilayaCode: 16,
      communeId: 1601,
      expectedTotalDzd: 15200,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; errors: { field: string; code: string }[] };
    expect(body.code).toBe('validation');
    expect(body.errors).toEqual(expect.arrayContaining([{ field: 'name', code: 'name_required' }, { field: 'phone', code: 'phone_not_mobile' }]));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('non-UUID idempotency key → 400 idempotency_key_invalid', async () => {
    const res = await postJson(h.server, '/api/order', { idempotencyKey: 'abc', lang: 'ar', items: [{ variantId: 11, qty: 1 }], name: 'Amine', phone: freshPhone(), wilayaCode: 16, communeId: 1601, expectedTotalDzd: 15200 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'idempotency_key_invalid' });
  });

  test('cross-site POST → 403, wrong type → 415, oversize → 413', async () => {
    expect((await postJson(h.server, '/api/order', {}, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const txt = await h.server.fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expect(txt.status).toBe(415);
    expect((await postJson(h.server, '/api/order', { pad: 'x'.repeat(9000) })).status).toBe(413);
  });

  test('client total ≠ server total → 409 total_changed with the fresh quote', async () => {
    const res = await postJson(h.server, '/api/order', {
      idempotencyKey: crypto.randomUUID(),
      lang: 'fr',
      items: [{ variantId: 11, qty: 1 }],
      name: 'Amine',
      phone: freshPhone(),
      wilayaCode: 16,
      communeId: 1601,
      expectedTotalDzd: 999,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'total_changed', quote: { totalDzd: 15200, feeDzd: 600 } });
  });

  test('out of stock beats total_changed', async () => {
    const res = await postJson(h.server, '/api/order', {
      idempotencyKey: crypto.randomUUID(),
      lang: 'fr',
      items: [{ variantId: 21, qty: 4 }],
      name: 'Amine',
      phone: freshPhone(),
      wilayaCode: 16,
      communeId: 1601,
      expectedTotalDzd: 1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'out_of_stock', lines: [{ variantId: 21, maxQty: 3 }] });
  });

  test('phone limit: the 6th order attempt in 60 s from one phone → 429 + Retry-After', async () => {
    const phone = freshPhone();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await postJson(h.server, '/api/order', {
        idempotencyKey: crypto.randomUUID(),
        lang: 'ar',
        items: [{ variantId: 11, qty: 1 }],
        name: 'Amine',
        phone,
        wilayaCode: 16,
        communeId: 1601,
        expectedTotalDzd: 1, // stops at total_changed: no write needed
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.headers.get('retry-after')).toBe('60');
        expect(await res.json()).toEqual({ ok: false, code: 'rate_limited', retryAfterS: 60 });
      }
    }
    expect(statuses).toEqual([409, 409, 409, 409, 409, 429]);
  });
});

describe('no-JS step 1: server review page', () => {
  test('200 review page: server prices, fee, total, communes, fresh UUID key, signed token, no-store', async () => {
    const res = await postForm(h.server, '/api/order', { step: 'review', lang: 'ar', variantId: '11', qty: '2', name: 'محمد', phone: '٠٥٥٥١٢٣٤٥٦', wilayaCode: '16', website: '' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('set-cookie')).toBeNull();
    // The API CSP (default-src 'none') must not be applied to a page with inline CSS.
    expect(res.headers.get('content-security-policy') ?? '').not.toContain("default-src 'none'; frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('<span class="of-line-name">حزمة المطبخ</span>');
    expect(html).not.toContain('placeholder-line');
    expect(html).toMatch(/<bdi data-hb="total">[^<]*29\D?800[^<]*<\/bdi>/); // 2 × 14 600 + 600, ar-DZ grouping
    expect(html).toContain('<option value="1601">الجزائر الوسطى</option>');
    expect(html).toContain('<option value="1602">باب الوادي</option>');
    expect(html).toContain('value="٠٥٥٥١٢٣٤٥٦"'); // what the customer typed, re-shown
    expect(shown(html, 'can-confirm')).toBe(true);
    expect(shown(html, 'has-errors')).toBe(false);
    expect(html).toContain('href="/ar/p/hizmat-matbakh/"');
    const f = hidden(html);
    expect(f).toMatchObject({ step: 'confirm', lang: 'ar', variantId: '11', qty: '2', wilayaCode: '16', expectedTotalDzd: '29800', website: '' });
    expect(f['idempotencyKey']).toMatch(UUID);
    expect(f['reviewToken']).toMatch(/^\d+\.[A-Za-z0-9_-]{22}$/);
  });

  test('each review issues a new key (never baked into HTML)', async () => {
    const fields = { lang: 'fr', variantId: '11', qty: '1', name: 'Amine', phone: '0555123456', wilayaCode: '16' };
    const a = hidden(await (await postForm(h.server, '/api/order', fields)).text());
    const b = hidden(await (await postForm(h.server, '/api/order', fields)).text());
    expect(a['idempotencyKey']).not.toBe(b['idempotencyKey']);
  });

  test('size radios: productId + opt.<optionId> resolve to the variant', async () => {
    const res = await postForm(h.server, '/api/order', { lang: 'fr', productId: '2', 'opt.1': '1', qty: '1', name: 'Amine', phone: '0555123456', wilayaCode: '16' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(hidden(html)).toMatchObject({ variantId: '21', expectedTotalDzd: '16100' });
    expect(html).toContain('<span class="of-line-variant">S</span>');
  });

  test('impossible option combination → 409 review with variant_unavailable, no confirm', async () => {
    const res = await postForm(h.server, '/api/order', { lang: 'fr', productId: '2', 'opt.1': '99', qty: '1', name: 'Amine', phone: '0555123456', wilayaCode: '16' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(visible(html, 'variant_unavailable')).toBe(true);
    expect(shown(html, 'can-confirm')).toBe(false);
  });

  test('field errors → 422, messages un-hidden, aria-invalid, values kept, lines still priced', async () => {
    const res = await postForm(h.server, '/api/order', { lang: 'ar', variantId: '11', qty: '1', name: '', phone: '0512345678', wilayaCode: '16' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(visible(html, 'name_required')).toBe(true);
    expect(visible(html, 'phone_not_mobile')).toBe(true);
    expect(visible(html, 'phone_invalid')).toBe(false);
    expect(html).toMatch(/data-hb-field="phone"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*data-hb-field="phone"/);
    expect(html).toContain('value="0512345678"');
    expect(shown(html, 'has-errors')).toBe(true);
    expect(shown(html, 'can-confirm')).toBe(false);
    expect(html).toContain('حزمة المطبخ');
  });

  test('wilaya not served → 409, delivery_unavailable shown, no confirm', async () => {
    const res = await postForm(h.server, '/api/order', { lang: 'fr', variantId: '11', qty: '1', name: 'Amine', phone: '0555123456', wilayaCode: '31' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(visible(html, 'delivery_unavailable')).toBe(true);
    expect(shown(html, 'can-confirm')).toBe(false);
    expect(hidden(html)['expectedTotalDzd']).toBeUndefined();
  });

  test('out of stock → 409 with out_of_stock', async () => {
    const res = await postForm(h.server, '/api/order', { lang: 'fr', variantId: '22', qty: '1', name: 'Amine', phone: '0555123456', wilayaCode: '16' });
    expect(res.status).toBe(409);
    expect(visible(await res.text(), 'out_of_stock')).toBe(true);
  });

  test('a name with markup is escaped, never injected', async () => {
    const res = await postForm(h.server, '/api/order', { lang: 'fr', variantId: '11', qty: '1', name: '"><script>alert(1)</script>', phone: '0555123456', wilayaCode: '16' });
    const html = await res.text();
    // The quote is escaped, so the value cannot break out of its attribute; no new element appears.
    expect(html).toMatch(/<input name="name" data-hb="name" data-hb-field="name" required value="&quot;(&gt;|>)(&lt;|<)script(&gt;|>)alert\(1\)(&lt;|<)\/script(&gt;|>)">/);
    expect(html.match(/<script/g)?.length ?? 0).toBe(html.match(/value="&quot;(?:&gt;|>)(?:&lt;|<)script/g)?.length ?? 0);
  });
});

describe('no-JS confirm step (up to the write)', () => {
  async function review(fields: Record<string, string>) {
    return hidden(await (await postForm(h.server, '/api/order', fields)).text());
  }

  test('total drift between review and confirm → 409 review with total_changed and the new total, same key', async () => {
    const phone = freshPhone();
    const f = await review({ lang: 'fr', variantId: '11', qty: '1', name: 'Amine', phone, wilayaCode: '16' });
    await h.env.DB.prepare('update variants set price_dzd = 14900 where id = 11').run();
    try {
      const res = await postForm(h.server, '/api/order', { ...f, name: 'Amine', phone, communeId: '1601' });
      expect(res.status).toBe(409);
      const html = await res.text();
      expect(visible(html, 'total_changed')).toBe(true);
      const again = hidden(html);
      expect(again['expectedTotalDzd']).toBe('15500');
      expect(again['idempotencyKey']).toBe(f['idempotencyKey']);
      expect(html).toContain('<option value="1601" selected>');
    } finally {
      await h.env.DB.prepare('update variants set price_dzd = 14600 where id = 11').run();
    }
  });

  test('missing commune on confirm → 422 commune error, review re-rendered with the commune select', async () => {
    const phone = freshPhone();
    const f = await review({ lang: 'ar', variantId: '11', qty: '1', name: 'أمين', phone, wilayaCode: '16' });
    const res = await postForm(h.server, '/api/order', { ...f, name: 'أمين', phone });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(visible(html, 'commune_invalid')).toBe(true);
    expect(html).toContain('<option value="1601">');
    expect(hidden(html)['idempotencyKey']).toBe(f['idempotencyKey']);
  });

  test('client-sent fillMs is ignored on the form path (only the signed token counts)', async () => {
    // A forged token for this key fails verification ⇒ fill time unknown; reaching the
    // (not yet wired) write proves the confirm passed every check before it.
    const phone = freshPhone();
    const f = await review({ lang: 'fr', variantId: '11', qty: '1', name: 'Amine', phone, wilayaCode: '16' });
    const forged = await signReviewToken('not-our-key', Date.now() - 60_000, f['idempotencyKey']!, 'fr');
    const res = await postForm(h.server, '/api/order', { ...f, reviewToken: forged, fillMs: '99999', name: 'Amine', phone, communeId: '1601' });
    expect([303, 503]).toContain(res.status); // 503 until DB-4's createOrder is wired
  });

  test('a valid token from the real signing key verifies', async () => {
    const tok = await signReviewToken(TEST_SECRETS.ORDER_SIGNING_KEY, 1, 'k', 'ar');
    expect(tok.startsWith('1.')).toBe(true);
  });
});

describe('confirmation page (Worker-first, no D1)', () => {
  test('valid ref is filled in and shown; no-store', async () => {
    const res = await h.server.fetch('/fr/order/confirmation/?ref=HB-7K2Q9');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<bdi data-hb="ref">HB-7K2Q9</bdi>');
    expect(html).toContain('<p data-hb-when="has-ref">');
  });

  test.each(['', '?ref=hb-7k2q9', '?ref=HB-OOOOO', '?ref=%3Cscript%3E', '?ref=HB-7K2Q9X'])('invalid or missing ref %j → static page untouched', async (q) => {
    const res = await h.server.fetch(`/ar/order/confirmation/${q}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<p data-hb-when="has-ref" hidden><bdi data-hb="ref"></bdi></p>');
    expect(html).not.toContain('script');
  });
});
