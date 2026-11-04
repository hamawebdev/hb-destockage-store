import { describe, expect, test } from 'vitest';
import {
  HONEYPOT_FIELD,
  ORDER_ERROR_CODES,
  ORDER_ERROR_HTTP_STATUS,
  ORDER_REF_RE,
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
  formStartedAt: 1_700_000_000_000,
  turnstileToken: 'tok',
  'cf-turnstile-response': 'stripped',
};

describe('parseOrderInput', () => {
  test('valid JSON body: normalised output, unknown keys stripped', () => {
    const r = parseOrderInput(valid);
    expect(r).toEqual({
      ok: true,
      value: {
        lang: 'ar',
        items: [{ variantId: 12, qty: 2 }],
        name: 'محمد بن علي',
        phone: { e164: '+213560417403', national: '0560417403' },
        wilayaCode: 16,
        communeId: 1601,
        idempotencyKey: KEY.toLowerCase(),
        [HONEYPOT_FIELD]: '',
        formStartedAt: 1_700_000_000_000,
        turnstileToken: 'tok',
      },
    });
  });

  test('form-encoded body: numeric strings coerced', () => {
    const r = parseOrderInput({
      ...valid,
      items: [{ variantId: '12', qty: ' 2 ' }],
      wilayaCode: '١٦',
      communeId: '1601',
      formStartedAt: 'garbage',
      turnstileToken: undefined,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.items).toEqual([{ variantId: 12, qty: 2 }]);
      expect(r.value.wilayaCode).toBe(16);
      expect(r.value.formStartedAt).toBeUndefined();
      expect(r.value.turnstileToken).toBeUndefined();
    }
  });

  test.each([
    [{ lang: 'en' }, [{ field: 'lang', code: 'lang_invalid' }]],
    [{ name: 'a' }, [{ field: 'name', code: 'name_invalid' }]],
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

test('parseOrderDraft does not require the idempotency key', () => {
  const { idempotencyKey: _k, ...draft } = valid;
  expect(parseOrderDraft(draft).ok).toBe(true);
  expect(parseOrderInput(draft).ok).toBe(false);
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
});

test('makeOrderRef', () => {
  expect(makeOrderRef(new Uint8Array([0, 1, 31, 32, 255]))).toBe('HB-01Z0Z');
  for (let i = 0; i < 200; i++) {
    expect(makeOrderRef(crypto.getRandomValues(new Uint8Array(5)))).toMatch(ORDER_REF_RE);
  }
  expect(() => makeOrderRef(new Uint8Array(4))).toThrow(RangeError);
  expect(ORDER_REF_RE.test('HB-7K2Q9')).toBe(true);
  expect(ORDER_REF_RE.test('HB-7K2O9')).toBe(false);
});

describe('submissionFlags', () => {
  const now = 1_700_000_010_000;
  test('clean submission', () => {
    expect(submissionFlags({ [HONEYPOT_FIELD]: '', formStartedAt: now - 30_000 }, 'valid', now)).toEqual([]);
  });
  test('every signal', () => {
    expect(submissionFlags({ [HONEYPOT_FIELD]: 'x', formStartedAt: now - 500 }, 'invalid', now)).toEqual([
      'honeypot',
      'fast_fill',
      'turnstile_invalid',
    ]);
    expect(submissionFlags({ [HONEYPOT_FIELD]: ' ', formStartedAt: undefined }, 'missing', now)).toEqual([
      'fill_time_missing',
      'turnstile_missing',
    ]);
  });
});
