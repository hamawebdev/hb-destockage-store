// AORD-2 — order detail (real D1 reads) and the POST handlers' pipeline. The DB-4 write
// (`orderWriter.applyChange`) is replaced by a recording fake until DB-4 is on a named sha; the
// guarded-batch behaviour itself is tested against D1 once it lands.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatPhoneDisplay } from '@hb/shared';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertEvent, insertOrder, postAs, refOf, seedGeoAndCatalog } from './fixtures.ts';
import type { OrderChangePlan } from '../../src/routes/orders/workflow.ts';
import type { ApplyResult } from '../../src/routes/orders/writer.ts';

// Real D1 (Miniflare) on a shared, loaded host: explicit budgets so the gate does not time out at random.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const fake = vi.hoisted(() => ({
  calls: [] as { orderId: number; plan: OrderChangePlan }[],
  result: { ok: true, version: 1, status: 'new' } as ApplyResult,
}));

vi.mock('../../src/routes/orders/writer.ts', async (orig) => {
  const real = await orig<typeof import('../../src/routes/orders/writer.ts')>();
  const { audit } = await import('../../src/audit/audit.ts');
  return {
    ...real,
    orderWriter: {
      // Builds the audit row exactly like the real writer (so admin-core's audit guard sees it),
      // records the plan, and returns the configured DB-4 result instead of writing.
      applyChange: async (c: Parameters<typeof audit>[0], orderId: number, plan: OrderChangePlan) => {
        audit(c, { action: plan.audit.action, entity: 'orders', entityId: orderId, before: plan.audit.before, after: plan.audit.after }, { when: real.orderGuard(orderId, plan.expectedVersion) });
        fake.calls.push({ orderId, plan });
        return fake.result;
      },
    },
  };
});

let h: Harness;
const NOW = Date.now();
const R = {
  fresh: refOf(11), // new, flagged
  called: refOf(12), // called, 2 unanswered attempts
  confirmed: refOf(13),
  unreachable: refOf(14),
  shipped: refOf(15),
  blocked: refOf(16),
};
const ids: Record<keyof typeof R, number> = {} as never;
const ADMIN = { owner: 1, confirmer: 2 } as const;

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  ids.fresh = await insertOrder(db, cat, { ref: R.fresh, createdAt: NOW - 3_600_000, status: 'new', flags: ['fast_fill', 'future_flag'], items: [['A', 2], ['B', 1]] });
  ids.called = await insertOrder(db, cat, { ref: R.called, createdAt: NOW - 7_200_000, status: 'called', callAttempts: 2, phone: '+213661234567', name: 'Karim' });
  ids.confirmed = await insertOrder(db, cat, { ref: R.confirmed, createdAt: NOW - 9_000_000, status: 'confirmed', callAttempts: 1, phone: '+213770000004' });
  ids.unreachable = await insertOrder(db, cat, { ref: R.unreachable, createdAt: NOW - 10_000_000, status: 'unreachable', callAttempts: 3, phone: '+213770000005' });
  ids.shipped = await insertOrder(db, cat, { ref: R.shipped, createdAt: NOW - 11_000_000, status: 'shipped', phone: '+213770000006' });
  ids.blocked = await insertOrder(db, cat, { ref: R.blocked, createdAt: NOW - 12_000_000, status: 'new', phone: '+213550000007', blockedCustomer: true });
  const t0 = NOW - 7_200_000;
  await insertEvent(db, ids.called, { type: 'created', at: t0, to: 'new' });
  await insertEvent(db, ids.called, { type: 'call_attempt', at: t0 + 60_000, outcome: 'no_answer', actorUserId: ADMIN.confirmer });
  await insertEvent(db, ids.called, { type: 'status_change', at: t0 + 60_000, from: 'new', to: 'called', actorUserId: ADMIN.confirmer });
  await insertEvent(db, ids.called, { type: 'note', at: t0 + 120_000, note: '<script>alert(1)</script> rappeler après 18h', actorUserId: ADMIN.owner });
  await insertEvent(db, ids.called, { type: 'call_attempt', at: t0 + 180_000, outcome: 'busy', actorUserId: ADMIN.confirmer });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.result = { ok: true, version: 1, status: 'new' };
});

