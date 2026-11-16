import { describe, expect, test } from 'vitest';
import { ORDER_REF_RE } from '../src/order-schema.ts';
import {
  TELEGRAM_DEFAULT_FIELDS,
  TELEGRAM_FIELDS,
  TELEGRAM_SAMPLE_ORDER,
  TELEGRAM_SETTINGS_DEFAULT,
  TELEGRAM_TOKEN_RE,
  confirmedTelegramChats,
  formatTelegramOrder,
  parseTelegramSettings,
  parseTelegramStatus,
  type TelegramField,
  type TelegramOrderView,
} from '../src/telegram.ts';

const order: TelegramOrderView = {
  ref: 'HB-7K2Q9',
  name: 'Amine Test',
  phoneE164: '+213661234567',
  wilayaCode: 9,
  wilaya: { fr: 'Blida', ar: 'البليدة' },
  commune: { fr: 'Boufarik', ar: 'بوفاريك' },
  address: 'Rue des Essais 4',
  items: [
    { name: { fr: 'Veste', ar: 'سترة' }, variant: { fr: 'Rouge / XL', ar: 'أحمر / XL' }, qty: 2, lineTotalDzd: 9000 },
    { name: { fr: 'Montre', ar: 'ساعة' }, variant: null, qty: 1, lineTotalDzd: 3000 },
  ],
  feeDzd: 500,
  totalDzd: 12500,
  note: 'Sonner deux fois',
};

/** What each field puts in a French message, and nothing else does. */
const MARK: Record<TelegramField, string> = {
  ref: 'HB-7K2Q9',
  name: 'Amine Test',
  phone: '0661234567',
  place: 'Boufarik',
  address: 'Rue des Essais 4',
  items: 'Veste',
  fee: 'Livraison',
  total: 'Total',
  note: 'Sonner deux fois',
};

describe('formatTelegramOrder', () => {
  test('everything ticked, French', () => {
    expect(formatTelegramOrder(order, TELEGRAM_FIELDS, 'fr').split('\n')).toEqual([
      'Nouvelle commande HB-7K2Q9',
      'Client : Amine Test',
      'Téléphone : 0661234567',
      'Wilaya : 09 Blida, Boufarik',
      'Adresse : Rue des Essais 4',
      'Produits :',
      '2 × Veste (Rouge / XL)',
      '1 × Montre',
      expect.stringMatching(/^Livraison : 500\s?DA$/u),
      expect.stringMatching(/^Total : 12\s?500\s?DA$/u),
      'Note : Sonner deux fois',
    ]);
  });

  test.each(TELEGRAM_FIELDS)('only %s ticked: that detail and no other', (field) => {
    const text = formatTelegramOrder(order, [field], 'fr');
    for (const f of TELEGRAM_FIELDS) expect(text.includes(MARK[f]), `${f} in a message with only ${field}`).toBe(f === field);
    expect(text.startsWith('Nouvelle commande')).toBe(true);
  });

  test.each(TELEGRAM_FIELDS)('all but %s ticked: only that detail is missing', (field) => {
    const text = formatTelegramOrder(order, TELEGRAM_FIELDS.filter((f) => f !== field), 'fr');
    for (const f of TELEGRAM_FIELDS) expect(text.includes(MARK[f]), f).toBe(f !== field);
  });

  test('nothing ticked: the heading alone; the order of the ticks does not matter', () => {
    expect(formatTelegramOrder(order, [], 'fr')).toBe('Nouvelle commande');
    expect(formatTelegramOrder(order, ['total', 'ref'], 'fr')).toBe(formatTelegramOrder(order, ['ref', 'total'], 'fr'));
  });

  test('a ticked field with no value is left out', () => {
    const text = formatTelegramOrder({ ...order, address: null, note: '  ', commune: null }, TELEGRAM_FIELDS, 'fr');
    expect(text).not.toMatch(/Adresse|Note/);
    expect(text).toContain('Wilaya : 09 Blida\n');
  });

  test('Arabic: labels, and the ref and phone inside left-to-right isolates', () => {
    const text = formatTelegramOrder(order, TELEGRAM_FIELDS, 'ar');
    const lines = text.split('\n');
    expect(lines[0]).toBe('طلب جديد ⁦HB-7K2Q9⁩');
    expect(lines).toContain('الهاتف: ⁦0661234567⁩');
    expect(lines).toContain('الاسم: ⁨Amine Test⁩');
    expect(text).toContain('البليدة، بوفاريك');
    expect(lines).toContain('⁦2⁩ × ⁨سترة (أحمر / XL)⁩');
    expect(text).toMatch(/المجموع: /);
    // Every isolate that opens is closed on its own line.
    for (const l of lines) expect((l.match(/[⁦⁨]/g) ?? []).length).toBe((l.match(/⁩/g) ?? []).length);
    expect(formatTelegramOrder(order, TELEGRAM_FIELDS, 'fr')).not.toMatch(/[⁦-⁩]/);
  });

  test('customer text cannot add lines or bidi controls', () => {
    const text = formatTelegramOrder({ ...order, name: 'A\nTotal : 0 DA‮', note: 'x\r\ny' }, ['name', 'note'], 'fr');
    expect(text.split('\n')).toEqual(['Nouvelle commande', 'Client : A Total : 0 DA', 'Note : x y']);
  });

  test('stays under 4096 characters: the item list is cut with an ellipsis, the total survives', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ name: { fr: `Produit ${i} ${'x'.repeat(100)}`, ar: 'م' }, variant: null, qty: 1, lineTotalDzd: 1 }));
    const text = formatTelegramOrder({ ...order, items, name: 'n'.repeat(5000), address: 'a'.repeat(5000), note: 'z'.repeat(5000) }, TELEGRAM_FIELDS, 'fr');
    expect(text.length).toBeLessThanOrEqual(4096);
    const lines = text.split('\n');
    expect(lines).toContain('…');
    expect(lines.some((l) => l.startsWith('Total : '))).toBe(true);
    expect(lines.at(-1)).toMatch(/^Note : z+…$/);
    expect(lines.filter((l) => l.startsWith('1 × ')).length).toBeGreaterThan(5);
  });

  test('the sample order is fictional, valid and complete', () => {
    expect(TELEGRAM_SAMPLE_ORDER.ref).toMatch(ORDER_REF_RE);
    const text = formatTelegramOrder(TELEGRAM_SAMPLE_ORDER, TELEGRAM_DEFAULT_FIELDS, 'fr');
    expect(text).toContain('0550000000');
    expect(text.split('\n').length).toBe(11);
  });
});

