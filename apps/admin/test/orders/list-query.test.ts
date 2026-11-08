import { describe, expect, test, vi } from 'vitest';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import { ADMIN_ROLES, ORDER_STATUSES } from '@hb/shared';
import {
  SEARCH_MAX_CHARS,
  algiersDayStartMs,
  classifySearch,
  defaultStatuses,
  normalizeOrderRef,
  ordersWhere,
  parseOrdersFilter,
  type OrdersFilter,
} from '../../src/routes/orders/list-query.ts';

// Real D1 (Miniflare) on a shared, loaded host: explicit budgets so the gate does not time out at random.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const dialect = new SQLiteAsyncDialect();
const toSql = (s: SQL | undefined) => (s ? dialect.sqlToQuery(s) : null);
const q = (s: string) => new URLSearchParams(s);

const EMPTY: OrdersFilter = {
  statuses: [],
  wilaya: null,
  fromMs: null,
  toMs: null,
  flagged: false,
  duplicate: false,
  blockedCustomer: false,
  search: null,
  after: null,
};

describe('algiersDayStartMs', () => {
  test('midnight in Algiers is 23:00 UTC the day before', () => {
    expect(algiersDayStartMs('2026-11-04')).toBe(Date.UTC(2026, 10, 3, 23));
  });
  test('rejects impossible and malformed dates', () => {
    for (const v of ['2026-02-30', '2026-13-01', '2026-1-01', '04/11/2026', '', '1999-12-31', '2026-11-04T00:00']) {
      expect(algiersDayStartMs(v), v).toBeNull();
    }
  });
  test('leap day', () => {
    expect(algiersDayStartMs('2028-02-29')).not.toBeNull();
  });
});

describe('normalizeOrderRef', () => {
  test.each([
    ['HB-7K2Q9', 'HB-7K2Q9'],
    ['hb-7k2q9', 'HB-7K2Q9'],
    ['hb7k2q9', 'HB-7K2Q9'],
    ['7K2Q9', 'HB-7K2Q9'],
    ['HB 7K2Q9', 'HB-7K2Q9'],
    ['⁦HB-7K2Q9⁩', 'HB-7K2Q9'],
    ['HB-7K2QO', 'HB-7K2Q0'],
    ['HB-IL000', 'HB-11000'],
  ])('%s → %s', (input, out) => {
    expect(normalizeOrderRef(input)).toBe(out);
  });
  test.each(['HB-7K2Q', 'HB-7K2Q99', 'HB-7K2QU', 'XX-7K2Q9', '', 'HB-'])('rejects %s', (input) => {
    expect(normalizeOrderRef(input)).toBeNull();
  });
});

describe('classifySearch', () => {
  test('phone forms, including Eastern-Arabic digits, become exact E.164', () => {
    for (const v of ['0560417403', '+213560417403', '213560417403', '٠٥٦٠٤١٧٤٠٣', '05 60 41 74 03']) {
      expect(classifySearch(v), v).toEqual({ kind: 'phone', e164: '+213560417403' });
    }
  });
  test('ref with prefix, or with a digit, is an exact ref', () => {
    expect(classifySearch('7k2q9')).toEqual({ kind: 'ref', ref: 'HB-7K2Q9' });
    expect(classifySearch('hb-kxqzp')).toEqual({ kind: 'ref', ref: 'HB-KXQZP' });
  });
  test('five letters without digit or prefix match ref or name ("karim" is not only HB-KAR1M)', () => {
    expect(classifySearch('Karim')).toEqual({ kind: 'refOrName', ref: 'HB-KAR1M', term: 'Karim' });
  });
  test('anything else is a name term, trimmed and collapsed', () => {
    expect(classifySearch('  Amina   Benali ')).toEqual({ kind: 'name', term: 'Amina Benali' });
    expect(classifySearch('أمينة')).toEqual({ kind: 'name', term: 'أمينة' });
  });
  test('an invalid phone (naive 05x range) is not a phone search', () => {
    expect(classifySearch('0501234567')).toEqual({ kind: 'name', term: '0501234567' });
  });
  test('empty → null; long terms are capped', () => {
    expect(classifySearch('   ')).toBeNull();
    const r = classifySearch('ب'.repeat(200));
    expect(r?.kind === 'name' && r.term.length).toBe(SEARCH_MAX_CHARS);
  });
});

