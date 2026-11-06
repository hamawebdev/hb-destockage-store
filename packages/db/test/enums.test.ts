// The SQL CHECK lists in the migrations must equal the vocabularies @hb/shared owns.
import { describe, expect, test } from 'vitest';
import { ADMIN_ROLES, LANGS, ORDER_STATUSES } from '@hb/shared';
import * as enums from '../src/enums.ts';
import { freshDb } from './helpers.ts';

function checkList(tableSql: string, constraint: string): string[] {
  const m = new RegExp(`CONSTRAINT "${constraint}" CHECK\\("\\w+" in \\(([^)]*)\\)\\)`).exec(tableSql);
  if (!m) throw new Error(`constraint ${constraint} not found`);
  return m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

describe('enum sync with @hb/shared', () => {
  const { sqlite } = freshDb();
  const ddl = (t: string) => (sqlite.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(t) as { sql: string }).sql;

  test('db re-exports the shared arrays (same identity)', () => {
    expect(enums.ORDER_STATUSES).toBe(ORDER_STATUSES);
    expect(enums.ADMIN_ROLES).toBe(ADMIN_ROLES);
    expect(enums.LANGS).toBe(LANGS);
  });
  test.each([
    ['orders', 'orders_status_enum', ORDER_STATUSES],
    ['admin_users', 'admin_users_role_enum', ADMIN_ROLES],
    ['orders', 'orders_lang_enum', LANGS],
    ['admin_users', 'admin_users_ui_lang_enum', LANGS],
    ['rum_events', 'rum_events_lang_enum', LANGS],
  ] as const)('%s.%s equals shared', (table, constraint, list) => {
    expect(checkList(ddl(table), constraint)).toEqual([...list]);
  });
});
