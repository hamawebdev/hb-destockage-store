// Parity of public/js/order.js helpers with @hb/shared (the client hint must agree with the server).
// order.js is plain JS served as-is (SHELL-0 rule 2), so it cannot import @hb/shared; these tests keep it honest.
import { describe, expect, it } from 'vitest';
import { DZ_MOBILE_NSN_PATTERN, normalizePhone, toAsciiDigits } from '@hb/shared/phone';
import { formatPrice } from '@hb/shared/format';
import { applyLines, buildRows, fmt, parseVariants, phoneError, postRetrying, submissionKeys, toAscii, uuid } from '../../../../public/js/order.js';

const P = DZ_MOBILE_NSN_PATTERN;

// Inputs on which every SHARED-1/SHARED-2 version agrees (accept/reject and code).
const COMMON = [
  '0555123456', '0661234567', '0771234567', '0540123456', '0560417403', '+213555123456', '00213555123456',
  '213555123456', '+213 0555 12 34 56', '05 55 12 34 56', '0555-12-34-56', '(0555) 12.34.56',
  '٠٥٥٥١٢٣٤٥٦', '۰۶۶۱۲۳۴۵۶۷', '+٢١٣٥٥٥١٢٣٤٥٦', '‏0555123456‏', '⁦0555 12 34 56⁩',
  '', '   ', 'abc', '+33612345678', '0501234567', '0531234567', '0551234567',
  '021123456', '055512345', '05551234567', '+2135551234',
];

describe('phoneError ≡ @hb/shared normalizePhone (accept/reject)', () => {
  it.each(COMMON)('%j', (input) => {
    const server = normalizePhone(input);
    const client = phoneError(input, P);
    expect(client === null, `client=${client} server=${JSON.stringify(server)}`).toBe(server.ok);
    if (!server.ok && (server.code === 'phone_required' || client === 'phone_required')) expect(client).toBe(server.code);
  });

  // SHARED-2 (team/shared 347b195, not yet on this branch's shared copy): pinned expectations.
  it.each([
    ['０５５５１２３４５６', null], // fullwidth digits
    ['＋213555123456', null], // fullwidth plus
    ['0555­123456', null], // soft hyphen (\p{Cf})
    ['0555​123456', null], // zero-width space (\p{Cf})
    ['555123456', null], // bare mobile NSN
    ['2130555123456', null], // 213 + trunk 0
    ['002130555123456', null],
    ['21123456', 'phone_invalid'], // bare non-mobile is not accepted
    ['0'.repeat(65), 'phone_invalid'],
  ])('SHARED-2 rule %j', (input, code) => {
    expect(phoneError(input, P)).toBe(code);
  });

  it('never uses the naive ^0[567] rule', () => {
    for (const x of ['0501234567', '0521234567', '0531234567']) expect(phoneError(x, P)).not.toBeNull();
  });
});

describe('toAscii ≡ toAsciiDigits', () => {
  it('converts Eastern Arabic and Persian digits the same way', () => {
    const s = 'a٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ 0123';
    expect(toAscii(s)).toBe(toAsciiDigits(s));
  });
  it('also converts fullwidth digits (SHARED-2)', () => {
    expect(toAscii('０１２３４５６７８９')).toBe('0123456789');
  });
});

describe('fmt ≡ formatPrice', () => {
  it.each([0, 600, 14600, 29800, 189000, 1234567])('%i', (n) => {
    expect(fmt(n, 'ar')).toBe(formatPrice(n, 'ar'));
    expect(fmt(n, 'fr')).toBe(formatPrice(n, 'fr'));
  });
});

describe('small helpers', () => {
  it('parses data-variants', () => {
    expect([...parseVariants('21:3200:3,22:3400:0').values()]).toEqual([
      { id: 21, price: 3200, max: 3, ok: true },
      { id: 22, price: 3400, max: 0, ok: false },
    ]);
    expect(parseVariants('').size).toBe(0);
  });
  it('makes RFC 4122 v4 keys, fresh each time', () => {
    const a = uuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).not.toBe(a);
  });
});

describe('one idempotency key per exact submission (review I1)', () => {
  let n = 0;
  const make = () => `key-${++n}`;
  it('keeps the key for a retry of the same submission', () => {
    const k = submissionKeys(make);
    expect(k.of('101:1,201:1|16|7')).toBe(k.of('101:1,201:1|16|7'));
  });
  it.each([
    ['a line removed', '101:1|16|7'],
    ['a quantity changed', '101:2,201:1|16|7'],
    ['another wilaya', '101:1,201:1|31|7'],
    ['another commune', '101:1,201:1|16|8'],
  ])('rotates when the submission changes: %s', (_, changed) => {
    const k = submissionKeys(make);
    expect(k.of(changed)).not.toBe(k.of('101:1,201:1|16|7'));
  });
  it('coming back to a submission finds its own key: that order may already exist', () => {
    const k = submissionKeys(make);
    const first = k.of('a');
    k.of('b');
    expect(k.of('a')).toBe(first);
  });
  it('clear() starts over (a deliberate new order after the back button)', () => {
    const k = submissionKeys(make);
    const first = k.of('a');
    k.clear();
    expect(k.of('a')).not.toBe(first);
  });
});