describe('cursor parameter', () => {
  test('a valid cursor is decoded', () => {
    expect(parseOrdersFilter(q('after=1793812955862.42'), 'owner').filter.after).toEqual({ at: 1793812955862, id: 42 });
  });
  test.each(['a.b', '1', '-1.2', '1.2.3', '99999999999999999.1'])('rejects %s and reports it', (v) => {
    const p = parseOrdersFilter(q(`after=${encodeURIComponent(v)}`), 'owner');
    expect(p.filter.after).toBeNull();
    expect(p.invalid).toContain('after');
  });
});

describe('defaultStatuses', () => {
  test('per role', () => {
    expect(defaultStatuses('confirmer')).toEqual(['new', 'called', 'unreachable']);
    expect(defaultStatuses('logistics')).toEqual(['confirmed', 'shipped']);
    expect(defaultStatuses('owner')).toEqual([]);
  });
  test('only real statuses', () => {
    for (const r of ADMIN_ROLES) for (const s of defaultStatuses(r)) expect(ORDER_STATUSES).toContain(s);
  });
});

describe('parseOrdersFilter', () => {
  test('no params → role default, nothing invalid', () => {
    const p = parseOrdersFilter(q(''), 'confirmer');
    expect(p.defaulted).toBe(true);
    expect(p.filter.statuses).toEqual(['new', 'called', 'unreachable']);
    expect(p.invalid).toEqual([]);
  });
  test('a search ignores the role default (find a ref in any status)', () => {
    const p = parseOrdersFilter(q('q=HB-7K2Q9'), 'confirmer');
    expect(p.defaulted).toBe(false);
    expect(p.filter.statuses).toEqual([]);
    expect(p.filter.search).toEqual({ kind: 'ref', ref: 'HB-7K2Q9' });
  });
  test('status=any clears the default; repeated statuses are deduped and ordered', () => {
    expect(parseOrdersFilter(q('status=any'), 'logistics').filter.statuses).toEqual([]);
    expect(parseOrdersFilter(q('status=shipped&status=new&status=new'), 'owner').filter.statuses).toEqual([
      'new',
      'shipped',
    ]);
  });
  test('bad values are dropped and reported, never thrown', () => {
    const p = parseOrdersFilter(
      q('status=bogus&status=new&wilaya=70&from=2026-02-30&to=x&after=zz&flagged=1&duplicate=yes'),
      'owner',
    );
    expect(p.filter.statuses).toEqual(['new']);
    expect(p.filter.wilaya).toBeNull();
    expect(p.filter.fromMs).toBeNull();
    expect(p.filter.toMs).toBeNull();
    expect(p.filter.after).toBeNull();
    expect(p.filter.flagged).toBe(true);
    expect(p.filter.duplicate).toBe(false);
    expect([...p.invalid].sort()).toEqual(['after', 'from', 'status', 'to', 'wilaya']);
  });
  test('wilaya 1..69 accepted, 0, 70 and non-integers refused', () => {
    expect(parseOrdersFilter(q('wilaya=69'), 'owner').filter.wilaya).toBe(69);
    expect(parseOrdersFilter(q('wilaya=1'), 'owner').filter.wilaya).toBe(1);
    for (const w of ['0', '70', '1.5', '07a', '-3']) {
      expect(parseOrdersFilter(q(`wilaya=${w}`), 'owner').filter.wilaya, w).toBeNull();
    }
  });
  test('date range: inclusive Algiers days, `to` becomes the next day start', () => {
    const p = parseOrdersFilter(q('from=2026-11-01&to=2026-11-04'), 'owner');
    expect(p.filter.fromMs).toBe(Date.UTC(2026, 9, 31, 23));
    expect(p.filter.toMs).toBe(Date.UTC(2026, 10, 4, 23));
    const same = parseOrdersFilter(q('from=2026-11-04&to=2026-11-04'), 'owner');
    expect(same.filter.toMs! - same.filter.fromMs!).toBe(86_400_000);
  });
  test('reversed range is reported and dropped', () => {
    const p = parseOrdersFilter(q('from=2026-11-05&to=2026-11-04'), 'owner');
    expect(p.invalid).toContain('range');
    expect(p.filter.fromMs).toBeNull();
    expect(p.filter.toMs).toBeNull();
  });
});

