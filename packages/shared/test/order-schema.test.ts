import { describe, expect, test } from 'vitest';
import {
  HONEYPOT_FIELD,
  MIN_REVIEW_MS,
  ORDER_ERROR_CODES,
  ORDER_ERROR_HTTP_STATUS,
  ORDER_REF_RE,
  failureCode,
  formFieldsToBody,
  isOrderRef,
  makeOrderRef,
  orderErrorKey,
  parseOrderDraft,
  parseOrderInput,
  parseQuoteInput,
  submissionFlags,
} from '../src/order-schema.ts';

const KEY = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const valid = {
  lang: 'ar',
  items: [{ variantId: 12, qty: 2 }],
  name: '  محمد   بن علي ',
  phone: '٠٥٦٠ ٤١ ٧٤ ٠٣',
  wilayaCode: 16,
  communeId: 1601,
  idempotencyKey: KEY,
  expectedTotalDzd: 29800,
  fillMs: 8423,
  turnstileToken: 'tok',
  'cf-turnstile-response': 'stripped',
};

describe('parseOrderInput', () => {
  test('valid JSON body: normalised output, unknown keys stripped', () => {
    expect(parseOrderInput(valid)).toEqual({
      ok: true,
      value: {
        lang: 'ar',
        items: [{ variantId: 12, qty: 2 }],
        name: 'محمد بن علي',
        phone: { e164: '+213560417403', national: '0560417403' },
        wilayaCode: 16,
        communeId: 1601,
        idempotencyKey: KEY.toLowerCase(),
        expectedTotalDzd: 29800,
        [HONEYPOT_FIELD]: '',
        fillMs: 8423,
        turnstileToken: 'tok',
      },
    });
  });

  test('form-encoded confirm step: flat fields, numeric strings and Arabic digits coerced', () => {
    const body = formFieldsToBody([
      ['step', 'confirm'],
      ['lang', 'fr'],
      ['variantId', '12'],
      ['qty', ' 2 '],
      ['name', 'Amine'],
      ['phone', '0560417403'],
      ['wilayaCode', '١٦'],
      ['communeId', '1601'],
      ['idempotencyKey', KEY],
      ['expectedTotalDzd', '29800'],
      ['website', ''],
    ]);
    const r = parseOrderInput(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items).toEqual([{ variantId: 12, qty: 2 }]);
      expect(r.value.wilayaCode).toBe(16);
      expect(r.value.fillMs).toBeUndefined();
      expect(r.value.turnstileToken).toBeUndefined();
    }
  });

  test('malformed fillMs counts as missing, never fails', () => {
    for (const fillMs of ['garbage', -5, 86_400_001, 1.5]) {
      const r = parseOrderInput({ ...valid, fillMs });
      expect(r.ok && r.value.fillMs).toBeUndefined();
    }
  });

  test.each([
    [{ lang: 'en' }, [{ field: 'lang', code: 'lang_invalid' }]],
    [{ name: '' }, [{ field: 'name', code: 'name_required' }]],
    [{ name: ' ‏ ' }, [{ field: 'name', code: 'name_required' }]],
    [{ name: undefined }, [{ field: 'name', code: 'name_required' }]],
    [{ name: 'a' }, [{ field: 'name', code: 'name_invalid' }]],
    [{ name: '12345' }, [{ field: 'name', code: 'name_invalid' }]],
    [{ name: 'x'.repeat(81) }, [{ field: 'name', code: 'name_invalid' }]],
    [{ name: 'ab\u0000' }, [{ field: 'name', code: 'name_invalid' }]],
    [{ phone: '' }, [{ field: 'phone', code: 'phone_required' }]],
    [{ phone: undefined }, [{ field: 'phone', code: 'phone_required' }]],
    [{ phone: '0501234567' }, [{ field: 'phone', code: 'phone_not_mobile' }]],
    [{ phone: '12345' }, [{ field: 'phone', code: 'phone_invalid' }]],
    [{ wilayaCode: 0 }, [{ field: 'wilayaCode', code: 'wilaya_invalid' }]],
    [{ wilayaCode: 70 }, [{ field: 'wilayaCode', code: 'wilaya_invalid' }]],
    [{ wilayaCode: '16.5' }, [{ field: 'wilayaCode', code: 'wilaya_invalid' }]],
    [{ communeId: -1 }, [{ field: 'communeId', code: 'commune_invalid' }]],
    [{ communeId: undefined }, [{ field: 'communeId', code: 'commune_invalid' }]],
    [{ items: [] }, [{ field: 'items', code: 'items_empty' }]],
    [{ items: 'x' }, [{ field: 'items', code: 'items_invalid' }]],
    [{ items: [{ variantId: 1, qty: 0 }] }, [{ field: 'items', code: 'qty_invalid', index: 0 }]],
    [{ items: [{ variantId: 1, qty: 11 }] }, [{ field: 'items', code: 'qty_invalid', index: 0 }]],
    [{ items: [{ variantId: 1, qty: 1.5 }] }, [{ field: 'items', code: 'qty_invalid', index: 0 }]],
    [{ items: [{ variantId: 0, qty: 1 }] }, [{ field: 'items', code: 'items_invalid', index: 0 }]],
    [{ items: [{ variantId: 1, qty: 1 }, { variantId: 1, qty: 2 }] }, [{ field: 'items', code: 'items_invalid' }]],
    [
      { items: Array.from({ length: 11 }, (_, i) => ({ variantId: i + 1, qty: 1 })) },
      [{ field: 'items', code: 'items_invalid' }],
    ],
    [{ idempotencyKey: 'nope' }, [{ field: 'idempotencyKey', code: 'idempotency_key_invalid' }]],
    [{ idempotencyKey: undefined }, [{ field: 'idempotencyKey', code: 'idempotency_key_invalid' }]],
    [{ expectedTotalDzd: undefined }, [{ field: 'expectedTotalDzd', code: 'invalid_request' }]],
    [{ expectedTotalDzd: 10.5 }, [{ field: 'expectedTotalDzd', code: 'invalid_request' }]],
  ])('%j → %j', (patch, errors) => {
    expect(parseOrderInput({ ...valid, ...patch })).toEqual({ ok: false, errors });
  });

  test('several invalid fields are all reported', () => {
    const r = parseOrderInput({ ...valid, name: '', phone: '0501234567', wilayaCode: 99 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(['name', 'phone', 'wilayaCode']);
  });

  test.each([null, 'x', 42, []])('non-object body %j → invalid_request', (body) => {
    expect(parseOrderInput(body)).toEqual({ ok: false, errors: [{ field: 'form', code: 'invalid_request' }] });
  });

  test('honeypot never fails validation', () => {
    const r = parseOrderInput({ ...valid, [HONEYPOT_FIELD]: 'http://spam' });
    expect(r.ok && r.value[HONEYPOT_FIELD]).toBe('http://spam');
    expect(parseOrderInput({ ...valid, [HONEYPOT_FIELD]: 12 }).ok).toBe(true);
  });
});

describe('failureCode', () => {
  test('validation unless a request-level code is present', () => {
    expect(failureCode([{ field: 'phone', code: 'phone_invalid' }])).toBe('validation');
    expect(failureCode([{ field: 'phone', code: 'phone_invalid' }, { field: 'expectedTotalDzd', code: 'invalid_request' }])).toBe(
      'invalid_request',
    );
    expect(failureCode([{ field: 'idempotencyKey', code: 'idempotency_key_invalid' }])).toBe('idempotency_key_invalid');
  });
});

describe('formFieldsToBody', () => {
  test('variant form', () => {
    expect(formFieldsToBody({ variantId: '3', qty: '2', lang: 'ar' })).toEqual({ lang: 'ar', items: [{ variantId: '3', qty: '2' }] });
  });
  test('options form; first value wins; no prototype pollution', () => {
    const body = formFieldsToBody([
      ['productId', '7'],
      ['opt.1', '11'],
      ['opt.2', '21'],
      ['opt.2', '22'],
      ['qty', '1'],
      ['__proto__', 'x'],
      ['opt.__proto__', 'y'],
    ]);
    expect(body['productId']).toBe('7');
    expect(body['qty']).toBe('1');
    expect(Object.entries(body['options'] as object)).toEqual([
      ['1', '11'],
      ['2', '21'],
      ['__proto__', 'y'],
    ]);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
  });
});

describe('parseOrderDraft (no-JS step 1)', () => {
  const base = { lang: 'fr', name: 'Amine', phone: '0560417403', wilayaCode: '16', website: '' };

  test('variant selection; commune optional', () => {
    expect(parseOrderDraft(formFieldsToBody({ ...base, variantId: '12', qty: '2' }))).toEqual({
      ok: true,
      value: {
        lang: 'fr',
        name: 'Amine',
        phone: { e164: '+213560417403', national: '0560417403' },
        wilayaCode: 16,
        website: '',
        selection: { kind: 'variant', variantId: 12, qty: 2 },
      },
    });
  });

  test('size × colour selection', () => {
    const r = parseOrderDraft(formFieldsToBody({ ...base, communeId: '1601', productId: '7', 'opt.1': '11', 'opt.2': '٢١', qty: '1' }));
    expect(r).toEqual({
      ok: true,
      value: expect.objectContaining({
        communeId: 1601,
        selection: { kind: 'options', productId: 7, options: { 1: 11, 2: 21 }, qty: 1 },
      }),
    });
  });

  test('no selection ⇒ variant_required, alongside other field errors', () => {
    expect(parseOrderDraft(formFieldsToBody(base))).toEqual({ ok: false, errors: [{ field: 'items', code: 'variant_required' }] });
    expect(parseOrderDraft(formFieldsToBody({ ...base, productId: '7', qty: '1' }))).toEqual({
      ok: false,
      errors: [{ field: 'items', code: 'variant_required' }],
    });
    const r = parseOrderDraft(formFieldsToBody({ ...base, phone: '0501234567' }));
    expect(r).toEqual({
      ok: false,
      errors: [
        { field: 'phone', code: 'phone_not_mobile' },
        { field: 'items', code: 'variant_required' },
      ],
    });
  });

  test('bad option ids and quantities', () => {
    expect(parseOrderDraft(formFieldsToBody({ ...base, productId: '7', 'opt.x': '1', qty: '1' }))).toEqual({
      ok: false,
      errors: [{ field: 'items', code: 'items_invalid' }],
    });
    expect(parseOrderDraft(formFieldsToBody({ ...base, productId: '7', 'opt.1': '1', qty: '11' }))).toEqual({
      ok: false,
      errors: [{ field: 'items', code: 'qty_invalid' }],
    });
    expect(parseOrderDraft(formFieldsToBody({ ...base, variantId: '1', qty: '0' }))).toEqual({
      ok: false,
      errors: [{ field: 'items', code: 'qty_invalid', index: 0 }],
    });
  });

  test('no idempotency key or total needed', () => {
    expect(parseOrderDraft({ ...base, items: [{ variantId: 1, qty: 1 }] }).ok).toBe(true);
  });
});

describe('parseQuoteInput', () => {
  test('commune optional', () => {
    expect(parseQuoteInput({ items: [{ variantId: 3, qty: 1 }], wilayaCode: 31 })).toEqual({
      ok: true,
      value: { items: [{ variantId: 3, qty: 1 }], wilayaCode: 31 },
    });
    expect(parseQuoteInput({ items: [{ variantId: 3, qty: 1 }], wilayaCode: '31', communeId: '3101' })).toEqual({
      ok: true,
      value: { items: [{ variantId: 3, qty: 1 }], wilayaCode: 31, communeId: 3101 },
    });
  });
  test('errors', () => {
    expect(parseQuoteInput({ items: [], wilayaCode: 31 })).toEqual({
      ok: false,
      errors: [{ field: 'items', code: 'items_empty' }],
    });
  });
});

test('error codes: keys, HTTP status for each', () => {
  for (const c of ORDER_ERROR_CODES) {
    expect(orderErrorKey(c)).toBe(`order.errors.${c}`);
    expect(ORDER_ERROR_HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
  }
  expect(Object.keys(ORDER_ERROR_HTTP_STATUS).sort()).toEqual([...ORDER_ERROR_CODES].sort());
  expect(ORDER_ERROR_HTTP_STATUS.total_changed).toBe(409);
  expect(ORDER_ERROR_HTTP_STATUS.server_error).toBe(503);
});

test('order ref', () => {
  expect(makeOrderRef(new Uint8Array([0, 1, 31, 32, 255]))).toBe('HB-01Z0Z');
  for (let i = 0; i < 200; i++) {
    expect(isOrderRef(makeOrderRef(crypto.getRandomValues(new Uint8Array(5))))).toBe(true);
  }
  expect(() => makeOrderRef(new Uint8Array(4))).toThrow(RangeError);
  expect(ORDER_REF_RE.test('HB-7K2Q9')).toBe(true);
  for (const bad of ['HB-7K2O9', 'HB-7K2Q', 'hb-7K2Q9', 'HB-7K2Q9 ', 42]) expect(isOrderRef(bad)).toBe(false);
});

describe('submissionFlags', () => {
  test('clean submission', () => {
    expect(submissionFlags({ [HONEYPOT_FIELD]: '', fillMs: 30_000 }, 'valid')).toEqual([]);
  });
  test('every signal', () => {
    expect(submissionFlags({ [HONEYPOT_FIELD]: 'x', fillMs: 500 }, 'invalid')).toEqual(['honeypot', 'fast_fill', 'turnstile_invalid']);
    expect(submissionFlags({ [HONEYPOT_FIELD]: ' ', fillMs: undefined }, 'missing')).toEqual([
      'fill_time_missing',
      'turnstile_missing',
    ]);
    expect(submissionFlags({ [HONEYPOT_FIELD]: '', fillMs: 2_499 }, 'error')).toEqual(['fast_fill', 'turnstile_invalid']);
  });
  test('no-JS threshold', () => {
    expect(submissionFlags({ [HONEYPOT_FIELD]: '', fillMs: 2_000 }, 'valid', MIN_REVIEW_MS)).toEqual([]);
    expect(submissionFlags({ [HONEYPOT_FIELD]: '', fillMs: 1_000 }, 'valid', MIN_REVIEW_MS)).toEqual(['fast_fill']);
  });
});
