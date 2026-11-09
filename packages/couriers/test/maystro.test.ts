import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { maystro as adapter } from '../src/maystro/adapter.ts';
import { getCourier } from '../src/registry.ts';
import { isResendSafe } from '../src/resend.ts';
import type { CourierContext, CourierLists, ParcelInput, PreparedParcel } from '../src/types.ts';
import { startStandin, type Standin } from './helpers/standin.ts';

const GOOD = { storeToken: 'standin-token' };
const courier = 'maystro';

let standin: Standin;
beforeAll(async () => {
  standin = await startStandin();
});
afterAll(async () => {
  await standin.stop();
});
beforeEach(async () => {
  await standin.reset();
});

const communes = JSON.parse(readFileSync(new URL('../../../data/geo/communes.json', import.meta.url), 'utf8')) as Array<{
  wilaya_code: number;
  name_fr: string;
  name_ar: string;
}>;
const UNSERVED = new Set([11, 33, 37, 50, 52, 53, 54, 56]);
const sample = communes.find((c) => c.wilaya_code <= 58 && !UNSERVED.has(c.wilaya_code) && /[éèïîâ]/.test(c.name_fr));
if (!sample) throw new Error('needs an accented commune');
const WILAYA = sample.wilaya_code;

const ctx = (extra: Partial<CourierContext> = {}): CourierContext => ({ env: 'test', standinUrl: standin.url, timeoutMs: 400, ...extra });
const input = (overrides: Partial<ParcelInput> = {}): ParcelInput => ({
  reference: 'HB-MY001',
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
    readCount: number;
    parcels: Array<Record<string, unknown>>;
    lastCreateBody: Array<Record<string, unknown>>;
    lastLabelBody: Record<string, unknown>;
    lastAccept: string;
    lastUrl: string;
  };

describe('registry', () => {
  it('is registered and says what is unconfirmed', () => {
    expect(getCourier('maystro')).toBe(adapter);
    expect(adapter.confidence).toMatchObject({ baseUrl: 'probed', statusList: 'official' });
    expect(adapter.confidence.notes).toEqual(expect.arrayContaining(['no_lookup_by_reference', 'webhooks_not_used', 'stop_desk_is_commune_level']));
    expect(adapter.capabilities).toMatchObject({ verifyByReference: false, needsValidation: false, webhook: 'none', pollBatchSize: 5 });
  });
});

describe('createParcel', () => {
  it('is live on creation, with the total as the amount and the list’s spelling', async () => {
    const parcel = await prepared();
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toMatchObject({ kind: 'accepted', draft: false });
    const state = await fullState();
    expect(state.createCount).toBe(1);
    expect(state.lastCreateBody).toHaveLength(1);
    expect(state.lastCreateBody[0]).toMatchObject({ total_price: 5600, delivery_type: 1, external_id: 'HB-MY001', customer_phone: '0560417403' });
    expect(typeof state.lastCreateBody[0]?.['commune']).toBe('number');
  });

  it.each([10, 20, 30, 40, 45, 50, 51, 70, 80, 90, 100, 101])('code %i is rejected, bare or as an object', async (code) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create: `code:${code}` });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'rejected', code: 'courier_refused', detail: `Maystro error ${code}` });
    await standin.scenario(courier, { create: `code-object:${code}` });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'rejected', code: 'courier_refused', detail: `Erreur ${code}` });
  });

  it.each(['code:55', 'code-object:55'])('%s is a possible duplicate', async (create) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'possible_duplicate' });
  });

  it('a real resend with the same customer is the duplicate, with no second parcel', async () => {
    const parcel = await prepared();
    await adapter.createParcel(parcel, GOOD, ctx());
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'possible_duplicate' });
    expect((await fullState()).parcels).toHaveLength(1);
  });

  it.each(['code:60', 'code:999', 'non-integer', 'no-errors', 'two-rows', 'other-external', 'tracking-number', 'tracking-null', 'bad-json', 'html', 'redirect', '408', '409', '500-no-create'])(
    'an odd answer (%s) is uncertain',
    async (create) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create });
      expect((await adapter.createParcel(parcel, GOOD, ctx())).kind).toBe('uncertain');
      expect((await fullState()).createCount).toBe(1);
    },
  );

  it('a wrong token is refused with no forced scenario', async () => {
    expect(await adapter.createParcel(await prepared(), { storeToken: 'x' }, ctx())).toMatchObject({ kind: 'rejected', code: 'auth' });
  });

  it.each(['create-then-hang', 'headers-then-stall', 'hang-no-create', 'create-late', '500-after-create'])('%s is uncertain, once', async (create) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create, lateMs: 50 });
    expect((await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 150 }))).kind).toBe('uncertain');
    expect((await fullState()).createCount).toBe(1);
  });

  it('never leaks a token the courier echoes', async () => {
    const parcel = await prepared();
    await standin.scenario(courier, { create: 'echo-token' });
    const result = await adapter.createParcel(parcel, GOOD, ctx());
    expect(result.kind).toBe('rejected');
    expect(JSON.stringify(result)).not.toContain('standin-token');
  });
});

