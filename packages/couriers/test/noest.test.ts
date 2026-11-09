import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { noest as adapter } from '../src/noest/adapter.ts';
import { getCourier } from '../src/registry.ts';
import { isResendSafe } from '../src/resend.ts';
import type { CourierContext, CourierLists, ParcelInput, PreparedParcel } from '../src/types.ts';
import { startStandin, type Standin } from './helpers/standin.ts';

const GOOD = { apiToken: 'standin-token', userGuid: 'standin-guid' };
const courier = 'noest';

let standin: Standin;
beforeAll(async () => {
  standin = await startStandin();
});
afterAll(async () => {
  await standin.stop();
});
beforeEach(async () => {
  await standin.reset();
  await standin.scenario(courier, { quota: false });
});

const communes = JSON.parse(readFileSync(new URL('../../../data/geo/communes.json', import.meta.url), 'utf8')) as Array<{
  wilaya_code: number;
  name_fr: string;
  name_ar: string;
}>;
const sample = communes.find((c) => c.wilaya_code <= 58 && c.wilaya_code !== 50 && /[éèïîâ]/.test(c.name_fr));
if (!sample) throw new Error('needs an accented commune');
const WILAYA = sample.wilaya_code;

const ctx = (extra: Partial<CourierContext> = {}): CourierContext => ({ env: 'test', standinUrl: standin.url, timeoutMs: 400, ...extra });
const input = (overrides: Partial<ParcelInput> = {}): ParcelInput => ({
  reference: 'HB-NE001',
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
  (await standin.state(courier)) as unknown as { createCount: number; validateCount: number; readCount: number; parcels: Array<Record<string, unknown>>; lastCreateBody: Record<string, unknown>; lastTrackingsBody: Record<string, unknown> };
const row = (event_key: string | null, date: string, event: string | null = null) => ({ event_key, event, date });

describe('registry', () => {
  it('is registered and says what is second-hand', () => {
    expect(getCourier('noest')).toBe(adapter);
    expect(adapter.confidence).toMatchObject({ baseUrl: 'probed', statusList: 'unofficial' });
    expect(adapter.confidence.notes).toEqual(expect.arrayContaining(['docs_private_pdf', 'no_lookup_by_reference']));
    expect(adapter.capabilities).toMatchObject({ verifyByReference: false, needsValidation: true, webhook: 'none', pollBatchSize: 50 });
  });
});

describe('createParcel', () => {
  it('creates a draft with the total as the amount', async () => {
    const parcel = await prepared();
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toMatchObject({ kind: 'accepted', draft: true });
    const state = await fullState();
    expect(state.createCount).toBe(1);
    expect(state.lastCreateBody).toMatchObject({ user_guid: 'standin-guid', montant: 5600, type_id: 1, reference: 'HB-NE001', phone: '0560417403' });
  });

  it('never says rejected on a 200 refusal, the only sample of which says it already exists', async () => {
    const parcel = await prepared();
    await standin.scenario(courier, { create: 'exists' });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'refused_no_code' });
  });

  it.each(['duplicate', 'duplicate-value', 'mixed'])('a duplicate (%s) is uncertain', async (create) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'duplicate_reference' });
  });

  it('a real resend hits the duplicate, with no second parcel', async () => {
    const parcel = await prepared();
    await adapter.createParcel(parcel, GOOD, ctx());
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'duplicate_reference' });
    expect((await fullState()).parcels).toHaveLength(1);
  });

  it.each([
    ['suspended', 'Compte suspendu'],
    ['field-error', 'Le champ phone est invalide.'],
  ])('a %s 422 is a definite rejection', async (create, detail) => {
    const parcel = await prepared();
    await standin.scenario(courier, { create });
    expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'rejected', code: 'bad_request', detail });
  });

  it.each(['unlisted-422', 'no-errors-422', 'other-ref', 'tracking-null', 'tracking-empty', 'tracking-number', 'success-1', 'bad-json', 'html', 'redirect', '408', '409', '500-no-create'])(
    'an odd answer (%s) is uncertain',
    async (create) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create });
      expect((await adapter.createParcel(parcel, GOOD, ctx())).kind).toBe('uncertain');
      expect((await fullState()).createCount).toBe(1);
    },
  );

  it('wrong token and swapped GUID are definite', async () => {
    const parcel = await prepared();
    expect(await adapter.createParcel(parcel, { ...GOOD, apiToken: 'x' }, ctx())).toMatchObject({ kind: 'rejected', code: 'auth' });
    expect(await adapter.createParcel(parcel, { ...GOOD, userGuid: 'x' }, ctx())).toMatchObject({ kind: 'rejected', code: 'bad_request' });
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

  it('refuses another courier’s parcel', async () => {
    expect(await adapter.createParcel({ courier: 'x', reference: 'r', payload: {} }, GOOD, ctx())).toMatchObject({ code: 'wrong_courier' });
  });
});

