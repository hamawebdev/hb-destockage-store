import { describe, expect, test } from 'vitest';
import { formatOrderCreated } from '../src/notify/format.ts';
import { parseOrderCreated } from '../src/notify/message.ts';

export const validBody = {
  type: 'order.created',
  v: 1,
  orderId: 42,
  ref: 'HB-7K2Q9',
  totalDzd: 15400,
  wilayaCode: 16,
  lang: 'ar',
  flags: [],
  createdAt: 1_793_000_000_000,
};

describe('parseOrderCreated', () => {
  test('accepts the contract shape', () => {
    expect(parseOrderCreated(validBody)).toEqual(validBody);
  });

  test('drops unknown fields so stray personal data never reaches a provider', () => {
    const parsed = parseOrderCreated({ ...validBody, name: 'Amina B.', phone: '+213560417403' });
    expect(parsed).toEqual(validBody);
    expect(JSON.stringify(parsed)).not.toContain('560417403');
  });

  test.each([
    ['null', null],
    ['string', 'order'],
    ['wrong type', { ...validBody, type: 'order.updated' }],
    ['wrong version', { ...validBody, v: 2 }],
    ['orderId 0', { ...validBody, orderId: 0 }],
    ['orderId float', { ...validBody, orderId: 1.5 }],
    ['bad ref', { ...validBody, ref: 'HB-<script>' }],
    ['flags not strings', { ...validBody, flags: [1] }],
    ['negative total', { ...validBody, totalDzd: -1 }],
    ['fractional total', { ...validBody, totalDzd: 10.5 }],
    ['wilaya 0', { ...validBody, wilayaCode: 0 }],
    ['wilaya 70', { ...validBody, wilayaCode: 70 }],
    ['lang', { ...validBody, lang: 'en' }],
    ['flags not array', { ...validBody, flags: 'duplicate' }],
    ['missing createdAt', { ...validBody, createdAt: undefined }],
  ])('rejects %s', (_label, body) => {
    expect(parseOrderCreated(body)).toBeNull();
  });
});

describe('formatOrderCreated', () => {
  test('French: ref, total, wilaya and flags only', () => {
    const n = formatOrderCreated({ ...validBody, type: 'order.created', v: 1, lang: 'fr', flags: ['duplicate'] }, 'fr');
    expect(n.id).toBe('order-42');
    expect(n.subject).toBe('Nouvelle commande HB-7K2Q9');
    expect(n.text).toContain('HB-7K2Q9');
    expect(n.text).toMatch(/15\s400\sDA/u);
    expect(n.text).toContain('Wilaya : 16');
    expect(n.text).toContain('duplicate');
  });

  test('Arabic variant', () => {
    const n = formatOrderCreated({ ...validBody, type: 'order.created', v: 1, lang: 'ar' }, 'ar');
    expect(n.text).toContain('طلب جديد HB-7K2Q9');
    expect(n.text).toContain('د.ج');
    expect(n.text).not.toContain('تنبيهات');
  });
});