describe('the automatic retry re-sends the frozen submission (review I1)', () => {
  const noToken = async () => '';
  const noWait = async () => {};
  it('retries once with the same key, lines and total, whatever changed on the page', async () => {
    const page = { items: [{ variantId: 1, qty: 1 }] };
    const body = { idempotencyKey: 'k', items: page.items.map((i) => ({ ...i })), expectedTotalDzd: 3500 };
    const sent: unknown[] = [];
    let calls = 0;
    const r = await postRetrying(
      '/api/order',
      body,
      noToken,
      async (_url: string, b: unknown) => {
        sent.push(structuredClone(b));
        if (++calls === 1) {
          page.items[0]!.qty = 2; // the customer presses + during the wait
          throw new Error('lost response');
        }
        return { status: 201, body: { ok: true } };
      },
      noWait,
    );
    expect(r.status).toBe(201);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]).toEqual({ idempotencyKey: 'k', items: [{ variantId: 1, qty: 1 }], expectedTotalDzd: 3500 });
  });
  it('asks for a fresh Turnstile token per attempt without touching the body', async () => {
    const tokens = ['t1', 't2'];
    const seen: string[] = [];
    await postRetrying(
      '/api/order',
      { idempotencyKey: 'k' },
      async () => tokens.shift() ?? '',
      async (_u: string, b: { turnstileToken?: string }) => {
        seen.push(b.turnstileToken ?? '');
        if (seen.length === 1) throw new Error('x');
        return { status: 201, body: {} };
      },
      noWait,
    );
    expect(seen).toEqual(['t1', 't2']);
  });
  it('gives up after one retry with a network answer', async () => {
    const r = await postRetrying('/api/order', {}, noToken, async () => { throw new Error('x'); }, noWait);
    expect(r).toEqual({ status: 0, body: {} });
  });
});

const row = (v: number, q: number, max: number, ok = true) => ({ p: 1, v, q, name: 'x', label: '', price: 1000, max, ok, img: null, err: false, sold: false, maxed: false, priceEl: null });

describe('stock or availability lost at confirm (review I2)', () => {
  it('clamps to maxQty and reports it', () => {
    const rows = [row(11, 3, 5)];
    expect(applyLines(rows, [{ variantId: 11, qty: 3, unitPriceDzd: 1200, lineTotalDzd: 3600, maxQty: 1 }])).toEqual({ clamped: true, dropped: false });
    expect(rows[0]).toMatchObject({ q: 1, max: 1, maxed: true, ok: true, price: 1200 });
  });
  it('marks a line the server no longer sells and takes it out of the order', () => {
    const rows = [row(11, 1, 5), row(12, 2, 5)];
    expect(applyLines(rows, [{ variantId: 11, qty: 1, unitPriceDzd: 0, lineTotalDzd: 0, maxQty: 0 }, { variantId: 12, qty: 2, unitPriceDzd: 900, lineTotalDzd: 1800, maxQty: 5 }])).toEqual({ clamped: false, dropped: true });
    expect(rows[0]).toMatchObject({ ok: false, sold: true, price: 1000 });
    expect(rows[1]).toMatchObject({ ok: true, q: 2, price: 900 });
  });
  it('reports no movement when nothing changed, so the page does not re-quote in a loop', () => {
    const rows = [row(11, 1, 5)];
    expect(applyLines(rows, [{ variantId: 11, qty: 1, unitPriceDzd: 1000, lineTotalDzd: 1000, maxQty: 5 }])).toEqual({ clamped: false, dropped: false });
    expect(applyLines(rows, undefined)).toEqual({ clamped: false, dropped: false });
  });
  it('a rebuild from the cart keeps what the server said', () => {
    const p = { name: 'A', img: null, variants: [{ id: 11, label: '', price: 1000, max: 8, ok: true }, { id: 12, label: '', price: 900, max: 8, ok: true }] };
    const rows = [row(11, 3, 8), row(12, 1, 8)];
    applyLines(rows, [{ variantId: 11, qty: 3, unitPriceDzd: 1200, lineTotalDzd: 3600, maxQty: 1 }, { variantId: 12, qty: 1, unitPriceDzd: 0, lineTotalDzd: 0, maxQty: 0 }]);
    const next = buildRows([{ p: 1, v: 11, q: 1 }, { p: 1, v: 12, q: 1 }], [p, p], rows);
    expect(next[0]).toMatchObject({ ok: true, max: 1, q: 1, price: 1200 });
    expect(next[1]).toMatchObject({ ok: false, sold: true });
  });
});

describe('a failed product fetch can be retried (review N2)', () => {
  const p = { name: 'A', img: null, variants: [{ id: 11, label: '', price: 1000, max: 8, ok: true }] };
  const lines = [{ p: 1, v: 11, q: 2 }];
  it('is not sellable while it failed, and says it failed rather than sold out', () => {
    expect(buildRows(lines, ['err'])[0]).toMatchObject({ ok: false, err: true, sold: false, name: '' });
  });
  it('becomes sellable with full data once the fetch works', () => {
    const failed = buildRows(lines, ['err']);
    expect(buildRows(lines, [p], failed)[0]).toMatchObject({ ok: true, err: false, max: 8, q: 2, price: 1000, name: 'A' });
  });
  it('a product that no longer exists is unavailable, not an error', () => {
    expect(buildRows(lines, [null])[0]).toMatchObject({ ok: false, err: false });
  });
});