describe('no lookup by reference', () => {
  it('is always unsupported, with no request, and never safe to resend', async () => {
    const spy = vi.fn<typeof fetch>();
    const result = await adapter.findByReference('HB-NE001', { attemptedAt: 1 }, GOOD, ctx({ fetch: spy }));
    expect(result).toEqual({ kind: 'unavailable', cause: 'unsupported' });
    expect(spy).not.toHaveBeenCalled();
    expect(isResendSafe(result, 0, adapter.capabilities)).toBe(false);
  });
});

describe('validateParcel', () => {
  const options = { askCollection: false };
  const created = async () => {
    const result = await adapter.createParcel(await prepared(), GOOD, ctx());
    if (result.kind !== 'accepted') throw new Error('no parcel');
    return result.tracking;
  };

  it('validates, and a repeat is locked', async () => {
    const tracking = await created();
    expect(await adapter.validateParcel(tracking, options, GOOD, ctx())).toEqual({ kind: 'validated' });
    expect(await adapter.validateParcel(tracking, options, GOOD, ctx())).toMatchObject({ kind: 'rejected', code: 'locked' });
    const state = await fullState();
    expect(state.validateCount).toBe(2);
    expect(state.createCount).toBe(1);
  });

  it('a hang is uncertain and not retried; a 500 is uncertain', async () => {
    const tracking = await created();
    await standin.scenario(courier, { validate: 'hang' });
    expect(await adapter.validateParcel(tracking, options, GOOD, ctx({ timeoutMs: 100 }))).toEqual({ kind: 'uncertain', cause: 'timeout' });
    expect((await fullState()).validateCount).toBe(1);
    await standin.scenario(courier, { validate: '500' });
    expect((await adapter.validateParcel(tracking, options, GOOD, ctx())).kind).toBe('uncertain');
  });

  it('refuses an invalid tracking without calling out', async () => {
    const spy = vi.fn<typeof fetch>();
    expect(await adapter.validateParcel('../x', options, GOOD, ctx({ fetch: spy }))).toMatchObject({ code: 'bad_request' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchStatuses', () => {
  const pollOne = async (activity: unknown[]) => {
    const [t] = await seed([{ activity }]);
    const result = await adapter.fetchStatuses([t as string], GOOD, ctx());
    if (!result.ok) throw new Error(result.cause);
    return { tracking: t as string, result };
  };

  it('takes the latest row by date, not by position', async () => {
    const { result } = await pollOne([row('livre', '2026-01-02 12:00:00'), row('upload', '2026-01-01 10:00:00')]);
    expect(result.events[0]).toMatchObject({ rawStatus: 'livre', status: 'delivered', occurredAt: Date.UTC(2026, 0, 2, 11) });
  });

  it('on a tie, the later row wins', async () => {
    const { result } = await pollOne([row('upload', '2026-01-02 10:00:00'), row('pickedup', '2026-01-02 10:00:00')]);
    expect(result.events[0]?.status).toBe('in_transit');
  });

  it('skips and counts a row with an unparseable date', async () => {
    const { result } = await pollOne([row('upload', '2026-01-02 10:00:00'), row('livre', 'bientôt')]);
    expect(result.events[0]?.status).toBe('pending');
    expect(result.badRows).toBe(1);
  });

  it('a remark doesn’t move the status or the key', async () => {
    const base = [row('pickedup', '2026-01-02 10:00:00')];
    const { tracking, result: before } = await pollOne(base);
    await standin.control(`${courier}/parcels/${tracking}/status`, { event_key: 'edit_price', date: '2026-01-02 11:00:00' });
    const after = await adapter.fetchStatuses([tracking], GOOD, ctx());
    if (!after.ok) throw new Error(after.cause);
    expect(after.events[0]?.eventKey).toBe(before.events[0]?.eventKey);
  });

  it('a finance event after delivery stays delivered', async () => {
    const { result } = await pollOne([row('livre', '2026-01-02 10:00:00'), row('verssement_admin_cust', '2026-01-03 10:00:00')]);
    expect(result.events[0]?.status).toBe('delivered');
  });

  it('falls back to the English event, in the label table only', async () => {
    expect((await pollOne([row(null, '2026-01-02 10:00:00', 'Out for delivery')])).result.events[0]?.status).toBe('in_transit');
    // `livre` is a key, not a label.
    expect((await pollOne([row(null, '2026-01-02 10:00:00', 'livre')])).result.events[0]?.status).toBe('unknown');
    expect((await pollOne([row(null, '2026-01-02 10:00:00', 'Colis livré')])).result.events[0]?.status).toBe('unknown');
  });

  it.each(['echange_valide', 'pickup_picked_recu'])('%s is an exception', async (key) => {
    expect((await pollOne([row(key, '2026-01-02 10:00:00')])).result.events[0]?.status).toBe('exception');
  });

  it('an empty activity is no event, not absent and not bad', async () => {
    const { result } = await pollOne([]);
    expect(result).toMatchObject({ events: [], absent: [], badRows: 0 });
  });

  it('404 on a batch of one is absent, on a batch of two a failure', async () => {
    expect(await adapter.fetchStatuses(['NST-1'], GOOD, ctx())).toMatchObject({ ok: true, absent: ['NST-1'] });
    expect(await adapter.fetchStatuses(['NST-1', 'NST-2'], GOOD, ctx())).toEqual({ ok: false, cause: 'batch_not_found' });
  });

  it('another 404 is a failure, a POST read is not retried', async () => {
    await standin.scenario(courier, { read: 'odd-404' });
    expect((await adapter.fetchStatuses(['NST-1'], GOOD, ctx())).ok).toBe(false);
    await standin.reset();
    await standin.scenario(courier, { quota: false, read: '503' });
    await adapter.fetchStatuses(['NST-1'], GOOD, ctx());
    expect((await fullState()).readCount).toBe(1);
  });

  it('keeps good rows, reports invalid and absent, and sends the guid', async () => {
    const [a] = await seed([{ activity: [row('livre', '2026-01-02 10:00:00')] }]);
    const result = await adapter.fetchStatuses([a as string, 'NST-NONE', 'a,b'], GOOD, ctx());
    expect(result).toMatchObject({ ok: true, absent: ['NST-NONE'], invalid: ['a,b'] });
    expect((await fullState()).lastTrackingsBody).toMatchObject({ user_guid: 'standin-guid' });
  });

  it('refuses a batch over the limit', async () => {
    expect((await adapter.fetchStatuses(Array.from({ length: 51 }, (_, i) => `N-${i}`), GOOD, ctx())).ok).toBe(false);
  });
});

describe('checkCredentials', () => {
  it('good, wrong token, swapped GUID', async () => {
    expect(await adapter.checkCredentials(GOOD, ctx())).toEqual({ kind: 'valid' });
    expect((await adapter.checkCredentials({ ...GOOD, apiToken: 'x' }, ctx())).kind).toBe('invalid');
    expect(await adapter.checkCredentials({ ...GOOD, userGuid: 'x' }, ctx())).toEqual({ kind: 'invalid', detail: 'Partenaire introuvable' });
  });

  it('an inconclusive probe can’t prove a key', async () => {
    const answers: Array<[number, unknown]> = [
      [200, [{ code: 1, nom: 'Adrar', is_active: 1 }]],
      [422, { errors: { trackings: ['invalide'] } }],
    ];
    let i = 0;
    const replay: typeof fetch = async () => {
      const [status, body] = answers[Math.min(i, 1)] as [number, unknown];
      i += 1;
      return new Response(JSON.stringify(body), { status });
    };
    expect((await adapter.checkCredentials(GOOD, ctx({ fetch: replay }))).kind).toBe('unavailable');
  });

  it.each([
    [{ read: 'odd-404' }, 'unavailable'],
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
    fails('address_required', { address: 'x'.repeat(256) });
    fails('stop_desk_required', { deliveryType: 'stop_desk' });
    fails('stop_desk_mismatch', { deliveryType: 'stop_desk', stopDeskId: 'nope' });
    fails('wilaya_unmapped', { wilayaCode: 70 });
    fails('commune_unmapped', { commune: { nameFr: 'Nulle Part', nameAr: 'لا مكان' } });
    fails('phone_invalid', { phone: '0543123456' });
    fails('amount_out_of_range', { codTotalDzd: 1.5 });
    fails('recipient_required', { recipientName: ' ' });
    fails('lists_missing', {}, { wilayas: [], communes: [], stopDesks: [] });
  });

  it('wilaya 50 is inactive at the stand-in, so not deliverable', async () => {
    const parent = await loadLists(50);
    expect(parent.wilayas.find((w) => w.code === 50)?.deliverable).toBe(false);
    fails('wilaya_not_deliverable', { wilayaCode: 50 }, parent);
  });

  it('ships a new wilaya through its parent', async () => {
    const elKantara = communes.find((c) => c.wilaya_code === 61);
    if (!elKantara) throw new Error('no commune');
    const result = adapter.prepare(input({ wilayaCode: 61, commune: { nameFr: elKantara.name_fr, nameAr: elKantara.name_ar } }), await loadLists(61));
    if (!result.ok) throw new Error(result.code);
    expect(result.parcel.payload['wilaya_id']).toBe(7);
    expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
  });

  it('a stop desk sends its code, and the courier accepts it', async () => {
    const desk = lists.stopDesks[0];
    if (!desk) throw new Error('no desk');
    const result = adapter.prepare(input({ deliveryType: 'stop_desk', stopDeskId: desk.id, address: undefined as never }), lists);
    if (!result.ok) throw new Error(result.code);
    expect(result.parcel.payload).toMatchObject({ stop_desk: 1, station_code: desk.id, commune: desk.communeName, adresse: desk.address });
    expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
  });

  it('desks use the code’s number, without a leading zero', async () => {
    const answer: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          '16A': { code: '16A', name: 'A', commune: 'Hydra', address: 'x' },
          '1A': { code: '1A', name: 'B', commune: 'Adrar', address: 'y' },
          '05A': { code: '5A', name: 'C', commune: 'Batna', address: 'z' },
          BAD: { code: 'XYZ', name: 'D' },
        }),
      );
    for (const [wilaya, id] of [
      [16, '16A'],
      [1, '1A'],
      [5, '5A'],
    ] as const) {
      const desks = await adapter.listStopDesks(wilaya, GOOD, ctx({ fetch: answer }));
      if (!desks.ok) throw new Error(desks.cause);
      expect(desks.items.map((d) => d.id)).toEqual([id]);
    }
  });

  it('drops a commune row naming another wilaya', async () => {
    const answer: typeof fetch = async () =>
      new Response(JSON.stringify([{ nom: 'Hydra', wilaya_id: 16, is_active: 1 }, { nom: 'Batna', wilaya_id: 5, is_active: 1 }]));
    const list = await adapter.listCommunes(16, GOOD, ctx({ fetch: answer }));
    expect(list.ok && list.items.map((c) => c.name)).toEqual(['Hydra']);
  });
});

describe('labels', () => {
  it('returns PDF bytes; a 200 that isn’t one is an error', async () => {
    const created = await adapter.createParcel(await prepared(), GOOD, ctx());
    if (created.kind !== 'accepted') throw new Error('no parcel');
    expect((await adapter.getLabel(created.tracking, GOOD, ctx())).kind).toBe('pdf');
    await standin.scenario(courier, { label: 'not-pdf' });
    expect(await adapter.getLabel(created.tracking, GOOD, ctx())).toEqual({ kind: 'unavailable', cause: 'not_pdf' });
  });
});

describe('guard and failure values', () => {
  it('refuses with no stand-in', async () => {
    const spy = vi.fn<typeof fetch>();
    const local: CourierContext = { env: 'development', fetch: spy };
    const parcel = await prepared();
    expect(await adapter.createParcel(parcel, GOOD, local)).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
    expect(await adapter.validateParcel('NST-1', { askCollection: false }, GOOD, local)).toMatchObject({ code: 'guard_refused' });
    expect((await adapter.fetchStatuses(['NST-1'], GOOD, local)).ok).toBe(false);
    expect((await adapter.checkCredentials(GOOD, local)).kind).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('goes to the real host in production', async () => {
    const spy = vi.fn<typeof fetch>(async () => new Response('[]'));
    await adapter.listWilayas({ ...GOOD, host: 'evil.test' }, { env: 'production', standinUrl: standin.url, fetch: spy });
    expect(String(spy.mock.calls[0]?.[0])).toBe('https://app.noest-dz.com/api/public/get/wilayas');
  });

  it.each([
    ['TypeError', new TypeError('failed SECRET-G')],
    ['AbortError', new DOMException('aborted', 'AbortError')],
  ])('never throws on %s, never leaks', async (_name, error) => {
    const context = ctx({ fetch: (async () => { throw error; }) as typeof fetch });
    const secrets = { apiToken: 'SECRET-T', userGuid: 'SECRET-G' };
    const parcel = await prepared();
    const results = [
      await adapter.createParcel(parcel, secrets, context),
      await adapter.validateParcel('NST-1', { askCollection: false }, secrets, context),
      await adapter.fetchStatuses(['NST-1'], secrets, context),
      await adapter.checkCredentials(secrets, context),
      await adapter.listWilayas(secrets, context),
      await adapter.listCommunes(16, secrets, context),
      await adapter.listStopDesks(16, secrets, context),
      await adapter.getLabel('NST-1', secrets, context),
    ];
    expect(JSON.stringify(results)).not.toContain('SECRET');
  });

  it('never returns customer data', async () => {
    const created = await adapter.createParcel(await prepared(), GOOD, ctx());
    if (created.kind !== 'accepted') throw new Error('no parcel');
    const polled = await adapter.fetchStatuses([created.tracking], GOOD, ctx());
    const text = JSON.stringify([created, polled]);
    expect(text).not.toContain('Benali');
    expect(text).not.toContain('560417403');
  });
});

describe('stand-in rules', () => {
  const post = (body: unknown, headers: Record<string, string> = { Authorization: 'Bearer standin-token' }) =>
    fetch(`${standin.url}/noest/api/public/create/order`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('requires Bearer, the GUID and a long enough reference', async () => {
    expect((await post({}, {})).status).toBe(401);
    expect((await post({ user_guid: 'x' })).status).toBe(404);
    const parcel = await prepared();
    const short = { user_guid: 'standin-guid', ...parcel.payload, reference: 'x' };
    expect((await post(short)).status).toBe(422);
  });

  it('refuses our spelling of a commune', async () => {
    const parcel = await prepared();
    const ours = { user_guid: 'standin-guid', ...parcel.payload, commune: sample.name_fr };
    expect((await post(ours)).status).toBe(422);
  });
});

describe('fixtures replayed through the adapter', () => {
  type Native = Array<{ status: number; body: unknown }>;
  const fixture = (path: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/dz-delivery/noest/${path}`, import.meta.url), 'utf8')) as Native;
  const answer = (entry: { status: number; body: unknown } | undefined): typeof fetch =>
    (async () => new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 })) as typeof fetch;
  const ctxOf = (fetcher: typeof fetch): CourierContext => ({ env: 'production', fetch: fetcher });
  const last = (file: string) => {
    const responses = fixture(file);
    return responses[responses.length - 1];
  };
  const parcel: PreparedParcel = { courier: 'noest', reference: 'ORD-1001', payload: { reference: 'ORD-1001' } };

  it('home delivery is accepted as a draft', async () => {
    expect(await adapter.createParcel(parcel, GOOD, ctxOf(answer(last('createParcel/home-delivery.native.json'))))).toEqual({
      kind: 'accepted',
      tracking: 'NST-TST-00000001',
      draft: true,
    });
  });

  it('the sampled refusal is uncertain', async () => {
    expect(await adapter.createParcel(parcel, GOOD, ctxOf(answer(last('createParcel/rejected.native.json'))))).toEqual({
      kind: 'uncertain',
      cause: 'refused_no_code',
    });
  });

  it('suspension and field errors are rejected', async () => {
    for (const file of ['createParcel/account-suspended.native.json', 'createParcel/validation-error.native.json']) {
      expect((await adapter.createParcel(parcel, GOOD, ctxOf(answer(last(file))))).kind).toBe('rejected');
    }
  });

  it('delivered and return-in-progress tracking', async () => {
    const delivered = await adapter.fetchStatuses(['NST-TST-00000001'], GOOD, ctxOf(answer(fixture('track/delivered.native.json')[0])));
    expect(delivered.ok && delivered.events[0]?.status).toBe('delivered');
    // dz-delivery counts this as returned, but its last event is a return still on its way (rule 7).
    const returning = await adapter.fetchStatuses(['NST-TST-00000001'], GOOD, ctxOf(answer(fixture('track/returned.native.json')[0])));
    expect(returning.ok && returning.events[0]?.status).toBe('returning');
  });

  it('labels-only fixtures use the English event', async () => {
    const result = await adapter.fetchStatuses(['NST-TST-00000001'], GOOD, ctxOf(answer(fixture('track/labels-only.native.json')[0])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.status).not.toBe('unknown');
  });

  it('a not-validated order has no event, and isn’t absent', async () => {
    expect(await adapter.fetchStatuses(['NST-TST-00000001'], GOOD, ctxOf(answer(fixture('track/not-validated.native.json')[0])))).toEqual({
      ok: true,
      events: [],
      absent: [],
      invalid: [],
      badRows: 0,
    });
  });

  it('not found on one tracking is absent', async () => {
    expect(await adapter.fetchStatuses(['NST-1'], GOOD, ctxOf(answer(fixture('track/not-found.native.json')[0])))).toMatchObject({ ok: true, absent: ['NST-1'] });
  });

  it('wilayas keep their active flag', async () => {
    const result = await adapter.listWilayas(GOOD, ctxOf(answer(fixture('getWilayas/basic.native.json')[0])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.find((w) => w.code === 50)?.deliverable).toBe(false);
    expect(result.items.find((w) => w.code === 16)?.deliverable).toBe(true);
  });

  it('desks parse per wilaya', async () => {
    const result = await adapter.listStopDesks(16, GOOD, ctxOf(answer(fixture('getStopDesks/by-wilaya.native.json')[0])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((d) => d.id.startsWith('16'))).toBe(true);
  });
});
