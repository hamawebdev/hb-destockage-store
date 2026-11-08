// ADMIN-5: dashboard tiles per role (plan artifacts/ADMIN-5/plan.md) and store settings.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { backupView, safeTile, BACKUP_STALE_HOURS } from '../src/routes/dashboard/data.ts';
import { TILE_ACCESS } from '../src/routes/dashboard/index.tsx';
import { harness, postAs, USERS, type Harness } from './helpers.ts';

// Real D1 (workerd) requests take seconds on the loaded shared machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
const NOW = Date.now();
const HOUR = 3_600_000;

beforeAll(async () => {
  h = await harness();
  const db = h.db;
  await db.batch([
    db.prepare("insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر')"),
    db.prepare("insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى')"),
    db.prepare("insert into customers (phone_e164, name) values ('+213560417403', 'Amina')"),
    db.prepare("insert into categories (slug_fr, slug_ar, name_fr, name_ar) values ('cuisine', 'matbakh', 'Cuisine', 'مطبخ')"),
    db.prepare("insert into products (category_id, slug_fr, slug_ar, name_fr, name_ar) values (1, 'pack-a', 'pack-a', 'Pack A', 'حزمة أ')"),
    db.prepare("insert into variants (product_id, sku, price_dzd, stock, active) values (1, 'PK-A-1', 14600, 2, 1)"),
    db.prepare("insert into variants (product_id, sku, price_dzd, stock, active) values (1, 'PK-A-2', 14600, 50, 1)"),
    db.prepare("insert into variants (product_id, sku, price_dzd, stock, active) values (1, 'PK-A-3', 14600, null, 1)"),
    db.prepare("insert into delivery_fees (wilaya_code, fee_dzd, placeholder) values (16, 400, 1)"),
  ]);
  const order = (ref: string, status: string, flags = '[]', createdAt = NOW) =>
    db
      .prepare(
        "insert into orders (ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, status, subtotal_dzd, fee_dzd, total_dzd, fee_source, flags, created_at) values (?, ?, 1, 'Amina', '+213560417403', 16, 1601, 'ar', ?, 14600, 400, 15000, 'table', ?, ?)",
      )
      .bind(ref, `idem-${ref}`, status, flags, createdAt);
  await db.batch([
    order('HB-AAAA1', 'new'),
    order('HB-AAAA2', 'new', '["duplicate"]'),
    order('HB-AAAA3', 'confirmed'),
    order('HB-AAAA4', 'shipped', '[]', NOW - 3 * 24 * HOUR),
    order('HB-AAAA5', 'delivered', '[]', NOW - 30 * 24 * HOUR),
  ]);
  await db.batch([
    db.prepare("insert into notification_deliveries (order_id, channel, status, last_error, dead_at) values (1, 'telegram', 'dead', 'telegram: HTTP 401', ?)").bind(NOW - HOUR),
    db.prepare("insert into notification_deliveries (order_id, channel, status) values (2, 'telegram', 'sent')"),
    db.prepare("insert into settings (key, value) values ('jobs.backup_status', ?)").bind(
      JSON.stringify({ lastSuccess: { runId: 'r1', at: new Date(NOW - 5 * HOUR).toISOString() }, lastFailure: null, retention: null, health: null }),
    ),
  ]);
}, 120_000);
afterAll(async () => {
  await h?.close();
});

async function tiles(email: string): Promise<{ html: string; names: Set<string> }> {
  const res = await h.as(email, '/dashboard');
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, names: new Set([...html.matchAll(/data-tile="([a-zA-Z]+)"/g)].map((m) => m[1]!)) };
}

