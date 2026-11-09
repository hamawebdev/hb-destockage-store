import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapStatus, statusTable, type StatusTable } from '../src/status.ts';
import { YALIDINE_STATUSES } from '../src/yalidine/statuses.ts';
import type { CourierStatus } from '../src/types.ts';

interface ListEntry {
  raw: string;
  result: CourierStatus;
  vocabulary?: string;
}

const readList = (name: string) =>
  JSON.parse(readFileSync(new URL(`./status-lists/${name}.json`, import.meta.url), 'utf8')) as {
    statuses: ListEntry[];
  };

const TABLES: Array<{ name: string; list: string; table: StatusTable; vocabulary?: string }> = [
  { name: 'yalidine', list: 'yalidine', table: YALIDINE_STATUSES },
];

const setOf = (table: StatusTable, status: CourierStatus) =>
  [...table].filter(([, value]) => value === status).map(([raw]) => raw).sort();

describe.each(TABLES)('$name status table', ({ list, table, vocabulary }) => {
  const entries = readList(list).statuses.filter((s) => (vocabulary ? s.vocabulary === vocabulary : true));

  it('maps every entry of the list to its result', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect([entry.raw, mapStatus(table, entry.raw)]).toEqual([entry.raw, entry.result]);
    }
  });

  it('has exactly the keys of the list', () => {
    expect([...table.keys()].sort()).toEqual(entries.map((e) => e.raw).sort());
  });

  it('never maps a delivery in progress to delivered', () => {
    for (const raw of [
      'en cours de livraison',
      'En cours de livraison',
      'Livraison en cours',
      'Tentative de livraison',
      'Non livré',
      'Echec de livraison',
    ]) {
      expect(mapStatus(table, raw)).not.toBe('delivered');
    }
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'xyz',
    'LIVRE',
    'constructor',
    '__proto__',
    'toString',
    5,
    true,
    ['Livré'],
    { toString: () => 'Livré' },
  ])('treats %j as unknown', (raw) => {
    expect(mapStatus(table, raw)).toBe('unknown');
  });
});

describe('exact sets that move an order or restock', () => {
  it('Yalidine family', () => {
    expect(setOf(YALIDINE_STATUSES, 'delivered')).toEqual(['Livré']);
    expect(setOf(YALIDINE_STATUSES, 'returned')).toEqual(['Retourné au vendeur']);
    expect(setOf(YALIDINE_STATUSES, 'returning')).toEqual(
      [
        'Retour vers centre',
        'Retourné au centre',
        'Retour transfert',
        'Retour groupé',
        'Retour à retirer',
        'Retour vers vendeur',
      ].sort(),
    );
  });

  it('a return on its way is never returned', () => {
    for (const raw of ['Retour vers vendeur', 'Retour à retirer', 'Retourné au centre']) {
      expect(mapStatus(YALIDINE_STATUSES, raw)).toBe('returning');
    }
  });
});

describe('normalisation', () => {
  const table = statusTable({ Livré: 'delivered' });

  it('trims outer whitespace', () => {
    expect(mapStatus(table, 'Livré ')).toBe('delivered');
    expect(mapStatus(table, '  Livré')).toBe('delivered');
  });

  it('treats composed and decomposed forms alike', () => {
    expect(mapStatus(table, 'Livré'.normalize('NFD'))).toBe('delivered');
    expect(mapStatus(table, 'Livré'.normalize('NFC'))).toBe('delivered');
  });

  it('does not fold case or accents', () => {
    expect(mapStatus(table, 'livré')).toBe('unknown');
    expect(mapStatus(table, 'Livre')).toBe('unknown');
  });
});

// `artifacts/` is gitignored and absent from worktrees, so this runs when the path is given:
// HB_STATUS_LISTS_DIR="/mnt/data/ecom website/artifacts/delivery-research/status-lists" npm test -w @hb/couriers
describe('committed lists match the research folder', () => {
  const dir = process.env['HB_STATUS_LISTS_DIR'];

  it.runIf(dir !== undefined)('the folder exists', () => {
    expect(existsSync(dir as string)).toBe(true);
  });

  it.runIf(dir !== undefined).each(TABLES.map((t) => t.list))('%s is identical', (name) => {
    const committed = readFileSync(new URL(`./status-lists/${name}.json`, import.meta.url), 'utf8');
    expect(committed).toBe(readFileSync(`${dir as string}/${name}.json`, 'utf8'));
  });
});