const get = async (email: string, ref: string) => {
  const res = await h.as(email, `/orders/${ref}`);
  return { status: res.status, html: await res.text() };
};
const post = async (email: string, ref: string, action: string, data: Record<string, string>) => {
  const res = await postAs(h, email, `/orders/${ref}/${action}`, data);
  return { status: res.status, location: res.headers.get('Location'), html: await res.text() };
};

describe('GET /orders/:ref', () => {
  test('roles: owner/confirmer/logistics 200, content 403, no user 401', async () => {
    for (const u of [USERS.owner, USERS.confirmer, USERS.logistics]) expect((await get(u, R.fresh)).status).toBe(200);
    const c = await get(USERS.content, R.fresh);
    expect(c.status).toBe(403);
    expect(c.html).not.toContain(R.fresh);
    expect((await h.as(null, `/orders/${R.fresh}`)).status).toBe(401);
  });
  test('unknown or malformed ref → 404', async () => {
    expect((await get(USERS.owner, 'HB-ZZZZZ')).status).toBe(404);
    expect((await get(USERS.owner, R.fresh.toLowerCase())).status).toBe(404);
    expect((await get(USERS.owner, 'HB-OOOOO')).status).toBe(404);
  });
  test('content: bdi phone/ref/sku, tel link, items, money, flags with help, unknown flag raw', async () => {
    const { html } = await get(USERS.owner, R.fresh);
    expect(html).toContain(`<bdi dir="ltr">${formatPhoneDisplay('+213560417403')}</bdi>`);
    expect(html).toContain('href="tel:+213560417403"');
    expect(html).toContain('<bdi dir="ltr">PK-CUI-01</bdi>');
    expect(html).toContain('<bdi dir="ltr">PK-CUI-02</bdi>');
    expect(html).toContain('Total à encaisser');
    expect(html).toContain('plus vite qu’un humain');
    expect(html).toContain('future_flag');
  });
  test('timeline groups same-batch events, escapes note text, shows actor names', async () => {
    const { html } = await get(USERS.owner, R.called);
    expect(html).toContain('Appel : Pas de réponse');
    expect(html).toContain('Appel : Occupé');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('Confirmer');
    expect(html).toContain('le client');
  });
  test('action forms follow the role and the status', async () => {
    const callForm = (html: string, ref: string) => html.includes(`action="/orders/${ref}/call"`);
    const tForm = (html: string, ref: string, to: string) =>
      new RegExp(`action="/orders/${ref}/transition"[\\s\\S]*?name="to" value="${to}"`).test(html);
    const noteForm = (html: string, ref: string) => html.includes(`action="/orders/${ref}/note"`);

    const conf = (await get(USERS.confirmer, R.fresh)).html;
    expect(callForm(conf, R.fresh)).toBe(true);
    expect(noteForm(conf, R.fresh)).toBe(true);
    const logi = (await get(USERS.logistics, R.fresh)).html;
    expect(callForm(logi, R.fresh)).toBe(false);
    expect(noteForm(logi, R.fresh)).toBe(true);

    const shipL = (await get(USERS.logistics, R.confirmed)).html;
    expect(tForm(shipL, R.confirmed, 'shipped')).toBe(true);
    expect(tForm(shipL, R.confirmed, 'cancelled')).toBe(false);
    const shipC = (await get(USERS.confirmer, R.confirmed)).html;
    expect(tForm(shipC, R.confirmed, 'shipped')).toBe(false);
    expect(tForm(shipC, R.confirmed, 'cancelled')).toBe(true);
    expect(callForm(shipC, R.confirmed)).toBe(false);

    const unr = (await get(USERS.confirmer, R.unreachable)).html;
    expect(callForm(unr, R.unreachable)).toBe(true);
    expect(tForm(unr, R.unreachable, 'cancelled')).toBe(true);

    const own = (await get(USERS.owner, R.shipped)).html;
    expect(tForm(own, R.shipped, 'delivered')).toBe(true);
    expect(tForm(own, R.shipped, 'returned')).toBe(true);
  });
  test('flagged order: the "flags checked" box is in the call form; unflagged: not', async () => {
    expect((await get(USERS.confirmer, R.fresh)).html).toContain('name="flagsChecked"');
    expect((await get(USERS.confirmer, R.called)).html).not.toContain('name="flagsChecked"');
  });
  test('blocked customer banner', async () => {
    expect((await get(USERS.confirmer, R.blocked)).html).toContain('Client bloqué : vérifiez');
  });
  test('every element id is unique, no inline script/style/handlers', async () => {
    for (const ref of [R.fresh, R.unreachable, R.confirmed]) {
      const { html } = await get(USERS.owner, ref);
      const idsOnPage = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(idsOnPage).size, ref).toBe(idsOnPage.length);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toMatch(/\son[a-z]+=/);
    }
  });
  test('Arabic: rtl, Arabic status and labels, ref still LTR-isolated', async () => {
    const { html } = await get(USERS.ownerAr, R.fresh);
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    expect(html).toContain('المبلغ المطلوب تحصيله');
    expect(html).toContain('جديد');
    expect(html).toContain(`<bdi dir="ltr">${R.fresh}</bdi>`);
    expect(html).toContain(`<title>الطلب \u2066${R.fresh}\u2069`);
  });
});