describe('tiles per role', () => {
  const expected: Record<string, string[]> = {
    [USERS.owner]: ['orders', 'toCall', 'flagged', 'toShip', 'lowStock', 'placeholderFees', 'backup', 'deadNotifications', 'publish'],
    [USERS.confirmer]: ['orders', 'toCall', 'flagged', 'deadNotifications'],
    [USERS.logistics]: ['orders', 'toShip', 'lowStock'],
    [USERS.content]: ['lowStock', 'publish'],
  };
  for (const [email, names] of Object.entries(expected)) {
    test(`${email}: ${names.join(', ')}`, async () => {
      const t = await tiles(email);
      expect([...t.names].sort()).toEqual([...names].sort());
    });
  }
  test('TILE_ACCESS matches: backup owner only; dead letters owner + confirmer', () => {
    expect(['owner', 'confirmer', 'logistics', 'content'].filter((role) => TILE_ACCESS.backup({ role } as never))).toEqual(['owner']);
    expect(['owner', 'confirmer', 'logistics', 'content'].filter((role) => TILE_ACCESS.deadNotifications({ role } as never))).toEqual(['owner', 'confirmer']);
  });
  test('content sees no order data at all', async () => {
    const { html } = await tiles(USERS.content);
    for (const leak of ['HB-AAAA', 'telegram', 'Amina']) expect(html).not.toContain(leak);
  });
});

