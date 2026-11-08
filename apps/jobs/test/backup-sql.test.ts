import { describe, expect, test } from 'vitest';
import { canonicalValue, createRowDigest } from '../src/backup/digest.ts';
import { topoOrder, type TableInfo } from '../src/backup/schema.ts';
import { InsertWriter, MAX_STATEMENT_BYTES, OversizedRowError, quoteIdent, sqlLiteral, UnsupportedValueError } from '../src/backup/sql.ts';

describe('sqlLiteral', () => {
  test.each([
    [null, 'NULL'],
    [undefined, 'NULL'],
    [0, '0'],
    [-42, '-42'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [0.1, '0.1'],
    [1e300, '1e+300'],
    [Infinity, '9e999'],
    [-Infinity, '-9e999'],
    [NaN, 'NULL'],
    ['', "''"],
    ["l'huile; -- DROP TABLE x", "'l''huile; -- DROP TABLE x'"],
    ['سطر\nثاني', "'سطر\nثاني'"],
    ['a\0b', "CAST(X'610062' AS TEXT)"],
    [[0, 1, 255], "X'0001ff'"],
    [new Uint8Array([171, 205]), "X'abcd'"],
  ])('%j → %s', (v, out) => {
    expect(sqlLiteral(v)).toBe(out);
  });

  test('large integral doubles stay REAL literals', () => {
    expect(sqlLiteral(2 ** 53 + 2)).toBe('9007199254740994.0');
  });

  test('unsupported values fail loudly', () => {
    expect(() => sqlLiteral({})).toThrow(UnsupportedValueError);
  });

  test('quoteIdent doubles quotes', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe('InsertWriter', () => {
  test('splits by statement size and row count, every statement under the D1 limit', async () => {
    const out: string[] = [];
    const w = new InsertWriter('t', ['id', 'v'], async (s) => void out.push(s));
    for (let i = 0; i < 2000; i++) await w.add({ id: i, v: 'x'.repeat(200) });
    await w.flush();
    expect(out.length).toBeGreaterThan(4);
    for (const s of out) {
      expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
      expect(s.startsWith('INSERT INTO "t" ("id","v") VALUES\n')).toBe(true);
      expect(s.endsWith(';\n')).toBe(true);
    }
    expect(out.join('').match(/\(\d+,'x+'\)/g)).toHaveLength(2000);
  });

  test('a single row over the limit fails loudly, naming only the table', async () => {
    const w = new InsertWriter('products', ['d'], async () => undefined);
    const err = await w.add({ d: 'secret-value-'.repeat(10_000) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OversizedRowError);
    expect(String((err as Error).message)).toContain('products');
    expect(String((err as Error).message)).not.toContain('secret-value');
  });
});

describe('row digest (DB-5 rules)', () => {
  test('column order, blobs as hex, newline-joined', () => {
    const d = createRowDigest(['a', 'b']);
    d.add({ b: [1, 2], a: 'x' });
    d.add({ a: null, b: 1.5 });
    const r = d.finish();
    expect(r.rows).toBe(2);
    // sha256('["x","0102"]\n[null,1.5]')
    expect(r.digest).toBe('739a419208a2cf656f376a8fb9875f8236a61a6b5fcc2275b98c8a2f7d46c2f4');
    const again = createRowDigest(['a', 'b']);
    again.add({ a: 'x', b: new Uint8Array([1, 2]) });
    again.add({ a: null, b: 1.5 });
    expect(again.finish()).toEqual(r);
    expect(canonicalValue([255])).toBe('ff');
  });
});

describe('topoOrder', () => {
  const t = (name: string, parents: string[]): TableInfo => ({ name, sql: '', columns: [], pk: [], withoutRowid: false, hasUpdatedAt: false, parents });
  test('parents first, ties by name, cycles do not hang', () => {
    expect(topoOrder([t('orders', ['customers', 'wilayas']), t('communes', ['wilayas']), t('wilayas', []), t('customers', [])])).toEqual([
      'customers',
      'wilayas',
      'communes',
      'orders',
    ]);
    expect(topoOrder([t('a', ['b']), t('b', ['a'])])).toEqual(['a', 'b']);
  });
});