describe('POST /orders/:ref/call', () => {
  test('confirmer confirms a flagged new order (box ticked) → 303, plan new→called→confirmed', async () => {
    const r = await post(USERS.confirmer, R.fresh, 'call', { version: '0', outcome: 'confirmed', flagsChecked: '1', address: 'Cité 5 juillet, bt 3' });
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/orders/${R.fresh}?m=saved`);
    expect(fake.calls).toHaveLength(1);
    const { orderId, plan } = fake.calls[0]!;
    expect(orderId).toBe(ids.fresh);
    expect(plan.hops).toEqual([['new', 'called'], ['called', 'confirmed']]);
    expect(plan.expectedVersion).toBe(0);
    expect(plan.patch).toEqual({ nextCallAt: null, address: 'Cité 5 juillet, bt 3' });
    expect(plan.audit.action).toBe('order.call');
  });
  test('flagged order without the box → 422, nothing written, error shown', async () => {
    const r = await post(USERS.confirmer, R.fresh, 'call', { version: '0', outcome: 'confirmed' });
    expect(r.status).toBe(422);
    expect(fake.calls).toHaveLength(0);
    expect(r.html).toContain('Cochez la case');
  });
  test('the unanswered streak comes from the timeline: 3rd unanswered call → unreachable', async () => {
    const r = await post(USERS.confirmer, R.called, 'call', { version: '0', outcome: 'no_answer' });
    expect(r.status).toBe(303);
    expect(fake.calls[0]!.plan.hops).toEqual([['called', 'unreachable']]);
  });
  test('callback without a time → 422; with a time → nextCallAt', async () => {
    expect((await post(USERS.confirmer, R.called, 'call', { version: '0', outcome: 'callback' })).status).toBe(422);
    const at = new Date(NOW + 2 * 86_400_000 + 3_600_000);
    const local = new Date(at.getTime() + 3_600_000).toISOString().slice(0, 16);
    const r = await post(USERS.confirmer, R.called, 'call', { version: '0', outcome: 'callback', callbackAt: local });
    expect(r.status).toBe(303);
    expect(fake.calls.at(-1)!.plan.patch.nextCallAt).toBe(Math.floor(at.getTime() / 60_000) * 60_000);
  });
  test('logistics and content cannot log calls (403, nothing written)', async () => {
    for (const u of [USERS.logistics, USERS.content]) {
      expect((await post(u, R.fresh, 'call', { version: '0', outcome: 'no_answer' })).status).toBe(403);
    }
    expect(fake.calls).toHaveLength(0);
  });
  test('a call on a confirmed order → 409 not callable', async () => {
    const r = await post(USERS.owner, R.confirmed, 'call', { version: '0', outcome: 'no_answer' });
    expect(r.status).toBe(409);
    expect(r.html).toContain('ne peut plus être appelée');
    expect(fake.calls).toHaveLength(0);
  });
  test('stale version → 409 conflict page before any write', async () => {
    const r = await post(USERS.confirmer, R.called, 'call', { version: '5', outcome: 'no_answer' });
    expect(r.status).toBe(409);
    expect(r.html).toContain('Commande modifiée entre-temps');
    expect(r.html).toContain('Confirmer');
    expect(fake.calls).toHaveLength(0);
  });
  test('lost race inside the batch (DB-4 version_conflict) → 409 conflict page', async () => {
    fake.result = { ok: false, code: 'version_conflict' };
    const r = await post(USERS.confirmer, R.called, 'call', { version: '0', outcome: 'busy' });
    expect(r.status).toBe(409);
    expect(r.html).toContain('Rien n’a été enregistré');
  });
  test('bad form (unknown outcome, missing version) → 422', async () => {
    expect((await post(USERS.confirmer, R.called, 'call', { version: '0', outcome: 'maybe' })).status).toBe(422);
    expect((await post(USERS.confirmer, R.called, 'call', { outcome: 'busy' })).status).toBe(422);
    expect(fake.calls).toHaveLength(0);
  });
  test('unknown ref → 404', async () => {
    expect((await post(USERS.confirmer, 'HB-ZZZZZ', 'call', { version: '0', outcome: 'busy' })).status).toBe(404);
  });
});

describe('POST /orders/:ref/transition', () => {
  test('logistics ships a confirmed order with a courier → 303', async () => {
    const r = await post(USERS.logistics, R.confirmed, 'transition', { version: '0', to: 'shipped', courierName: 'Yalidine', courierTracking: 'YAL-889' });
    expect(r.status).toBe(303);
    expect(fake.calls[0]!.plan).toMatchObject({ hops: [['confirmed', 'shipped']], patch: { courierName: 'Yalidine', courierTracking: 'YAL-889' } });
  });
  test('shipping without a courier → 422 with the field error', async () => {
    const r = await post(USERS.logistics, R.confirmed, 'transition', { version: '0', to: 'shipped' });
    expect(r.status).toBe(422);
    expect(r.html).toContain('Indiquez le transporteur');
  });
  test('confirmer may not ship (403); logistics may not cancel (403)', async () => {
    expect((await post(USERS.confirmer, R.confirmed, 'transition', { version: '0', to: 'shipped', courierName: 'x' })).status).toBe(403);
    expect((await post(USERS.logistics, R.confirmed, 'transition', { version: '0', to: 'cancelled', reason: 'other' })).status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });
  test('confirmer cancels an unreachable order with reason → 303, restores stock', async () => {
    const r = await post(USERS.confirmer, R.unreachable, 'transition', { version: '0', to: 'cancelled', reason: 'unreachable' });
    expect(r.status).toBe(303);
    expect(fake.calls[0]!.plan).toMatchObject({ outcome: 'unreachable', restoresStock: true });
  });
  test('a call-driven transition is refused here (409)', async () => {
    const r = await post(USERS.owner, R.called, 'transition', { version: '0', to: 'confirmed' });
    expect(r.status).toBe(409);
    expect(r.html).toContain('en enregistrant un appel');
  });
  test('content gets 403 on the route', async () => {
    expect((await post(USERS.content, R.shipped, 'transition', { version: '0', to: 'delivered' })).status).toBe(403);
  });
});

describe('POST /orders/:ref/note', () => {
  test('logistics adds a note on any status → 303', async () => {
    const r = await post(USERS.logistics, R.shipped, 'note', { version: '0', text: 'Client absent, repasser demain' });
    expect(r.status).toBe(303);
    expect(fake.calls[0]!.plan).toMatchObject({ hops: [], note: 'Client absent, repasser demain', audit: { action: 'order.note' } });
  });
  test('empty note → 422; content → 403', async () => {
    expect((await post(USERS.logistics, R.shipped, 'note', { version: '0', text: '   ' })).status).toBe(422);
    expect((await post(USERS.content, R.shipped, 'note', { version: '0', text: 'x' })).status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });
});