describe('tile values', () => {
  const value = (html: string, name: string) => {
    const sec = new RegExp(`data-tile="${name}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
    return /class="tile__value"><span class="num">([^<]+)</.exec(sec)?.[1];
  };
  test('owner: counts from the fixture', async () => {
    const { html } = await tiles(USERS.owner);
    expect(value(html, 'toCall')).toBe('2'); // two "new", next_call_at null
    expect(value(html, 'flagged')).toBe('1');
    expect(value(html, 'toShip')).toBe('1');
    expect(value(html, 'lowStock')).toBe('1'); // stock 2 ≤ 3; 50 and untracked (null) are not low
    expect(value(html, 'placeholderFees')).toBe('1');
    expect(value(html, 'deadNotifications')).toBe('1');
    expect(html).toContain('href="/orders/queue"');
    expect(html).toContain('href="/fees"');
  });
  test('orders: today vs 7 days (the 30-day-old order is in neither)', async () => {
    const { html } = await tiles(USERS.owner);
    const sections = [...html.matchAll(/data-tile="orders"[\s\S]*?<\/section>/g)].map((m) => m[0]);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain('<span class="num">3</span>'); // today: 2 new + 1 confirmed
    expect(sections[1]).toContain('<span class="num">4</span>'); // + shipped 3 days ago
    expect(sections[1]).not.toContain('status=delivered');
  });
  test('dead-letter list: ref, channel and fixed error label, in a stacked table', async () => {
    const { html } = await tiles(USERS.confirmer);
    expect(html).toContain('<bdi dir="ltr" class="code">HB-AAAA1</bdi>');
    expect(html).toContain('telegram: HTTP 401');
    expect(html).toContain('tbl-stack');
  });
  test('Arabic owner gets Arabic tile labels', async () => {
    const { html } = await tiles(USERS.ownerAr);
    expect(html).toContain('آخر نسخة احتياطية');
    expect(html).toContain('طلبات دون إشعار');
  });
});

describe('backup tile (age computed by the admin)', () => {
  const at = (h: number) => new Date(NOW - h * HOUR).toISOString();
  test('fresh, stale, never, failure after success, failure before success, garbage', () => {
    expect(backupView({ lastSuccess: { at: at(5) }, lastFailure: null }, NOW)).toEqual({ state: 'ok', ageHours: 5, failureStage: null });
    expect(backupView({ lastSuccess: { at: at(BACKUP_STALE_HOURS + 1) }, lastFailure: null }, NOW)).toMatchObject({ state: 'stale', ageHours: 27 });
    expect(backupView({ lastSuccess: null, lastFailure: { at: at(1), stage: 'export' } }, NOW)).toEqual({ state: 'never' });
    expect(backupView(undefined, NOW)).toEqual({ state: 'never' });
    expect(backupView({ lastSuccess: { at: at(30) }, lastFailure: { at: at(2), stage: 'upload' } }, NOW)).toEqual({ state: 'stale', ageHours: 30, failureStage: 'upload' });
    expect(backupView({ lastSuccess: { at: at(2) }, lastFailure: { at: at(30), stage: 'upload' } }, NOW)).toMatchObject({ failureStage: null });
    expect(backupView({ nonsense: true }, NOW)).toEqual({ state: 'unavailable' });
    expect(backupView(JSON.stringify({ lastSuccess: { at: at(1) }, lastFailure: null }), NOW)).toMatchObject({ state: 'ok' });
  });
  test('rendered: green when fresh, red when stale (even though health says fine)', async () => {
    let { html } = await tiles(USERS.owner);
    expect(html).toMatch(/tile--success" data-tile="backup"/);
    await h.db
      .prepare("update settings set value = ? where key = 'jobs.backup_status'")
      .bind(JSON.stringify({ lastSuccess: { at: at(40) }, lastFailure: { at: at(1), stage: 'consistency' }, health: { stale: false } }))
      .run();
    ({ html } = await tiles(USERS.owner));
    expect(html).toMatch(/tile--danger" data-tile="backup"/);
    expect(html).toContain('consistency');
  });
});

describe('a missing source never breaks the page', () => {
  test('safeTile turns any error into unavailable', async () => {
    expect(await safeTile('x', async () => 1)).toEqual({ ok: true, value: 1 });
    expect(
      await safeTile('x', async () => {
        throw new Error('no such table: notification_deliveries');
      }),
    ).toEqual({ ok: false });
  });
  test('without the DB-7 table the dead-letter tile says "Indisponible" and the rest renders', async () => {
    const h2 = await harness();
    try {
      await h2.db.prepare('drop table notification_deliveries').run();
      const res = await h2.as(USERS.owner, '/dashboard');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(/data-tile="deadNotifications"[\s\S]*?<\/section>/.exec(html)?.[0]).toContain('Indisponible');
      expect(html).toContain('data-tile="toCall"');
    } finally {
      await h2.close();
    }
  }, 180_000); // starts a second workerd instance
});

describe('store settings', () => {
  const valid = {
    storeName_fr: 'HB Destockage',
    storeName_ar: 'إتش بي ديستوكاج',
    contactPhone: '0560417403',
    whatsapp: '+213 779 94 20 22',
    contactEmail: '',
    orderMaxUnanswered: '3',
    callRetryMinutes: '30',
    unreachableRetryMinutes: '240',
    lowStockThreshold: '5',
  };
  async function setting(key: string) {
    const r = await h.db.prepare('select value from settings where key = ?').bind(key).first<{ value: string }>();
    return r ? JSON.parse(r.value) : undefined;
  }
  test('owner only', async () => {
    for (const u of [USERS.confirmer, USERS.logistics, USERS.content]) {
      expect((await h.as(u, '/settings')).status, u).toBe(403);
      expect((await postAs(h, u, '/settings', valid)).status, u).toBe(403);
    }
    expect((await h.as(USERS.owner, '/settings')).status).toBe(200);
  });
  test('save: CAT-1 shapes, phones through @hb/shared, one audit row per changed key', async () => {
    const res = await postAs(h, USERS.owner, '/settings', { ...valid, whatsapp: '٠٧٧٩٩٤٢٠٢٢' });
    expect(res.status).toBe(303);
    expect(await setting('storeName')).toEqual({ fr: 'HB Destockage', ar: 'إتش بي ديستوكاج' });
    expect(await setting('contactPhone')).toBe('0560417403'); // national
    expect(await setting('whatsapp')).toBe('213779942022'); // E.164 without "+"
    expect(await setting('contactEmail')).toBeNull();
    expect(await setting('lowStockThreshold')).toBe(5);
    const rows = (await h.db.prepare("select entity_id from audit_log where action = 'settings.update' order by id").all<{ entity_id: string }>()).results.map((r) => r.entity_id);
    expect(rows.sort()).toEqual(['callRetryMinutes', 'contactEmail', 'contactPhone', 'lowStockThreshold', 'orderMaxUnanswered', 'storeName', 'unreachableRetryMinutes', 'whatsapp']);
    // The dashboard follows the new threshold.
    const { html } = await tiles(USERS.owner);
    expect(html).toContain('(≤ 5)');
  });
  test('saving again without changes writes nothing; one change writes one row', async () => {
    const n = async () => (await h.db.prepare("select count(*) as n from audit_log where action = 'settings.update'").first<{ n: number }>())!.n;
    const before = await n();
    expect((await postAs(h, USERS.owner, '/settings', { ...valid, whatsapp: '0779942022' })).status).toBe(303);
    expect(await n()).toBe(before);
    expect((await postAs(h, USERS.owner, '/settings', { ...valid, whatsapp: '0779942022', callRetryMinutes: '45' })).status).toBe(303);
    expect(await n()).toBe(before + 1);
  });
  test('invalid: landline / short phone, out-of-range ints, empty name → 422, nothing written', async () => {
    const n = async () => (await h.db.prepare("select count(*) as n from audit_log where action = 'settings.update'").first<{ n: number }>())!.n;
    const before = await n();
    for (const bad of [
      { contactPhone: '021234567' },
      { whatsapp: '0512' },
      { orderMaxUnanswered: '0' },
      { lowStockThreshold: '-1' },
      { storeName_ar: '' },
      { contactEmail: 'nope' },
    ]) {
      const res = await postAs(h, USERS.owner, '/settings', { ...valid, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(await res.text()).toContain('error-summary');
    }
    expect(await n()).toBe(before);
  });
  test('only allowlisted keys are written: jobs-owned, unknown and __proto__ fields are ignored', async () => {
    const backupBefore = await h.db.prepare("select value, updated_at from settings where key = 'jobs.backup_status'").first<{ value: string; updated_at: number }>();
    expect(backupBefore).not.toBeNull();
    const lastAuditId = (await h.db.prepare('select coalesce(max(id), 0) as id from audit_log').first<{ id: number }>())!.id;
    const res = await postAs(h, USERS.owner, '/settings', {
      ...valid,
      whatsapp: '0779942022',
      callRetryMinutes: '50', // one real change, so the write path runs
      'jobs.backup_status': JSON.stringify({ lastSuccess: { at: new Date().toISOString() } }),
      'jobs.notify_invalid': '{"count":0}',
      'jobs.runtime_budget': '{"ms":1}',
      unknownKey: 'x',
      ['__proto__']: 'polluted', // computed key: a real own property, so it is sent as a form field
      'constructor.prototype.polluted': '1',
    });
    expect(res.status).toBe(303);
    // jobs-owned rows untouched
    const backupAfter = await h.db.prepare("select value, updated_at from settings where key = 'jobs.backup_status'").first<{ value: string; updated_at: number }>();
    expect(backupAfter).toEqual(backupBefore);
    for (const k of ['jobs.notify_invalid', 'jobs.runtime_budget', 'unknownKey', '__proto__', 'constructor.prototype.polluted']) {
      expect(await h.db.prepare('select key from settings where key = ?').bind(k).first(), k).toBeNull();
    }
    // exactly one audit row, for the real change
    const rows = (await h.db.prepare('select entity_id from audit_log where id > ? order by id').bind(lastAuditId).all<{ entity_id: string }>()).results;
    expect(rows.map((r) => r.entity_id)).toEqual(['callRetryMinutes']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  test('the form shows stored values (WhatsApp as +E.164) and the publish note', async () => {
    const html = await (await h.as(USERS.owner, '/settings')).text();
    expect(html).toContain('value="+213779942022"');
    expect(html).toContain('<bdi dir="ltr">+213 7 79 94 20 22</bdi>');
    expect(html).toContain('callout--warning');
  });
});
