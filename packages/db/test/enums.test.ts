// The SQL CHECK lists in the migrations must equal the vocabularies @hb/shared owns.
import { describe, expect, test } from 'vitest';
import { ADMIN_ROLES, LANGS, ORDER_STATUSES } from '@hb/shared';
import { SNAPSHOT_SETTINGS_KEYS } from '@hb/catalog';
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

describe('delivery enums match their SQL CHECK lists', () => {
  const { sqlite } = freshDb();
  const ddl = (t: string) => (sqlite.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(t) as { sql: string }).sql;
  test.each([
    ['shipments', 'shipments_state_enum', enums.SHIPMENT_STATES],
    ['shipments', 'shipments_delivery_type_enum', enums.DELIVERY_TYPES],
    ['shipment_events', 'shipment_events_mapped_enum', enums.SHIPMENT_COURIER_STATUSES],
    ['shipment_events', 'shipment_events_source_enum', enums.SHIPMENT_EVENT_SOURCES],
    ['shipment_events', 'shipment_events_state_enum', enums.SHIPMENT_EVENT_STATES],
    ['courier_webhook_inbox', 'courier_webhook_inbox_state_enum', enums.WEBHOOK_INBOX_STATES],
    ['delivery_exceptions', 'delivery_exceptions_kind_enum', enums.DELIVERY_EXCEPTION_KINDS],
    ['delivery_exceptions', 'delivery_exceptions_state_enum', enums.DELIVERY_EXCEPTION_STATES],
    ['courier_directory', 'courier_directory_kind_enum', enums.COURIER_DIRECTORY_KINDS],
    ['sheets_connection', 'sheets_connection_status_enum', enums.SHEETS_CONNECTION_STATUSES],
  ] as const)('%s.%s', (table, constraint, list) => {
    expect(checkList(ddl(table), constraint)).toEqual([...list]);
  });
});

describe('settings key registry (CART-1)', () => {
  test('STOREFRONT_SETTINGS_KEYS (copied by the deploy export) equals @hb/catalog SNAPSHOT_SETTINGS_KEYS (read by the snapshot)', () => {
    expect([...enums.STOREFRONT_SETTINGS_KEYS].sort()).toEqual([...SNAPSHOT_SETTINGS_KEYS].sort());
  });
  test('the cart switch and the public Meta keys are storefront keys', () => {
    expect(enums.STOREFRONT_SETTINGS_KEYS).toEqual(expect.arrayContaining(['cartEnabled', 'metaPixelId', 'metaConsentRequired']));
  });
  test('Meta server secrets are registered as internal and are never storefront keys', () => {
    expect(enums.INTERNAL_SETTINGS_KEYS).toMatchObject({ metaAccessTokenEnc: 'meta', metaTestEventCode: 'meta' });
    const storefront = new Set<string>(enums.STOREFRONT_SETTINGS_KEYS);
    for (const k of Object.keys(enums.INTERNAL_SETTINGS_KEYS)) expect(storefront.has(k)).toBe(false);
    for (const k of enums.STOREFRONT_SETTINGS_KEYS) expect(/^metaAccess|^metaTestEventCode$/.test(k)).toBe(false);
  });
});