describe('parseTelegramSettings', () => {
  test.each([undefined, null, 42, 'nope', '{bad json', [], { chats: 'x', fields: 7, bot: 'me' }])('garbage %j gives the default', (v) => {
    expect(parseTelegramSettings(v)).toEqual(TELEGRAM_SETTINGS_DEFAULT);
  });

  test('the default is off, French, everything ticked, and is never handed out by reference', () => {
    expect(TELEGRAM_SETTINGS_DEFAULT).toMatchObject({ enabled: false, lang: 'fr', fields: [...TELEGRAM_FIELDS], chats: [], bot: null, tokenLast4: null });
    const a = parseTelegramSettings(null);
    a.fields.pop();
    a.chats.push({ id: '1', title: 't', type: 'private', status: 'pending', seenAt: 1, confirmedAt: null });
    expect(parseTelegramSettings(null)).toEqual(TELEGRAM_SETTINGS_DEFAULT);
    expect(TELEGRAM_SETTINGS_DEFAULT.fields).toHaveLength(TELEGRAM_FIELDS.length);
  });

  test('a stored value round-trips, also as JSON text; fields are ordered and deduped; unknown things are dropped', () => {
    const stored = {
      enabled: true,
      enabledAt: 1000,
      lang: 'ar',
      fields: ['total', 'ref', 'ref', 'bogus'],
      chats: [
        { id: '-1001234567890', title: 'Équipe', type: 'supergroup', status: 'confirmed', seenAt: 5, confirmedAt: 9 },
        { id: '42', title: 'x'.repeat(200), type: 'private', status: 'pending', seenAt: 6, confirmedAt: null },
        { id: '42', title: 'duplicate', type: 'private', status: 'pending', seenAt: 6, confirmedAt: null },
        { id: 'abc', title: 'bad id', type: 'private', status: 'pending', seenAt: 6, confirmedAt: null },
        { id: '7', title: 'bad type', type: 'bot', status: 'pending', seenAt: 6, confirmedAt: null },
        { id: '8', title: 'no date', type: 'group', status: 'confirmed', seenAt: 6, confirmedAt: null },
      ],
      bot: { id: 123456, username: 'comptoir_bot', name: 'Comptoir' },
      tokenLast4: 'aaaa',
      updateOffset: 77,
      token: 'must not survive',
    };
    const s = parseTelegramSettings(stored);
    expect(parseTelegramSettings(JSON.stringify(stored))).toEqual(s);
    expect(s.fields).toEqual(['ref', 'total']);
    expect(s.chats.map((c) => [c.id, c.status])).toEqual([['-1001234567890', 'confirmed'], ['42', 'pending'], ['8', 'pending']]);
    expect(s.chats[1]!.title.length).toBe(80);
    expect(confirmedTelegramChats(s).map((c) => c.id)).toEqual(['-1001234567890']);
    expect(s).toMatchObject({ enabled: true, enabledAt: 1000, lang: 'ar', bot: stored.bot, tokenLast4: 'aaaa', updateOffset: 77 });
    expect(Object.keys(s).sort()).toEqual(Object.keys(TELEGRAM_SETTINGS_DEFAULT).sort());
    expect(parseTelegramSettings({ fields: [] }).fields).toEqual([]);
  });
});

test('parseTelegramStatus is tolerant', () => {
  expect(parseTelegramStatus('x')).toEqual({ lastOkAt: null, lastErrorCode: null, lastErrorAt: null });
  expect(parseTelegramStatus({ lastOkAt: 5, lastErrorCode: 'unreachable', lastErrorAt: 6 })).toEqual({ lastOkAt: 5, lastErrorCode: 'unreachable', lastErrorAt: 6 });
  expect(parseTelegramStatus({ lastOkAt: 5, lastErrorCode: 'https://x', lastErrorAt: 6 })).toEqual({ lastOkAt: 5, lastErrorCode: null, lastErrorAt: null });
});

test('TELEGRAM_TOKEN_RE', () => {
  expect(TELEGRAM_TOKEN_RE.test('123456:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
  for (const bad of ['', '123456', '123456:short', 'abc:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '123456:TEST aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ' 123456:TEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
    expect(TELEGRAM_TOKEN_RE.test(bad), bad).toBe(false);
});
