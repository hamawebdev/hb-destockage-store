import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCourier } from '../src/registry.ts';
import { canEnable, foundDisposition, isResendSafe } from '../src/resend.ts';
import type { CourierContext, CourierLists, LookupFound, ParcelInput, PreparedParcel } from '../src/types.ts';
import { zrExpress as adapter } from '../src/zr-express/adapter.ts';
import { startStandin, type Standin } from './helpers/standin.ts';

const GOOD = { apiKey: 'standin-key', tenantId: 'standin-tenant' };
const BAD = { apiKey: 'nope', tenantId: 'nope' };
const courier = 'zr-express';

let standin: Standin;
beforeAll(async () => {
  standin = await startStandin();
});
afterAll(async () => {
  await standin.stop();
});

const communes = JSON.parse(readFileSync(new URL('../../../data/geo/communes.json', import.meta.url), 'utf8')) as Array<{
  wilaya_code: number;
  name_fr: string;
  name_ar: string;
}>;
const sample = communes.find((c) => c.wilaya_code <= 58 && /[éèïîâ]/.test(c.name_fr));
if (!sample) throw new Error('needs an accented commune');
const WILAYA = sample.wilaya_code;

const ctx = (extra: Partial<CourierContext> = {}): CourierContext => ({
  env: 'test',
  standinUrl: standin.url,
  timeoutMs: 400,
  ...extra,
});

const input = (overrides: Partial<ParcelInput> = {}): ParcelInput => ({
  reference: 'HB-ZR001',
  recipientName: 'Amina Benali',
  phone: '0560417403',
  wilayaCode: WILAYA,
  commune: { nameFr: sample.name_fr, nameAr: sample.name_ar },
  deliveryType: 'home',
  address: '12 rue Didouche',
  codTotalDzd: 5600,
  productLabel: 'Sac x1',
  ...overrides,
});

const loadLists = async (wilaya = WILAYA): Promise<CourierLists> => {
  const [wilayas, list, desks] = await Promise.all([
    adapter.listWilayas(GOOD, ctx({ timeoutMs: 3000 })),
    adapter.listCommunes(wilaya, GOOD, ctx({ timeoutMs: 3000 })),
    adapter.listStopDesks(wilaya, GOOD, ctx({ timeoutMs: 3000 })),
  ]);
  if (!wilayas.ok || !list.ok || !desks.ok) throw new Error('lists failed');
  return { wilayas: wilayas.items, communes: list.items, stopDesks: desks.items };
};

const prepared = async (overrides: Partial<ParcelInput> = {}): Promise<PreparedParcel> => {
  const result = adapter.prepare(input(overrides), await loadLists(overrides.wilayaCode ?? WILAYA));
  if (!result.ok) throw new Error(`prepare failed: ${result.code} ${result.detail}`);
  return result.parcel;
};

const seed = async (parcels: Array<Record<string, unknown>>) =>
  ((await standin.control(`${courier}/seed`, { parcels })) as { trackings: string[] }).trackings;
const fullState = async () =>
  (await standin.state(courier)) as unknown as {
    createCount: number;
    stateWrites: number;
    readCount: number;
    parcels: Array<Record<string, unknown>>;
    lastCreateBody: { parcels: Array<Record<string, unknown>> };
    lastSearchBody: Record<string, unknown>;
    lastStateBody: Record<string, unknown>;
  };

beforeEach(async () => {
  await standin.reset();
  await standin.scenario(courier, { quota: false });
});

describe('registry and confidence', () => {
  it('is registered and says what is unconfirmed', () => {
    expect(getCourier('zr-express')).toBe(adapter);
    expect(adapter.confidence).toMatchObject({ baseUrl: 'probed', statusList: 'unofficial' });
    expect(adapter.confidence.notes).toEqual(expect.arrayContaining(['amount_split_unconfirmed', 'status_list_tenant_configurable', 'key_expires']));
    expect(canEnable(adapter, null)).toBe(true);
  });

  it('has the agreed capabilities', () => {
    expect(adapter.capabilities).toMatchObject({
      verifyByReference: true,
      verifyAfterSeconds: 300,
      verifyWithinSeconds: null,
      needsValidation: true,
      pollBatchSize: 100,
      webhook: 'hmac',
    });
  });
});

describe('createParcel', () => {
  it('creates a draft through bulk, with the total as the amount and our ref as externalId', async () => {
    const parcel = await prepared();
    const result = await adapter.createParcel(parcel, GOOD, ctx());
    expect(result).toMatchObject({ kind: 'accepted', draft: true });
    const state = await fullState();
    expect(state.createCount).toBe(1);
    expect(state.lastCreateBody.parcels).toHaveLength(1);
    const row = state.lastCreateBody.parcels[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      externalId: 'HB-ZR001',
      amount: 5600,
      deliveryType: 'home',
      orderedProducts: [{ productName: 'Sac x1', unitPrice: 5600, quantity: 1, stockType: 'none' }],
    });
    expect((row['customer'] as { phone: { number1: string } }).phone.number1).toBe('+213560417403');
  });

  it('never sends a second parcel: a resend of the same ref is the duplicate, and uncertain', async () => {
    const parcel = await prepared();
    await adapter.createParcel(parcel, GOOD, ctx());
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'duplicate_external_id' });
    const state = await fullState();
    expect(state.createCount).toBe(2);
    expect(state.parcels).toHaveLength(1);
  });

  it.each([['reject', 'Validation failed']])('a 400 with an allow-listed failure row is rejected (%s)', async (create, detail) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'rejected', code: 'courier_refused', detail });
  });

  it('a 400 with no failures array is a definite rejection', async () => {
    const parcel = await prepared();
    await standin.scenario(courier, { create: 'request-error' });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toMatchObject({ kind: 'rejected', code: 'bad_request', detail: 'Malformed body' });
  });

  it.each(['db-error', 'unexpected-error', 'unlisted-error'])('a %s row proves nothing, so uncertain', async (create) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create });
    expect((await adapter.createParcel(parcel, GOOD, ctx())).kind).toBe('uncertain');
  });

  it.each(['zero', 'other-ref', 'both', 'bad-tracking', 'bad-json', 'html', 'redirect', '408', '409', '425', '500-no-create'])(
    'an odd answer (%s) is uncertain',
    async (create) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create });
      expect((await adapter.createParcel(parcel, GOOD, ctx())).kind).toBe('uncertain');
      expect((await fullState()).createCount).toBe(1);
    },
  );

  it('wrong credentials are refused with no forced scenario', async () => {
    expect(await adapter.createParcel(await prepared(), BAD, ctx())).toMatchObject({ kind: 'rejected', code: 'auth' });
  });

  it('a quota overrun is rejected with a delay', async () => {
    const parcel = await prepared();
    await standin.reset();
    await standin.scenario(courier, { quota: true });
    let limited;
    for (let i = 0; i < 70 && !limited; i += 1) {
      const result = await adapter.createParcel({ ...parcel, reference: `R${i}`, payload: { ...parcel.payload, externalId: `R${i}` } }, GOOD, ctx());
      if (result.kind === 'rejected' && result.code === 'rate_limited') limited = result;
    }
    expect(limited).toHaveProperty('retryAfterMs');
  });

  it('never leaks a token the courier echoes', async () => {
    const parcel = await prepared();
    await standin.scenario(courier, { create: 'echo-token' });
    const result = await adapter.createParcel(parcel, GOOD, ctx());
    expect(result.kind).toBe('rejected');
    expect(JSON.stringify(result)).not.toContain('standin-key');
  });

  it('refuses another courier’s parcel', async () => {
    expect(await adapter.createParcel({ courier: 'x', reference: 'r', payload: {} }, GOOD, ctx())).toMatchObject({ code: 'wrong_courier' });
  });
});