describe('ordersWhere', () => {
  test('no filter → no WHERE', () => {
    expect(ordersWhere(EMPTY)).toBeUndefined();
  });
  test('every value is a bound parameter, never spliced into SQL', () => {
    const evil = "x') or 1=1 --";
    const r = toSql(ordersWhere({ ...EMPTY, search: { kind: 'name', term: evil } }))!;
    expect(r.sql).not.toContain(evil);
    expect(r.params).toContain(evil);
    expect(r.sql).toContain('instr(lower("orders"."name"), lower(?)) > 0');
    expect(r.sql).not.toMatch(/\blike\b|\bglob\b/i);
  });
  test('refOrName matches either', () => {
    const r = toSql(ordersWhere({ ...EMPTY, search: { kind: 'refOrName', ref: 'HB-KAR1M', term: 'Karim' } }))!;
    expect(r.sql).toBe('("orders"."ref" = ? or instr(lower("orders"."name"), lower(?)) > 0)');
    expect(r.params).toEqual(['HB-KAR1M', 'Karim']);
  });
  test('phone and ref are exact matches on indexed columns', () => {
    const p = toSql(ordersWhere({ ...EMPTY, search: { kind: 'phone', e164: '+213560417403' } }))!;
    expect(p.sql).toBe('"orders"."phone_e164" = ?');
    expect(p.params).toEqual(['+213560417403']);
    const r = toSql(ordersWhere({ ...EMPTY, search: { kind: 'ref', ref: 'HB-7K2Q9' } }))!;
    expect(r.sql).toBe('"orders"."ref" = ?');
  });
  test('statuses, wilaya and date bounds', () => {
    const r = toSql(
      ordersWhere({ ...EMPTY, statuses: ['new', 'called'], wilaya: 16, fromMs: 1000, toMs: 2000 }),
    )!;
    expect(r.sql).toBe(
      '("orders"."status" in (?, ?) and "orders"."wilaya_code" = ? and "orders"."created_at" >= ? and "orders"."created_at" < ?)',
    );
    expect(r.params).toEqual(['new', 'called', 16, 1000, 2000]);
  });
  test('flagged uses the partial-index predicate verbatim', () => {
    const r = toSql(ordersWhere({ ...EMPTY, flagged: true }))!;
    expect(r.sql).toBe(`"orders"."flags" <> '[]'`);
  });
  test('duplicate implies the flagged predicate plus a json_each check', () => {
    const r = toSql(ordersWhere({ ...EMPTY, duplicate: true }))!;
    expect(r.sql).toContain(`"orders"."flags" <> '[]'`);
    expect(r.sql).toContain(`json_each("orders"."flags") where json_each.value = 'duplicate'`);
  });
  test('blocked customer checks the customer row now, not the flag at order time', () => {
    const r = toSql(ordersWhere({ ...EMPTY, blockedCustomer: true }))!;
    expect(r.sql).toContain('"customers"."blocked" = 1');
    expect(r.sql).toContain('"customers"."id" = "orders"."customer_id"');
  });
  test('keyset cursor: strictly older, id breaks ties', () => {
    const r = toSql(ordersWhere({ ...EMPTY, after: { at: 500, id: 9 } }))!;
    expect(r.sql).toBe(
      '("orders"."created_at" < ? or ("orders"."created_at" = ? and "orders"."id" < ?))',
    );
    expect(r.params).toEqual([500, 500, 9]);
  });
});