describe('no lookup by reference', () => {
  it('is always unsupported, with no request, and never safe', async () => {
    const spy = vi.fn<typeof fetch>();
    const result = await adapter.findByReference('X', { attemptedAt: 1 }, GOOD, ctx({ fetch: spy }));
    expect(result).toEqual({ kind: 'unavailable', cause: 'unsupported' });
    expect(spy).not.toHaveBeenCalled();
    expect(isResendSafe(result, 0, adapter.capabilities, null)).toBe(false);
  });
});

describe('validateParcel', () => {
  it('is a no-op', async () => {
    const spy = vi.fn<typeof fetch>();
    expect(await adapter.validateParcel('x', { askCollection: false }, GOOD, ctx({ fetch: spy }))).toEqual({ kind: 'validated' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchStatuses', () => {
  const oneRow = (status: unknown, updated = '2026-01-02T10:00:00+01:00') => async () =>
    new Response(JSON.stringify({ list: { count: 1, results: [{ display_id: '1723', status, updated_at: updated }] } }));

  it.each([
    [41, 'delivered'],
    [52, 'returned'],
    [53, 'exception'],
    [50, 'exception'],
    [42, 'exception'],
    [31, 'in_transit'],
    [10, 'returning'],
    [999, 'unknown'],
  ])('code %i is %s', async (code, status) => {
    const [t] = await seed([{ status: code }]);
    const result = await adapter.fetchStatuses([t as string], GOOD, ctx());
    expect(result.ok && result.events[0]?.status).toBe(status);
  });

  it('maps a code given as a number or a string, and nothing else', async () => {
    for (const [value, expected] of [
      [41, 'delivered'],
      ['41', 'delivered'],
      [41.5, 'unknown'],
      [true, 'unknown'],
      [[41], 'unknown'],
    ] as const) {
      const result = await adapter.fetchStatuses(['1723'], GOOD, ctx({ fetch: oneRow(value) as typeof fetch }));
      expect(result.ok && result.events[0]?.status).toBe(expected);
    }
  });

  it('an edit to the order keeps the key', async () => {
    const first = await adapter.fetchStatuses(['1723'], GOOD, ctx({ fetch: oneRow(31, '2026-01-02T10:00:00+01:00') as typeof fetch }));
    const second = await adapter.fetchStatuses(['1723'], GOOD, ctx({ fetch: oneRow(31, '2026-01-03T10:00:00+01:00') as typeof fetch }));
    if (!first.ok || !second.ok) throw new Error('failed');
    expect(first.events[0]?.eventKey).toBe('1723|31|none');
    expect(second.events[0]?.eventKey).toBe(first.events[0]?.eventKey);
    expect(second.events[0]?.occurredAt).toBe(Date.UTC(2026, 0, 3, 9));
  });

  it('count 0 is absent', async () => {
    expect(await adapter.fetchStatuses(['999'], GOOD, ctx())).toMatchObject({ ok: true, absent: ['999'] });
  });

  it('two rows or a wrong id count as bad', async () => {
    const [t] = await seed([{ status: 41 }]);
    await standin.scenario(courier, { read: 'two-rows' });
    expect(await adapter.fetchStatuses([t as string], GOOD, ctx())).toMatchObject({ ok: true, badRows: 1 });
    const other: typeof fetch = async () => new Response(JSON.stringify({ list: { count: 1, results: [{ display_id: 'other', status: 41 }] } }));
    expect(await adapter.fetchStatuses(['1723'], GOOD, ctx({ fetch: other }))).toMatchObject({ ok: true, badRows: 1, events: [] });
  });

  it('a deadline hit part-way is a failure, never a partial answer', async () => {
    const trackings = await seed([{ status: 41 }, { status: 41 }, { status: 41 }]);
    await standin.scenario(courier, { slowMs: 80 });
    expect((await adapter.fetchStatuses(trackings, GOOD, ctx({ deadlineMs: 120 }))).ok).toBe(false);
  });

  it('reports the reason when there is one', async () => {
    const [t] = await seed([{ status: 32, alert_reason: 'Client absent' }]);
    const result = await adapter.fetchStatuses([t as string], GOOD, ctx());
    expect(result.ok && result.events[0]?.reason).toBe('Client absent');
  });

  it('fails with a delay on 429, and carries on a retry once on 503', async () => {
    await standin.scenario(courier, { read: '429' });
    expect(await adapter.fetchStatuses(['1'], GOOD, ctx())).toMatchObject({ ok: false, retryAfterMs: 9000 });
    await standin.reset();
    await standin.scenario(courier, { read: '503-once' });
    expect((await adapter.fetchStatuses(['1'], GOOD, ctx())).ok).toBe(true);
    expect((await fullState()).readCount).toBe(2);
  });

  it('refuses a batch over the limit, and refuses bad trackings', async () => {
    expect((await adapter.fetchStatuses(Array.from({ length: 6 }, (_, i) => `M${i}`), GOOD, ctx())).ok).toBe(false);
    const spy = vi.fn<typeof fetch>();
    expect(await adapter.fetchStatuses(['../x'], GOOD, ctx({ fetch: spy }))).toEqual({ ok: true, events: [], absent: [], invalid: ['../x'], badRows: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('checkCredentials', () => {
  it('uses a call that needs the token', async () => {
    expect(await adapter.checkCredentials(GOOD, ctx())).toEqual({ kind: 'valid' });
    expect((await fullState()).lastUrl).toContain('/backend/api/stores/orders/');
    expect((await adapter.checkCredentials({ storeToken: 'x' }, ctx())).kind).toBe('invalid');
  });

  it.each([
    [{ read: '503' }, 'unavailable'],
    [{ read: '429' }, 'rate_limited'],
    [{ read: 'html' }, 'unavailable'],
    [{ down: true }, 'unavailable'],
  ])('%j gives %s', async (scenario, kind) => {
    await standin.scenario(courier, scenario);
    expect((await adapter.checkCredentials(GOOD, ctx())).kind).toBe(kind);
  });
});

describe('prepare and lists', () => {
  let lists: CourierLists;
  beforeEach(async () => {
    lists = await loadLists();
  });
  const fails = (code: string, overrides: Partial<ParcelInput>, custom = lists) => {
    expect(adapter.prepare(input(overrides), custom)).toMatchObject({ ok: false, code });
  };

  it('refuses what it can’t ship', () => {
    fails('address_required', { address: ' ' });
    fails('stop_desk_required', { deliveryType: 'stop_desk' });
    fails('stop_desk_mismatch', { deliveryType: 'stop_desk', stopDeskId: 'nope' });
    fails('wilaya_unmapped', { wilayaCode: 70 });
    fails('commune_unmapped', { commune: { nameFr: 'Nulle Part', nameAr: 'لا مكان' } });
    fails('phone_invalid', { phone: '0543123456' });
    fails('amount_out_of_range', { codTotalDzd: 1.5 });
    fails('recipient_required', { recipientName: ' ' });
    fails('lists_missing', {}, { wilayas: [], communes: [], stopDesks: [] });
  });

  it('a wilaya missing from the list isn’t served', () => {
    fails('wilaya_not_deliverable', {}, { ...lists, wilayas: lists.wilayas.filter((w) => w.code !== WILAYA) });
  });

  it('only the served wilayas are listed', () => {
    expect(lists.wilayas).toHaveLength(50);
    expect(lists.wilayas.some((w) => w.code === 11)).toBe(false);
  });

  it('asks for the Algerian list in French, and the stand-in refuses a bare request', async () => {
    await adapter.listWilayas(GOOD, ctx());
    expect((await fullState()).lastUrl).toContain('language=fr&country=1');
    const bare = await fetch(`${standin.url}/maystro/orders-management/api/base/wilayas/`, { headers: { Authorization: 'Token standin-token' } });
    expect(bare.status).toBe(400);
  });

  it('a row from another country never reaches an order', async () => {
    const rows = [
      { code: 16, name_lt: 'Tunis-gov', country: 2 },
      { code: 16, name_lt: 'Alger', country: 1 },
      { code: 31, name_lt: 'Oran' },
    ];
    const found = await adapter.listWilayas(GOOD, ctx({ fetch: async () => new Response(JSON.stringify(rows)) }));
    if (!found.ok) throw new Error(found.cause);
    expect(found.items.map((w) => w.name)).toEqual(['Alger', 'Oran']);
    const communesOf16: CourierLists['communes'] = [{ id: '554', name: 'Hydra', wilayaCode: 16, hasStopDesk: true, deliverable: true }];
    const result = adapter.prepare(input({ wilayaCode: 16, commune: { nameFr: 'Hydra', nameAr: 'x' } }), { wilayas: found.items, communes: communesOf16, stopDesks: [] });
    expect(result.ok && result.parcel.payload['wilaya']).toBe('Alger');
  });

  it('reads tuple-shaped wilayas too', async () => {
    await standin.scenario(courier, { wilayaShape: 'tuples' });
    const result = await adapter.listWilayas(GOOD, ctx());
    expect(result.ok && result.items.find((w) => w.code === 16)).toMatchObject({ name: 'Alger' });
  });

  it('ships a new wilaya through its parent', async () => {
    const elKantara = communes.find((c) => c.wilaya_code === 61);
    if (!elKantara) throw new Error('no commune');
    const result = adapter.prepare(input({ wilayaCode: 61, commune: { nameFr: elKantara.name_fr, nameAr: elKantara.name_ar } }), await loadLists(61));
    if (!result.ok) throw new Error(result.code);
    expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
  });

  it('a stop desk is its commune, sent as delivery type 2', async () => {
    const desk = lists.stopDesks[0];
    if (!desk) throw new Error('no desk');
    const result = adapter.prepare(input({ deliveryType: 'stop_desk', stopDeskId: desk.id, address: undefined as never }), lists);
    if (!result.ok) throw new Error(result.code);
    expect(result.parcel.payload).toMatchObject({ delivery_type: 2, commune: Number(desk.id), destination_text: desk.address });
    expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
  });

  it('error 45 at create is a refusal', async () => {
    const desk = lists.stopDesks[0];
    if (!desk) throw new Error('no desk');
    const result = adapter.prepare(input({ deliveryType: 'stop_desk', stopDeskId: desk.id }), lists);
    if (!result.ok) throw new Error(result.code);
    await standin.scenario(courier, { create: 'code:45' });
    expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('rejected');
  });

  it('drops a commune row naming another wilaya', async () => {
    const answer: typeof fetch = async () => new Response(JSON.stringify([{ id: 1, wilaya: 16, name: 'Hydra' }, { id: 2, wilaya: 5, name: 'Batna' }]));
    const list = await adapter.listCommunes(16, GOOD, ctx({ fetch: answer }));
    expect(list.ok && list.items.map((c) => c.name)).toEqual(['Hydra']);
    const desks = await adapter.listStopDesks(16, GOOD, ctx({ fetch: answer }));
    expect(desks.ok && desks.items.map((d) => d.id)).toEqual(['1']);
  });
});

describe('labels', () => {
  it('asks with Accept */* and returns PDF bytes', async () => {
    const created = await adapter.createParcel(await prepared(), GOOD, ctx());
    if (created.kind !== 'accepted') throw new Error('no parcel');
    expect((await adapter.getLabel(created.tracking, GOOD, ctx())).kind).toBe('pdf');
    const state = await fullState();
    expect(state.lastAccept).toBe('*/*');
    expect(state.lastLabelBody).toEqual({ orders_ids: [created.tracking] });
  });

  it('a 200 that isn’t a PDF is an error, and the real 406 is honoured by the stand-in', async () => {
    await standin.scenario(courier, { label: 'not-pdf' });
    expect(await adapter.getLabel('1723', GOOD, ctx())).toEqual({ kind: 'unavailable', cause: 'not_pdf' });
    await standin.reset();
    const refused = await fetch(`${standin.url}/maystro/backend/api/delivery/starter/starter_bordureau/`, {
      method: 'POST',
      headers: { Authorization: 'Token standin-token', Accept: 'application/pdf' },
      body: JSON.stringify({ orders_ids: ['1'] }),
    });
    expect(refused.status).toBe(406);
  });
});

describe('hosts, guard and failure values', () => {
  it('sends each call to its fixed host in production', async () => {
    const calls: string[] = [];
    const record: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify([]));
    };
    const production: CourierContext = { env: 'production', standinUrl: standin.url, fetch: record };
    await adapter.listWilayas(GOOD, production);
    await adapter.listCommunes(16, GOOD, production);
    await adapter.createParcel({ courier, reference: 'R', payload: {} }, GOOD, production);
    await adapter.fetchStatuses(['1723'], GOOD, production);
    await adapter.getLabel('1723', GOOD, production);
    const origins = calls.map((u) => new URL(u).origin);
    expect(origins).toEqual([
      'https://orders-management.maystro-delivery.com',
      'https://orders-management.maystro-delivery.com',
      'https://orders-management.maystro-delivery.com',
      'https://backend.maystro-delivery.com',
      'https://backend.maystro-delivery.com',
    ]);
  });

  it('no credential value can change the host', async () => {
    const spy = vi.fn<typeof fetch>(async () => new Response('[]'));
    await adapter.listWilayas({ storeToken: 'https://evil.test', host: 'evil.test' }, { env: 'production', fetch: spy });
    expect(new URL(String(spy.mock.calls[0]?.[0])).hostname).toBe('orders-management.maystro-delivery.com');
  });

  it('refuses with no stand-in', async () => {
    const spy = vi.fn<typeof fetch>();
    const local: CourierContext = { env: 'development', fetch: spy };
    const parcel = await prepared();
    expect(await adapter.createParcel(parcel, GOOD, local)).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
    expect((await adapter.fetchStatuses(['1'], GOOD, local)).ok).toBe(false);
    expect((await adapter.checkCredentials(GOOD, local)).kind).toBe('unavailable');
    expect((await adapter.getLabel('1', GOOD, local)).kind).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['TypeError', new TypeError('failed SECRET-T')],
    ['AbortError', new DOMException('aborted', 'AbortError')],
  ])('never throws on %s, never leaks', async (_name, error) => {
    const context = ctx({ fetch: (async () => { throw error; }) as typeof fetch });
    const secrets = { storeToken: 'SECRET-T' };
    const parcel = await prepared();
    const results = [
      await adapter.createParcel(parcel, secrets, context),
      await adapter.fetchStatuses(['1'], secrets, context),
      await adapter.checkCredentials(secrets, context),
      await adapter.listWilayas(secrets, context),
      await adapter.listCommunes(16, secrets, context),
      await adapter.listStopDesks(16, secrets, context),
      await adapter.getLabel('1', secrets, context),
    ];
    expect(JSON.stringify(results)).not.toContain('SECRET');
  });

  it('never returns customer data', async () => {
    const created = await adapter.createParcel(await prepared(), GOOD, ctx());
    if (created.kind !== 'accepted') throw new Error('no parcel');
    const text = JSON.stringify([created, await adapter.fetchStatuses([created.tracking], GOOD, ctx())]);
    expect(text).not.toContain('Benali');
    expect(text).not.toContain('560417403');
  });

  it('has no webhook', async () => {
    expect(adapter.capabilities.webhook).toBe('none');
    expect(adapter.webhookHandshake({})).toBeNull();
    expect((await adapter.verifyWebhook({ rawBody: new Uint8Array(), headers: {}, secret: 's', now: 1 })).ok).toBe(false);
    expect(adapter.parseWebhook(new Uint8Array()).ok).toBe(false);
  });
});

describe('stand-in rules', () => {
  const post = (body: unknown, headers: Record<string, string> = { Authorization: 'Token standin-token' }, path = '/maystro/orders-management/api/orders/') =>
    fetch(`${standin.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('requires the token, an array, and the trailing slash', async () => {
    expect((await post([], {})).status).toBe(401);
    expect((await post({})).status).toBe(400);
    expect((await post([], undefined, '/maystro/orders-management/api/orders')).status).toBe(404);
  });

  it('refuses a commune that isn’t a number, and an unserved wilaya', async () => {
    const parcel = await prepared();
    for (const change of [{ commune: 'Alger' }, { wilaya: 'Tamanrasset' }]) {
      const response = await post([{ ...parcel.payload, ...change }]);
      const rows = (await response.json()) as Array<{ errors: number[] }>;
      expect(rows[0]?.errors).toEqual([40]);
    }
  });
});

describe('fixtures replayed through the adapter', () => {
  type Native = Array<{ status: number; body: unknown }>;
  const fixture = (path: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/dz-delivery/maystro/${path}`, import.meta.url), 'utf8')) as Native;
  const answer = (entry: { status: number; body: unknown } | undefined): typeof fetch =>
    (async () => new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 })) as typeof fetch;
  const ctxOf = (fetcher: typeof fetch): CourierContext => ({ env: 'production', fetch: fetcher });
  const last = (file: string) => {
    const responses = fixture(file);
    return responses[responses.length - 1];
  };
  const parcel: PreparedParcel = { courier, reference: 'ORDER-3001', payload: {} };

  it('home and stop-desk creates are accepted', async () => {
    expect(await adapter.createParcel(parcel, GOOD, ctxOf(answer(last('createParcel/stop-desk.native.json'))))).toEqual({ kind: 'accepted', tracking: '172316976800002', draft: false });
    expect((await adapter.createParcel(parcel, GOOD, ctxOf(answer(last('createParcel/home-delivery.native.json'))))).kind).not.toBe('rejected');
  });

  it('the sampled refusal, with bare codes, is rejected', async () => {
    const row = { courier, reference: 'ORDER-3004', payload: {} };
    expect((await adapter.createParcel(row, GOOD, ctxOf(answer(last('createParcel/rejected.native.json'))))).kind).toBe('rejected');
  });

  it('the sampled duplicate, with an object, is a possible duplicate', async () => {
    expect(await adapter.createParcel(parcel, GOOD, ctxOf(answer(last('createParcel/duplicate.native.json'))))).toEqual({ kind: 'uncertain', cause: 'possible_duplicate' });
  });

  it('tracking by display id', async () => {
    const result = await adapter.fetchStatuses(['172316976800001'], GOOD, ctxOf(answer(fixture('track/by-display-id.native.json')[0])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.events[0]).toMatchObject({ status: 'in_transit', eventKey: '172316976800001|31|none' });
  });

  it('an unknown reference is absent', async () => {
    expect(await adapter.fetchStatuses(['1'], GOOD, ctxOf(answer(fixture('track/unknown-reference.native.json')[0])))).toMatchObject({ ok: true, absent: ['1'] });
  });

  it('wilayas in both shapes', async () => {
    const objects = await adapter.listWilayas(GOOD, ctxOf(answer(fixture('getWilayas/basic.native.json')[0])));
    expect(objects.ok && objects.items.find((w) => w.code === 16)?.name).toBe('Alger');
    const tuples = await adapter.listWilayas(GOOD, ctxOf(answer(fixture('getWilayas/legacy-tuple.native.json')[0])));
    expect(tuples.ok && tuples.items.length).toBeGreaterThan(0);
  });

  it('communes keep their numeric id as a string', async () => {
    const result = await adapter.listCommunes(16, GOOD, ctxOf(answer(fixture('getCommunes/basic.native.json')[1])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items[0]).toMatchObject({ id: '554', name: 'Alger Centre' });
  });

  it('an auth failure on the list is a failure', async () => {
    expect((await adapter.listWilayas(GOOD, ctxOf(answer(fixture('getWilayas/auth-failed.native.json')[0])))).ok).toBe(false);
  });
});