describe('a create that may or may not have happened', () => {
  const lookup = () => adapter.findByReference('HB-ZR001', { attemptedAt: Date.now() }, GOOD, ctx({ timeoutMs: 2000 }));

  it.each(['create-then-hang', 'headers-then-stall'])('%s: uncertain, then found as a draft', async (create) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create });
    expect(await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 150 }))).toEqual({ kind: 'uncertain', cause: 'timeout' });
    const found = await lookup();
    expect(found).toMatchObject({ kind: 'found', status: 'pending', gone: false });
    expect(foundDisposition(found as LookupFound, adapter.capabilities)).toBe('draft');
  });

  it.each([
    ['hang-no-create', 'not_found'],
    ['500-no-create', 'not_found'],
    ['500-after-create', 'found'],
  ])('%s: uncertain, then %s', async (create, expected) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create });
    expect((await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 150 }))).kind).toBe('uncertain');
    expect((await lookup()).kind).toBe(expected);
    expect((await fullState()).createCount).toBe(1);
  });

  it('create-late: an early not_found does not permit a resend', async () => {
    const parcel = await prepared();
    await standin.scenario(courier, { create: 'create-late', lateMs: 600 });
    expect((await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 100 }))).kind).toBe('uncertain');
    const attemptEndedAt = Date.now();
    const early = await lookup();
    expect(early.kind).toBe('not_found');
    expect(isResendSafe(early, attemptEndedAt, adapter.capabilities, null)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect((await lookup()).kind).toBe('found');
  });
});

describe('validateParcel', () => {
  const options = { askCollection: false };
  const created = async () => {
    const result = await adapter.createParcel(await prepared(), GOOD, ctx());
    if (result.kind !== 'accepted') throw new Error('not accepted');
    return result.tracking;
  };

  it('moves the draft to the ready state, once', async () => {
    const tracking = await created();
    expect(await adapter.validateParcel(tracking, options, GOOD, ctx())).toEqual({ kind: 'validated' });
    const state = await fullState();
    expect(state.stateWrites).toBe(1);
    expect(state.parcels[0]?.['state']).toMatchObject({ name: 'pret_a_expedier' });
    expect(state.lastStateBody['parcelId']).toBe(state.parcels[0]?.['id']);
    expect(state.createCount).toBe(1);
  });

  it('uses the workflow holding the parcel’s current state, not the default one', async () => {
    const workflows = [
      { id: 'w1', name: 'First', isDefault: true, states: [{ id: 's1', name: 'pret_a_expedier' }] },
      {
        id: 'w2',
        name: 'Holds the parcel',
        isDefault: false,
        states: [
          { id: 'CURRENT', name: 'commande_recue' },
          { id: 'TARGET', name: 'pret_a_expedier' },
        ],
      },
    ];
    await standin.reset();
    await standin.scenario(courier, { quota: false, workflows });
    const [tracking] = await seed([{ state: 'commande_recue' }]);
    expect(await adapter.validateParcel(tracking as string, options, GOOD, ctx())).toEqual({ kind: 'validated' });
    expect((await fullState()).lastStateBody['newStateId']).toBe('TARGET');
  });

  it('is already validated at the ready state, with no write', async () => {
    const [tracking] = await seed([{ state: 'pret_a_expedier' }]);
    expect(await adapter.validateParcel(tracking as string, options, GOOD, ctx())).toEqual({ kind: 'validated' });
    expect((await fullState()).stateWrites).toBe(0);
  });

  it('never drags a moving parcel back', async () => {
    const [tracking] = await seed([{ state: 'sortie_en_livraison' }]);
    expect(await adapter.validateParcel(tracking as string, options, GOOD, ctx())).toMatchObject({ kind: 'rejected', code: 'locked' });
    expect((await fullState()).stateWrites).toBe(0);
  });

  it('an unknown state is left alone', async () => {
    const [tracking] = await seed([{ state: 'etat_maison' }]);
    await standin.scenario(courier, { workflows: [{ id: 'w', name: 'x', isDefault: true, states: [{ id: 'a', name: 'etat_maison' }] }] });
    const result = await adapter.validateParcel(tracking as string, options, GOOD, ctx());
    expect(result).toMatchObject({ kind: 'rejected', code: 'locked' });
    expect((await fullState()).stateWrites).toBe(0);
  });

  it.each([
    ['no workflow holds the state', [{ id: 'w', name: 'x', isDefault: true, states: [{ id: 'other', name: 'pret_a_expedier' }] }]],
    [
      'two matching states',
      [
        {
          id: 'w',
          name: 'x',
          isDefault: true,
          states: [
            { id: 'CUR', name: 'commande_recue' },
            { id: 'a', name: 'pret_a_expedier' },
            { id: 'b', name: 'pret_a_expedier' },
          ],
        },
      ],
    ],
    ['no ready state', [{ id: 'w', name: 'x', isDefault: true, states: [{ id: 'CUR', name: 'commande_recue' }] }]],
  ])('%s is refused with no write', async (_label, workflows) => {
    await standin.scenario(courier, { workflows });
    const [tracking] = await seed([{ state: 'commande_recue' }]);
    const current = (await fullState()).parcels[0]?.['state'] as { id: string };
    if (_label !== 'no workflow holds the state') {
      expect(current.id).toBe('CUR');
    }
    expect(await adapter.validateParcel(tracking as string, options, GOOD, ctx())).toMatchObject({ kind: 'rejected', code: 'bad_request' });
    expect((await fullState()).stateWrites).toBe(0);
  });

  it('a failed read is uncertain', async () => {
    const tracking = await created();
    await standin.scenario(courier, { read: 'down' });
    expect((await adapter.validateParcel(tracking, options, GOOD, ctx())).kind).toBe('uncertain');
  });

  it('a hanging state change is uncertain and is not retried', async () => {
    const tracking = await created();
    await standin.scenario(courier, { validate: 'hang' });
    expect(await adapter.validateParcel(tracking, options, GOOD, ctx({ timeoutMs: 150 }))).toEqual({ kind: 'uncertain', cause: 'timeout' });
    expect((await fullState()).stateWrites).toBe(1);
  });

  it('a 500 on the state change is uncertain', async () => {
    const tracking = await created();
    await standin.scenario(courier, { validate: '500' });
    expect((await adapter.validateParcel(tracking, options, GOOD, ctx())).kind).toBe('uncertain');
  });

  it('a 200 naming another state is uncertain', async () => {
    const tracking = await created();
    await standin.scenario(courier, { validate: 'other-name' });
    expect(await adapter.validateParcel(tracking, options, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'malformed_response' });
  });

  it('a parcel id that could change the path is uncertain, with no write', async () => {
    const answers = [JSON.stringify({ id: '../../admin', state: { id: 's', name: 'commande_recue' } })];
    const spy = vi.fn<typeof fetch>(async () => new Response(answers[0]));
    expect(await adapter.validateParcel('16-A-ZR', options, GOOD, ctx({ fetch: spy }))).toEqual({ kind: 'uncertain', cause: 'malformed_response' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid tracking without calling out', async () => {
    const spy = vi.fn<typeof fetch>();
    expect(await adapter.validateParcel('../x', options, GOOD, ctx({ fetch: spy }))).toMatchObject({ code: 'bad_request' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('findByReference', () => {
  const find = (reference: string) => adapter.findByReference(reference, { attemptedAt: Date.now() }, GOOD, ctx());

  it('finds by exact externalId', async () => {
    await seed([{ externalId: 'HB-X', state: 'dispatch' }]);
    expect(await find('HB-X')).toMatchObject({ kind: 'found', status: 'in_transit', gone: false });
    expect((await fullState()).lastSearchBody['advancedFilter']).toEqual({
      logic: 'and',
      filters: [{ field: 'externalId', operator: 'eq', value: 'HB-X' }],
    });
  });

  it('stamps checkedAt on not_found', async () => {
    const result = await adapter.findByReference('HB-NONE', { attemptedAt: 1 }, GOOD, ctx({ now: () => 555 }));
    expect(result).toEqual({ kind: 'not_found', checkedAt: 555 });
  });

  it.each(['no-items', 'no-total', 'bad-json', 'html', '401', '429', '503', 'down', 'none-exact'])('%s is unavailable', async (read) => {
    await seed([{ externalId: 'HB-OTHER' }]);
    await standin.scenario(courier, { read });
    expect((await find('HB-X')).kind).toBe('unavailable');
  });

  it('carries the delay on 429', async () => {
    await standin.scenario(courier, { read: '429' });
    expect(await find('HB-X')).toMatchObject({ kind: 'unavailable', retryAfterMs: 9000 });
  });

  it('a POST-based read is not retried on 503', async () => {
    await standin.scenario(courier, { read: '503' });
    await find('HB-X');
    expect((await fullState()).readCount).toBe(1);
  });

  it('two exact rows are multiple even if one has an unusable tracking', async () => {
    const body = { items: [{ externalId: 'R', trackingNumber: '16-A-ZR' }, { externalId: 'R', trackingNumber: 'bad,one' }], totalCount: 2, hasNext: false };
    const result = await adapter.findByReference('R', { attemptedAt: 1 }, GOOD, ctx({ fetch: async () => new Response(JSON.stringify(body)) }));
    expect(result).toEqual({ kind: 'multiple', trackings: ['16-A-ZR'] });
  });

  it('two exact rows are multiple', async () => {
    await seed([{ externalId: 'HB-DUP' }, { externalId: 'HB-DUP' }]);
    expect((await find('HB-DUP')).kind).toBe('multiple');
  });

  it('a returning parcel found later is shipped, not a draft', async () => {
    await seed([{ externalId: 'HB-R', state: 'dispatch', isReturn: true }]);
    const found = await find('HB-R');
    expect(found).toMatchObject({ kind: 'found', status: 'returning' });
    expect(foundDisposition(found as LookupFound, adapter.capabilities)).toBe('shipped');
  });

  it('needs the attempt time', async () => {
    expect(await adapter.findByReference('X', { attemptedAt: Number.NaN }, GOOD, ctx())).toMatchObject({ cause: 'attempted_at_missing' });
  });
});

describe('fetchStatuses', () => {
  it('sends the exact filter, and maps state, isReturn and situation', async () => {
    const [a, b] = await seed([
      { state: 'sortie_en_livraison', situation: 'Ne répond pas 1', lastStateUpdateAt: '2025-12-30T13:24:34.4697455+00:00' },
      { state: 'dispatch', isReturn: true },
    ]);
    const result = await adapter.fetchStatuses([a as string, b as string, 'a,b'], GOOD, ctx());
    if (!result.ok) throw new Error(result.cause);
    expect(result.invalid).toEqual(['a,b']);
    expect((await fullState()).lastSearchBody['advancedFilter']).toEqual({
      logic: 'or',
      filters: [
        { field: 'trackingNumber', operator: 'eq', value: a },
        { field: 'trackingNumber', operator: 'eq', value: b },
      ],
    });
    const first = result.events.find((e) => e.tracking === a);
    expect(first).toMatchObject({ status: 'in_transit', reason: 'Ne répond pas 1', occurredAt: Date.parse('2025-12-30T13:24:34.469Z') });
    expect(first?.eventKey).toBe(`${a as string}|sortie_en_livraison|false|${Date.parse('2025-12-30T13:24:34.469Z')}`);
    expect(result.events.find((e) => e.tracking === b)?.status).toBe('returning');
  });

  it('reports one absent tracking', async () => {
    const [a] = await seed([{ state: 'dispatch' }]);
    const result = await adapter.fetchStatuses([a as string, '16-NOPE-ZR'], GOOD, ctx());
    expect(result).toMatchObject({ ok: true, absent: ['16-NOPE-ZR'] });
  });

  it('fails when a whole batch comes back absent', async () => {
    await standin.scenario(courier, { pollFilter: 'ignored' });
    expect(await adapter.fetchStatuses(['16-A-ZR', '16-B-ZR'], GOOD, ctx())).toEqual({ ok: false, cause: 'filter_returned_nothing' });
  });

  it('a single absent tracking is not treated as a broken query', async () => {
    await standin.scenario(courier, { pollFilter: 'ignored' });
    expect(await adapter.fetchStatuses(['16-A-ZR'], GOOD, ctx())).toMatchObject({ ok: true, absent: ['16-A-ZR'] });
  });

  it('a rejected key is a stable cause', async () => {
    await standin.scenario(courier, { read: '401' });
    expect(await adapter.fetchStatuses(['16-A-ZR'], GOOD, ctx())).toEqual({ ok: false, cause: 'http_401' });
  });

  it('keeps good rows beside a bad one', async () => {
    const body = { items: [{ trackingNumber: '16-A-ZR', state: { name: 'dispatch' } }, { trackingNumber: '16-B-ZR' }, 'x'], totalCount: 3, hasNext: false };
    const result = await adapter.fetchStatuses(['16-A-ZR', '16-B-ZR'], GOOD, ctx({ fetch: async () => new Response(JSON.stringify(body)) }));
    expect(result).toMatchObject({ ok: true, badRows: 2, absent: ['16-B-ZR'] });
  });

  it('maps display names exactly: another casing is unknown', async () => {
    const answer = (name: string): typeof fetch => async () =>
      new Response(JSON.stringify({ items: [{ trackingNumber: '16-A-ZR', state: { name } }], totalCount: 1, hasNext: false }));
    const known = await adapter.fetchStatuses(['16-A-ZR'], GOOD, ctx({ fetch: answer('Out for Delivery') }));
    expect(known.ok && known.events[0]?.status).toBe('in_transit');
    const other = await adapter.fetchStatuses(['16-A-ZR'], GOOD, ctx({ fetch: answer('OUT FOR DELIVERY') }));
    expect(other.ok && other.events[0]?.status).toBe('unknown');
  });

  it('an isReturn flip gets a new key on the same state and time', async () => {
    const [a] = await seed([{ state: 'dispatch', lastStateUpdateAt: '2026-01-02T10:00:00Z' }]);
    const poll = async () => {
      const result = await adapter.fetchStatuses([a as string], GOOD, ctx());
      if (!result.ok || !result.events[0]) throw new Error('no event');
      return result.events[0];
    };
    const before = await poll();
    await standin.control(`${courier}/parcels/${a as string}/status`, { isReturn: true });
    const after = await poll();
    expect(after.eventKey).not.toBe(before.eventKey);
    expect([before.status, after.status]).toEqual(['in_transit', 'returning']);
  });

  it('refuses a batch over the limit', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `16-${i}-ZR`);
    expect(await adapter.fetchStatuses(many, GOOD, ctx())).toMatchObject({ ok: false, cause: 'batch_too_large' });
  });
});

describe('checkCredentials', () => {
  it('good key, with the tenant’s unlisted states', async () => {
    const result = await adapter.checkCredentials(GOOD, ctx());
    expect(result).toEqual({ kind: 'valid', unlistedStatuses: ['etat_maison'] });
  });

  it('caps the list at 50 and keeps out strange text', async () => {
    const states = [
      ...Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, name: `etat_${i}` })),
      { id: 'x', name: '<script>alert(1)</script>' },
    ];
    await standin.scenario(courier, { workflows: [{ id: 'w', name: 'x', isDefault: true, states }] });
    const result = await adapter.checkCredentials(GOOD, ctx());
    if (result.kind !== 'valid') throw new Error(result.kind);
    expect(result.unlistedStatuses).toHaveLength(50);
    expect(JSON.stringify(result)).not.toContain('script');
  });

  it('still valid when the workflow read fails after a good key', async () => {
    await standin.scenario(courier, { read: 'workflows-down' });
    expect(await adapter.checkCredentials(GOOD, ctx())).toEqual({ kind: 'valid' });
  });

  it('a wrong key is invalid', async () => {
    expect((await adapter.checkCredentials(BAD, ctx())).kind).toBe('invalid');
  });

  it.each([
    [{ read: '503' }, 'unavailable'],
    [{ read: '429' }, 'rate_limited'],
    [{ down: true }, 'unavailable'],
    [{ read: 'html' }, 'unavailable'],
  ])('%j gives %s', async (scenario, kind) => {
    await standin.scenario(courier, scenario);
    expect((await adapter.checkCredentials(GOOD, ctx())).kind).toBe(kind);
  });
});

describe('prepare', () => {
  let lists: CourierLists;
  beforeEach(async () => {
    lists = await loadLists();
  });
  const fails = (code: string, overrides: Partial<ParcelInput>, custom = lists) => {
    expect(adapter.prepare(input(overrides), custom)).toMatchObject({ ok: false, code });
  };
  const payload = (overrides: Partial<ParcelInput>) => {
    const result = adapter.prepare(input(overrides), lists);
    if (!result.ok) throw new Error(result.code);
    return result.parcel.payload as Record<string, unknown>;
  };

  it('refuses what it cannot ship, with the exact reason', () => {
    fails('address_required', { address: ' ' });
    fails('stop_desk_required', { deliveryType: 'stop_desk' });
    fails('stop_desk_mismatch', { deliveryType: 'stop_desk', stopDeskId: 'nope' });
    fails('wilaya_unmapped', { wilayaCode: 70 });
    fails('commune_unmapped', { commune: { nameFr: 'Nulle Part', nameAr: 'لا مكان' } });
    fails('amount_out_of_range', { codTotalDzd: 150001 });
    fails('phone_invalid', { phone: '0543123456' });
    fails('lists_missing', {}, { wilayas: [], communes: [], stopDesks: [] });
  });

  it('accepts the top amount', () => {
    expect(payload({ codTotalDzd: 150000 })['amount']).toBe(150000);
  });

  it('holds name length at both ends', () => {
    fails('recipient_required', { recipientName: 'A' });
    expect((payload({ recipientName: 'Al' })['customer'] as { name: string }).name).toBe('Al');
    const hundred = 'x'.repeat(100);
    expect((payload({ recipientName: hundred })['customer'] as { name: string }).name).toBe(hundred);
    expect((payload({ recipientName: 'y'.repeat(101) })['customer'] as { name: string }).name).toHaveLength(100);
  });

  it('holds description length at both ends', () => {
    expect(payload({ productLabel: 'x' })['description']).toBe('HB-ZR001');
    expect(payload({ productLabel: 'y'.repeat(250) })['description']).toHaveLength(250);
    expect(payload({ productLabel: 'z'.repeat(251) })['description']).toHaveLength(250);
  });

  it('reports a commune with no home delivery', async () => {
    const accented = lists.communes.find((c) => c.name === sample.name_fr.normalize('NFD').replace(/\p{M}/gu, ''));
    if (!accented) throw new Error('no match');
    await standin.scenario(courier, { noHomeCommunes: [accented.name] });
    fails('commune_not_deliverable', {}, await loadLists());
  });

  it('home and pickup need the matching service', async () => {
    const desk = lists.stopDesks.find((d) => d.communeId);
    if (!desk) throw new Error('no tagged desk');
    const tagged = lists.communes.find((c) => c.id === desk.communeId);
    if (!tagged) throw new Error('no commune');
    await standin.scenario(courier, { noPickupCommunes: [tagged.name] });
    fails('commune_not_deliverable', { deliveryType: 'stop_desk', stopDeskId: desk.id }, await loadLists());
  });

  it('refuses a desk from another wilaya', () => {
    const desk = lists.stopDesks[0];
    if (!desk) throw new Error('no desk');
    fails('stop_desk_mismatch', { deliveryType: 'stop_desk', stopDeskId: desk.id }, { ...lists, stopDesks: [{ ...desk, wilayaCode: desk.wilayaCode + 1 }] });
  });

  it('a desk with a commune tag ships, and one without falls back to the order commune', async () => {
    const tagged = lists.stopDesks.find((d) => d.communeId);
    const untagged = lists.stopDesks.find((d) => !d.communeId);
    if (!tagged || !untagged) throw new Error('needs both kinds of desk');
    const withTag = adapter.prepare(input({ deliveryType: 'stop_desk', stopDeskId: tagged.id }), lists);
    if (!withTag.ok) throw new Error(withTag.code);
    expect(withTag.parcel.payload).toMatchObject({ deliveryType: 'pickup-point', hubId: tagged.id, deliveryAddress: { districtTerritoryId: tagged.communeId } });
    expect((await adapter.createParcel(withTag.parcel, GOOD, ctx())).kind).toBe('accepted');

    // Only a commune that has a pickup point can stand in for an untagged desk.
    const pickup = lists.communes.find((c) => c.hasStopDesk);
    if (!pickup) throw new Error('no pickup commune');
    const noTag = adapter.prepare(input({ reference: 'HB-ZR002', deliveryType: 'stop_desk', stopDeskId: untagged.id, commune: { nameFr: pickup.name, nameAr: 'x' } }), lists);
    if (!noTag.ok) throw new Error(noTag.code);
    expect((noTag.parcel.payload['deliveryAddress'] as Record<string, unknown>)['districtTerritoryId']).toBe(pickup.id);
    expect((await adapter.createParcel(noTag.parcel, GOOD, ctx())).kind).toBe('accepted');
  });

  it('ships a new wilaya through its parent', async () => {
    const elKantara = communes.find((c) => c.wilaya_code === 61);
    if (!elKantara) throw new Error('no commune');
    const parent = await loadLists(61);
    const result = adapter.prepare(input({ wilayaCode: 61, commune: { nameFr: elKantara.name_fr, nameAr: elKantara.name_ar } }), parent);
    if (!result.ok) throw new Error(result.code);
    expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
  });
});

describe('lists', () => {
  it('a truncated list is a failure, never a short list', async () => {
    await standin.scenario(courier, { read: 'endless' });
    expect(await adapter.listWilayas(GOOD, ctx())).toEqual({ ok: false, cause: 'too_many_pages' });
  });

  it('carries territory ids', async () => {
    const wilayas = await adapter.listWilayas(GOOD, ctx());
    if (!wilayas.ok) throw new Error(wilayas.cause);
    expect(wilayas.items).toHaveLength(58);
    expect(wilayas.items[0]?.id).toMatch(/-/);
  });
});

describe('labels', () => {
  it('returns the stand-in label URL', async () => {
    const created = await adapter.createParcel(await prepared(), GOOD, ctx());
    if (created.kind !== 'accepted') throw new Error('no parcel');
    expect((await adapter.getLabel(created.tracking, GOOD, ctx())).kind).toBe('url');
  });

  const label = (fileUrl: string, trackingNumber = '16-A-ZR', failed: string[] = []): typeof fetch => async () =>
    new Response(JSON.stringify({ parcelLabelFiles: [{ trackingNumber, fileUrl }], failedTrackingNumbers: failed }));

  it('keeps only the pinned storage host', async () => {
    const good = 'https://zrexpressstorage.blob.core.windows.net/labels/x.html?sv=1';
    expect(await adapter.getLabel('16-A-ZR', GOOD, { env: 'production', fetch: label(good) })).toEqual({ kind: 'url', url: good });
    for (const bad of ['https://other.blob.core.windows.net/x', 'http://zrexpressstorage.blob.core.windows.net/x', 'javascript:alert(1)']) {
      expect((await adapter.getLabel('16-A-ZR', GOOD, { env: 'production', fetch: label(bad) })).kind).toBe('unavailable');
    }
  });

  it('refuses a row for another tracking, and a failed one', async () => {
    const good = 'https://zrexpressstorage.blob.core.windows.net/labels/x.html';
    expect(await adapter.getLabel('16-A-ZR', GOOD, { env: 'production', fetch: label(good, '16-B-ZR') })).toEqual({ kind: 'unavailable', cause: 'no_label' });
    expect(await adapter.getLabel('16-A-ZR', GOOD, { env: 'production', fetch: label(good, '16-A-ZR', ['16-A-ZR']) })).toEqual({ kind: 'unavailable', cause: 'label_failed' });
  });
});

describe('outbound guard and failure values', () => {
  it('refuses with no stand-in, on every network method', async () => {
    const spy = vi.fn<typeof fetch>();
    const local: CourierContext = { env: 'development', fetch: spy };
    const parcel = await prepared();
    expect(await adapter.createParcel(parcel, GOOD, local)).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
    expect(await adapter.validateParcel('16-A-ZR', { askCollection: false }, GOOD, local)).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
    expect((await adapter.findByReference('X', { attemptedAt: 1 }, GOOD, local)).kind).toBe('unavailable');
    expect((await adapter.fetchStatuses(['16-A-ZR'], GOOD, local)).ok).toBe(false);
    expect((await adapter.checkCredentials(GOOD, local)).kind).toBe('unavailable');
    expect((await adapter.getLabel('16-A-ZR', GOOD, local)).kind).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('goes to the real host in production, whatever credentials or stand-in say', async () => {
    const spy = vi.fn<typeof fetch>(async () => new Response('{"items":[],"totalCount":0}'));
    await adapter.findByReference('X', { attemptedAt: 1 }, { apiKey: 'https://evil.test', tenantId: 'x', host: 'evil.test' }, {
      env: 'production',
      standinUrl: standin.url,
      fetch: spy,
    });
    expect(String(spy.mock.calls[0]?.[0])).toBe('https://api.zrexpress.app/api/v1/parcels/search');
  });

  it.each([
    ['TypeError', new TypeError('fetch failed SECRET-K')],
    ['AbortError', new DOMException('aborted', 'AbortError')],
  ])('never throws when fetch rejects with %s', async (_name, error) => {
    const context = ctx({ fetch: (async () => { throw error; }) as typeof fetch });
    const secrets = { apiKey: 'SECRET-K', tenantId: 'SECRET-T' };
    const parcel = await prepared();
    const results = [
      await adapter.createParcel(parcel, secrets, context),
      await adapter.validateParcel('16-A-ZR', { askCollection: false }, secrets, context),
      await adapter.findByReference('X', { attemptedAt: 1 }, secrets, context),
      await adapter.fetchStatuses(['16-A-ZR'], secrets, context),
      await adapter.checkCredentials(secrets, context),
      await adapter.listWilayas(secrets, context),
      await adapter.listCommunes(16, secrets, context),
      await adapter.listStopDesks(16, secrets, context),
      await adapter.getLabel('16-A-ZR', secrets, context),
    ];
    expect(JSON.stringify(results)).not.toContain('SECRET');
  });

  it('returns no customer data', async () => {
    const created = await adapter.createParcel(await prepared(), GOOD, ctx());
    const found = await adapter.findByReference('HB-ZR001', { attemptedAt: Date.now() }, GOOD, ctx());
    const text = JSON.stringify([created, found]);
    expect(text).not.toContain('Benali');
    expect(text).not.toContain('560417403');
  });
});

describe('webhooks', () => {
  const SECRET_BYTES = Buffer.from('standin-zr-secret');
  const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
  const T = 1_800_000_000;
  const encode = (text: string) => new TextEncoder().encode(text);
  const sign = (body: Uint8Array, id = 'msg_1', timestamp = String(T)) =>
    createHmac('sha256', SECRET_BYTES).update(`${id}.${timestamp}.`).update(body).digest('base64');
  const headers = (body: Uint8Array, id = 'msg_1', timestamp = String(T)): Record<string, string> => ({
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${sign(body, id, timestamp)}`,
  });
  const body = (eventType: string, data: unknown, occurredAt = '2026-01-02T10:00:00Z') => encode(JSON.stringify({ eventType, occurredAt, data }));
  const stateEvent = (extra: Record<string, unknown> = {}) => ({
    trackingNumber: '16-A-ZR',
    state: { name: 'sortie_en_livraison' },
    lastStateUpdateAt: '2026-01-02T09:00:00Z',
    isReturn: false,
    ...extra,
  });
  const NOW = T * 1000;

  it('verifies a valid signature against the time it arrived', async () => {
    const rawBody = body('parcel.state.updated', stateEvent());
    expect(await adapter.verifyWebhook({ rawBody, headers: headers(rawBody), secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it('a webhook that waited in the inbox still verifies', async () => {
    const rawBody = body('parcel.state.updated', stateEvent());
    // Arrived one minute after signing; verified 40 minutes later, which the wall clock doesn't affect.
    expect(await adapter.verifyWebhook({ rawBody, headers: headers(rawBody), secret: SECRET, now: NOW + 60_000 })).toEqual({ ok: true });
  });

  it('needs the arrival time', async () => {
    const rawBody = body('parcel.state.updated', stateEvent());
    expect(await adapter.verifyWebhook({ rawBody, headers: headers(rawBody), secret: SECRET })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts any valid signature in the list', async () => {
    const rawBody = body('parcel.state.updated', stateEvent());
    const h = headers(rawBody);
    h['svix-signature'] = `v1,AAAA v1,${sign(rawBody)}`;
    expect(await adapter.verifyWebhook({ rawBody, headers: h, secret: SECRET, now: NOW })).toEqual({ ok: true });
  });

  it.each([
    ['stale timestamp', (h: Record<string, string>) => h, NOW + 301_000],
    ['future timestamp', (h: Record<string, string>) => h, NOW - 301_000],
    ['wrong signature', (h: Record<string, string>) => ({ ...h, 'svix-signature': 'v1,AAAA' }), NOW],
    ['tampered id', (h: Record<string, string>) => ({ ...h, 'svix-id': 'msg_other' }), NOW],
    ['non-numeric timestamp', (h: Record<string, string>) => ({ ...h, 'svix-timestamp': 'soon' }), NOW],
  ])('%s is a bad signature', async (_name, change, now) => {
    const rawBody = body('parcel.state.updated', stateEvent());
    expect(await adapter.verifyWebhook({ rawBody, headers: change(headers(rawBody)), secret: SECRET, now })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('missing %s', async (name) => {
    const rawBody = body('parcel.state.updated', stateEvent());
    const h = headers(rawBody);
    delete h[name];
    expect(await adapter.verifyWebhook({ rawBody, headers: h, secret: SECRET, now: NOW })).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it.each(['', 'not-prefixed', 'whsec_', 'whsec_%%%'])('a bad secret (%j) fails closed', async (secret) => {
    const rawBody = body('parcel.state.updated', stateEvent());
    expect(await adapter.verifyWebhook({ rawBody, headers: headers(rawBody), secret, now: NOW })).toEqual({ ok: false, reason: 'missing_secret' });
  });

  it('verifies over bytes, including a body that is not valid UTF-8', async () => {
    const rawBody = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x7b, 0x7d]);
    expect(await adapter.verifyWebhook({ rawBody, headers: headers(rawBody), secret: SECRET, now: NOW })).toEqual({ ok: true });
    expect(adapter.parseWebhook(rawBody)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('parses a state update', () => {
    const parsed = adapter.parseWebhook(body('parcel.state.updated', stateEvent({ situation: { name: 'Reporté' } })));
    expect(parsed).toMatchObject({ ok: true, badRows: 0 });
    if (parsed.ok) expect(parsed.events[0]).toMatchObject({ status: 'in_transit', reason: 'Reporté', occurredAt: Date.UTC(2026, 0, 2, 9) });
  });

  it('ignores other event types', () => {
    expect(adapter.parseWebhook(body('other.thing', stateEvent()))).toEqual({ ok: true, events: [], badRows: 0 });
  });

  it.each([
    ['no data', undefined],
    ['no tracking', { state: { name: 'dispatch' }, lastStateUpdateAt: '2026-01-02T09:00:00Z' }],
    ['no state', { trackingNumber: '16-A-ZR', lastStateUpdateAt: '2026-01-02T09:00:00Z' }],
  ])('a row with %s counts as bad', (_name, data) => {
    expect(adapter.parseWebhook(body('parcel.state.updated', data))).toEqual({ ok: true, events: [], badRows: 1 });
  });

  it('a situation added to an unchanged state keeps the key', () => {
    const stateKey = adapter.parseWebhook(body('parcel.state.updated', stateEvent(), '2026-01-02T09:00:01Z'));
    const situationKey = adapter.parseWebhook(body('parcel.state.situation.created', stateEvent({ situation: { name: 'Reporté' } }), '2026-01-02T11:30:00Z'));
    expect(stateKey.ok && situationKey.ok && stateKey.events[0]?.eventKey === situationKey.events[0]?.eventKey).toBe(true);
  });

  it('an isReturn flip gets a new key', () => {
    const before = adapter.parseWebhook(body('parcel.state.updated', stateEvent()));
    const after = adapter.parseWebhook(body('parcel.isReturn.updated', stateEvent({ isReturn: true })));
    expect(before.ok && after.ok && before.events[0]?.eventKey !== after.events[0]?.eventKey).toBe(true);
    expect(after.ok && after.events[0]?.status).toBe('returning');
  });

  it('falls back to occurredAt only for a state update', () => {
    const noStateTime = stateEvent({ lastStateUpdateAt: undefined });
    const update = adapter.parseWebhook(body('parcel.state.updated', noStateTime, '2026-01-02T12:00:00Z'));
    expect(update.ok && update.events[0]?.occurredAt).toBe(Date.UTC(2026, 0, 2, 12));
    expect(adapter.parseWebhook(body('parcel.state.situation.created', noStateTime))).toEqual({ ok: true, events: [], badRows: 1 });
    expect(adapter.parseWebhook(body('parcel.isReturn.updated', noStateTime))).toEqual({ ok: true, events: [], badRows: 1 });
  });

  it('the same state by webhook and by poll is one key', async () => {
    const [a] = await seed([{ state: 'dispatch', lastStateUpdateAt: '2026-01-02T09:00:00Z' }]);
    const polled = await adapter.fetchStatuses([a as string], GOOD, ctx());
    const hooked = adapter.parseWebhook(body('parcel.state.updated', { trackingNumber: a, state: { name: 'dispatch' }, isReturn: false, lastStateUpdateAt: '2026-01-02T09:00:00Z' }));
    expect(polled.ok && hooked.ok && polled.events[0]?.eventKey === hooked.events[0]?.eventKey).toBe(true);
  });

  it('has no handshake', () => {
    expect(adapter.webhookHandshake({ crc_token: 'x' })).toBeNull();
  });

  it('verifies what the stand-in actually sends', async () => {
    const received: Array<{ body: Buffer; headers: Record<string, string> }> = [];
    const hook = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ body: Buffer.concat(chunks), headers: req.headers as Record<string, string> });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    try {
      const port = (hook.address() as AddressInfo).port;
      await standin.scenario(courier, { webhookUrl: `http://127.0.0.1:${port}/hook` });
      const [a] = await seed([{ state: 'commande_recue' }]);
      await standin.control(`${courier}/parcels/${a as string}/status`, { state: 'livre', times: 2 });
      expect(received).toHaveLength(2);
      const keys = [];
      for (const message of received) {
        const rawBody = new Uint8Array(message.body);
        expect(await adapter.verifyWebhook({ rawBody, headers: message.headers, secret: SECRET, now: Date.now() })).toEqual({ ok: true });
        const parsed = adapter.parseWebhook(rawBody);
        if (!parsed.ok) throw new Error('not parsed');
        expect(parsed.events[0]?.status).toBe('delivered');
        keys.push(parsed.events[0]?.eventKey);
      }
      expect(keys[0]).toBe(keys[1]);
    } finally {
      await new Promise((resolve) => hook.close(resolve));
    }
  });
});

describe('the stand-in holds couriers to the real rules', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'X-Api-Key': GOOD.apiKey, 'X-Tenant': GOOD.tenantId }) =>
    fetch(`${standin.url}/zr-express/api/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('requires both credential headers', async () => {
    expect((await post('parcels/bulk', { parcels: [] }, { 'X-Api-Key': GOOD.apiKey })).status).toBe(401);
    expect((await post('parcels/bulk', { parcels: [] }, { 'X-Tenant': GOOD.tenantId })).status).toBe(401);
  });

  it('refuses a phone not in +213 form, as a 400', async () => {
    const parcel = await prepared();
    const payload = { ...parcel.payload, customer: { customerId: 'x', name: 'Ab', phone: { number1: '0560417403' } } };
    const response = await post('parcels/bulk', { parcels: [payload] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { failures: Array<{ errorCode: string }> }).failures[0]?.errorCode).toBe('General.Validation');
  });

  it('refuses a missing stockType', async () => {
    const parcel = await prepared();
    const payload = { ...parcel.payload, orderedProducts: [{ productName: 'x', unitPrice: 1, quantity: 1 }] };
    expect((await post('parcels/bulk', { parcels: [payload] })).status).toBe(400);
  });
});

describe('fixtures replayed through the adapter', () => {
  type Native = Array<{ status: number; body: unknown }>;
  const fixture = (path: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/dz-delivery/zrexpress/${path}`, import.meta.url), 'utf8')) as Native;
  const answer = (entry: { status: number; body: unknown } | undefined): typeof fetch =>
    (async () => new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 })) as typeof fetch;
  const ctxOf = (fetcher: typeof fetch): CourierContext => ({ env: 'production', fetch: fetcher });

  it('a 400 of failures with a code outside the allow-list stays uncertain', async () => {
    const parcel: PreparedParcel = { courier: 'zr-express', reference: 'ORD-FAIL', payload: { externalId: 'ORD-FAIL' } };
    expect(await adapter.createParcel(parcel, GOOD, ctxOf(answer(fixture('createParcelsBulk/all-failed.native.json')[0])))).toEqual({
      kind: 'uncertain',
      cause: 'malformed_response',
    });
  });

  it('search by external id finds the parcel', async () => {
    expect(await adapter.findByReference('ORD-1001', { attemptedAt: 1 }, GOOD, ctxOf(answer(fixture('listParcels/by-orderId.native.json')[0])))).toMatchObject({
      kind: 'found',
      tracking: '16-AAA111-ZR',
      status: 'pending',
    });
  });

  it('a list row and the status history shape', async () => {
    const entry = fixture('track/basic.native.json')[0];
    const body = entry?.body as Record<string, unknown>;
    const search: typeof fetch = async () => new Response(JSON.stringify({ items: [body], totalCount: 1, hasNext: false }));
    const result = await adapter.fetchStatuses(['DZ-AL-20251121-00145'], GOOD, ctxOf(search));
    if (!result.ok) throw new Error(result.cause);
    expect(result.events[0]).toMatchObject({ status: 'in_transit', occurredAt: Date.parse('2025-12-30T13:24:34.469Z') });
  });

  it('the label fixture is kept', async () => {
    const result = await adapter.getLabel('16-AAA111-ZR', GOOD, ctxOf(answer(fixture('generateLabels/individual.native.json')[0])));
    expect(result).toEqual({ kind: 'url', url: 'https://zrexpressstorage.blob.core.windows.net/labels/bordereau_16-AAA111-ZR.html?sv=demo' });
  });

  it('paginated wilayas parse with ids', async () => {
    const responses = fixture('getWilayas/paginated.native.json');
    let i = 0;
    const replay: typeof fetch = (async () => {
      const entry = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 });
    }) as typeof fetch;
    const result = await adapter.listWilayas(GOOD, ctxOf(replay));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.find((w) => w.code === 16)).toMatchObject({ name: 'Alger', deliverable: true });
  });

  it('communes keep their ids and split home from pickup', async () => {
    const responses = fixture('getCommunes/basic.native.json');
    let i = 0;
    const wilaya = { items: [{ id: '11111111-1111-4111-8111-000000000016', code: 16, name: 'Alger', level: 'wilaya' }], hasNext: false };
    const replay: typeof fetch = (async () => {
      const entry = i === 0 ? { status: 200, body: wilaya } : responses[0];
      i += 1;
      return new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 });
    }) as typeof fetch;
    const result = await adapter.listCommunes(16, GOOD, ctxOf(replay));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items[0]).toMatchObject({ name: "Sidi M'Hamed", hasStopDesk: true, deliverable: true });
    expect(result.items[0]?.id).toMatch(/^22222222/);
  });

  it('hubs without a commune tag still list', async () => {
    const responses = fixture('getStopDesks/by-wilaya.native.json');
    let i = 0;
    const replay: typeof fetch = (async () => {
      const entry = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 });
    }) as typeof fetch;
    const result = await adapter.listStopDesks(16, GOOD, ctxOf(replay));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({ name: 'Bureau Bab Ezzouar' });
  });
});
