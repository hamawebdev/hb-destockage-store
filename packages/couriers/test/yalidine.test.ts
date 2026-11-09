import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCourier, listCouriers } from '../src/registry.ts';
import { isResendSafe } from '../src/resend.ts';
import { guepex, yalidine } from '../src/yalidine/adapter.ts';
import type {
  CourierAdapter,
  CourierContext,
  CourierLists,
  LookupResult,
  ParcelInput,
  PreparedParcel,
} from '../src/types.ts';
import { startStandin, type Standin } from './helpers/standin.ts';

const GOOD = { apiId: 'standin-id', apiToken: 'standin-token' };
const BAD = { apiId: 'nope', apiToken: 'also-nope' };

let standin: Standin;
beforeAll(async () => {
  standin = await startStandin();
});
afterAll(async () => {
  await standin.stop();
});

const geo = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../data/geo/${name}.json`, import.meta.url), 'utf8')) as Array<{
    code: number;
    wilaya_code: number;
    name_fr: string;
    name_ar: string;
  }>;
const COMMUNES = geo('communes');
// A commune whose name the stand-in spells differently from ours, because it drops accents.
const accented = COMMUNES.find((c) => c.wilaya_code <= 58 && c.wilaya_code !== 31 && /[éèïîâ]/.test(c.name_fr));
if (!accented) throw new Error('fixture needs an accented commune');
const WILAYA = accented.wilaya_code;
const wilayaName = (geo('wilayas') as Array<{ code: number; name_fr: string }>)
  .find((w) => w.code === WILAYA)
  ?.name_fr.normalize('NFD')
  .replace(/\p{M}/gu, '') as string;

describe('registry', () => {
  it('lists the Yalidine family', () => {
    expect(listCouriers().filter((a) => a.family === 'yalidine').map((a) => a.id)).toEqual(['yalidine', 'guepex']);
  });

  it('finds an adapter by id', () => {
    expect(getCourier('yalidine')).toBe(yalidine);
    expect(getCourier('guepex')).toBe(guepex);
  });

  it('says what is unconfirmed', () => {
    expect(yalidine.confidence).toMatchObject({ baseUrl: 'probed', statusList: 'unofficial' });
    expect(yalidine.confidence.notes).toContain('webhook_signature_unverified');
    expect(guepex.confidence.notes).toContain('status_list_inherited_from_yalidine');
  });
});

describe.each<[string, CourierAdapter]>([
  ['yalidine', yalidine],
  ['guepex', guepex],
])('%s adapter', (courier, adapter) => {
  const ctx = (extra: Partial<CourierContext> = {}): CourierContext => ({
    env: 'test',
    standinUrl: standin.url,
    timeoutMs: 400,
    ...extra,
  });

  const loadLists = async (wilaya = WILAYA): Promise<CourierLists> => {
    const [wilayas, communes, stopDesks] = await Promise.all([
      adapter.listWilayas(GOOD, ctx({ timeoutMs: 3000 })),
      adapter.listCommunes(wilaya, GOOD, ctx({ timeoutMs: 3000 })),
      adapter.listStopDesks(wilaya, GOOD, ctx({ timeoutMs: 3000 })),
    ]);
    if (!wilayas.ok || !communes.ok || !stopDesks.ok) throw new Error('lists failed');
    return { wilayas: wilayas.items, communes: communes.items, stopDesks: stopDesks.items };
  };

  const input = (overrides: Partial<ParcelInput> = {}): ParcelInput => ({
    reference: 'HB-7K2Q9',
    recipientName: 'Amina Benali',
    phone: '+213560417403',
    wilayaCode: WILAYA,
    commune: { nameFr: accented.name_fr, nameAr: accented.name_ar },
    deliveryType: 'home',
    address: '12 rue Didouche',
    codTotalDzd: 5600,
    productLabel: 'Sac x1',
    originWilayaCode: 16,
    ...overrides,
  });

  const prepared = async (overrides: Partial<ParcelInput> = {}): Promise<PreparedParcel> => {
    const result = adapter.prepare(input(overrides), await loadLists(overrides.wilayaCode ?? WILAYA));
    if (!result.ok) throw new Error(`prepare failed: ${result.code} ${result.detail}`);
    return result.parcel;
  };

  const payload = (parcel: PreparedParcel) => parcel.payload as Record<string, unknown>;

  beforeEach(async () => {
    await standin.reset();
    await standin.scenario(courier, { quota: false });
  });

  describe('createParcel', () => {
    it('accepts a parcel, with the courier spelling of wilaya and commune', async () => {
      const parcel = await prepared();
      const result = await adapter.createParcel(parcel, GOOD, ctx());
      expect(result).toMatchObject({ kind: 'accepted', draft: false });
      if (result.kind !== 'accepted') throw new Error('not accepted');
      expect(result.tracking).toMatch(/^(yal|gpx)-\d{6}$/);
      expect(result.labelUrl).toContain(`/label/${result.tracking}`);
      const state = await standin.state(courier);
      expect(state.createCount).toBe(1);
      expect(state.parcels).toHaveLength(1);
      // The stand-in has no accents, so sending our own spelling would have been refused.
      expect(payload(parcel)['to_commune_name']).not.toBe(accented.name_fr);
    });

    it('sends an array of one, in the courier phone format', async () => {
      await adapter.createParcel(await prepared(), GOOD, ctx());
      const body = (await standin.state(courier)).lastCreateBody as Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0]?.['contact_phone']).toBe('0560417403');
    });

    it('collects the total once: price is the total, no fee added on top', async () => {
      const parcel = await prepared({ codTotalDzd: 5600 });
      await adapter.createParcel(parcel, GOOD, ctx());
      const state = await standin.state(courier);
      expect(state.parcels[0]?.['collected']).toBe(5600);
      expect(payload(parcel)).toMatchObject({
        price: 5600,
        freeshipping: true,
        do_insurance: false,
        declared_value: 5600,
        has_exchange: false,
      });
    });

    it('a row refused by the courier is rejected, and nothing is stored', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'reject' });
      expect(await adapter.createParcel(parcel, GOOD, ctx())).toMatchObject({
        kind: 'rejected',
        code: 'courier_refused',
        detail: 'stopdesk_id is not valid',
      });
      expect((await standin.state(courier)).parcels).toHaveLength(0);
    });

    it('wrong credentials are refused by the stand-in with no forced scenario', async () => {
      const parcel = await prepared();
      expect(await adapter.createParcel(parcel, BAD, ctx())).toMatchObject({ kind: 'rejected', code: 'auth' });
      expect((await standin.state(courier)).parcels).toHaveLength(0);
    });

    it('a real quota overrun is rejected with a delay', async () => {
      const parcel = await prepared();
      await standin.reset();
      await standin.scenario(courier, { quota: true });
      const results = [];
      for (let i = 0; i < 8; i += 1) results.push(await adapter.createParcel(parcel, GOOD, ctx()));
      const limited = results.filter((r) => r.kind === 'rejected' && r.code === 'rate_limited');
      expect(limited.length).toBeGreaterThan(0);
      expect(limited[0]).toHaveProperty('retryAfterMs');
    });

    it.each(['408', '409', '425'])('HTTP %s leaves it uncertain', async (status) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: status });
      expect(await adapter.createParcel(parcel, GOOD, ctx())).toMatchObject({ kind: 'uncertain' });
    });

    it.each(['400', '403', '404', '422'])('HTTP %s is a definite rejection', async (status) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: status });
      expect(await adapter.createParcel(parcel, GOOD, ctx())).toMatchObject({ kind: 'rejected' });
    });

    it('does not follow a redirect to a real host', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'redirect' });
      expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({ kind: 'uncertain', cause: 'redirect_302' });
    });

    it.each([
      'bad-json',
      'html',
      'missing-ref',
      'tracking-null',
      'tracking-empty',
      'tracking-number',
      'success-1',
      'success-string',
      'false-with-tracking',
      'two-rows',
    ])('a malformed 200 (%s) is uncertain', async (scenario) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: scenario });
      const result = await adapter.createParcel(parcel, GOOD, ctx());
      expect(result.kind).toBe('uncertain');
      expect((await standin.state(courier)).createCount).toBe(1);
    });

    it('a parcel prepared for another courier is refused', async () => {
      const other = { courier: 'someone-else', reference: 'X', payload: {} };
      expect(await adapter.createParcel(other, GOOD, ctx())).toMatchObject({ kind: 'rejected', code: 'wrong_courier' });
    });
  });

  describe('a create that may or may not have happened', () => {
    const attemptLookup = () => adapter.findByReference('HB-7K2Q9', { attemptedAt: Date.now() }, GOOD, ctx({ timeoutMs: 2000 }));

    it('create-then-hang: uncertain, then found', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'create-then-hang' });
      expect(await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 150 }))).toEqual({
        kind: 'uncertain',
        cause: 'timeout',
      });
      expect(await attemptLookup()).toMatchObject({ kind: 'found', status: 'pending', gone: false });
      expect((await standin.state(courier)).createCount).toBe(1);
    });

    it('headers sent then the body stalls: uncertain, then found', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'headers-then-stall' });
      expect(await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 150 }))).toEqual({
        kind: 'uncertain',
        cause: 'timeout',
      });
      expect(await attemptLookup()).toMatchObject({ kind: 'found' });
    });

    it.each([
      ['hang-no-create', 'not_found'],
      ['500-no-create', 'not_found'],
      ['500-after-create', 'found'],
    ])('%s: uncertain, then %s', async (scenario, expected) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: scenario });
      const result = await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 150 }));
      expect(result.kind).toBe('uncertain');
      expect((await attemptLookup()).kind).toBe(expected);
      expect((await standin.state(courier)).createCount).toBe(1);
    });

    it('create-late: an early not_found does not permit a resend', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'create-late', lateMs: 600 });
      expect((await adapter.createParcel(parcel, GOOD, ctx({ timeoutMs: 100 }))).kind).toBe('uncertain');
      const attemptEndedAt = Date.now();
      const early = await attemptLookup();
      expect(early.kind).toBe('not_found');
      expect(isResendSafe(early, attemptEndedAt, adapter.capabilities, null)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect((await attemptLookup()).kind).toBe('found');
    });
  });

  describe('findByReference', () => {
    const find = (ref = 'HB-7K2Q9', extra: Partial<CourierContext> = {}): Promise<LookupResult> =>
      adapter.findByReference(ref, { attemptedAt: Date.now() }, GOOD, ctx(extra));

    it('stamps checkedAt on not_found', async () => {
      expect(await find('HB-NONE', { now: () => 1234 })).toEqual({ kind: 'not_found', checkedAt: 1234 });
    });

    it.each(['down', 'html', 'no-total', 'bad-json', '401', '429', '503', 'none-exact'])(
      '%s is unavailable, never not_found',
      async (read) => {
        await standin.control(`${courier}/seed`, { parcels: [{ order_id: 'HB-OTHER' }] });
        await standin.scenario(courier, { read });
        expect((await find()).kind).toBe('unavailable');
      },
    );

    it('carries the delay on 429', async () => {
      await standin.scenario(courier, { read: '429' });
      expect(await find()).toMatchObject({ kind: 'unavailable', retryAfterMs: 9000 });
    });

    it('two exact rows are multiple even if one has an unusable tracking', async () => {
      const body = { has_more: false, total_data: 2, data: [{ order_id: 'R', tracking: 'yal-1', last_status: 'Livré' }, { order_id: 'R', tracking: 'bad,one' }] };
      const result = await adapter.findByReference('R', { attemptedAt: 1 }, GOOD, ctx({ fetch: async () => new Response(JSON.stringify(body)) }));
      expect(result).toEqual({ kind: 'multiple', trackings: ['yal-1'] });
    });

    it('two exact rows are multiple, not the first', async () => {
      await standin.control(`${courier}/seed`, {
        parcels: [{ order_id: 'HB-7K2Q9' }, { order_id: 'HB-7K2Q9' }],
      });
      const result = await find();
      expect(result.kind).toBe('multiple');
      if (result.kind === 'multiple') expect(result.trackings).toHaveLength(2);
    });

    it.each(['Supprimé', 'Annulé'])('%s is reported as gone', async (last_status) => {
      await standin.control(`${courier}/seed`, { parcels: [{ order_id: 'HB-7K2Q9', last_status }] });
      expect(await find()).toMatchObject({ kind: 'found', gone: true, status: 'exception' });
    });

    it('an unlisted status is unknown', async () => {
      await standin.control(`${courier}/seed`, { parcels: [{ order_id: 'HB-7K2Q9', last_status: 'Nouveau' }] });
      expect(await find()).toMatchObject({ kind: 'found', status: 'unknown', rawStatus: 'Nouveau' });
    });

    it('needs the attempt time', async () => {
      const result = await adapter.findByReference('X', { attemptedAt: Number.NaN }, GOOD, ctx());
      expect(result).toMatchObject({ kind: 'unavailable', cause: 'attempted_at_missing' });
      const missing = await adapter.findByReference('X', undefined as never, GOOD, ctx());
      expect(missing.kind).toBe('unavailable');
    });

    it('retries a read once on 503', async () => {
      await standin.scenario(courier, { read: '503-once' });
      expect((await find()).kind).toBe('not_found');
      expect((await standin.state(courier)).readCount).toBe(2);
    });

    it('does not retry a read on 429', async () => {
      await standin.scenario(courier, { read: '429' });
      await find();
      expect((await standin.state(courier)).readCount).toBe(1);
    });

    it('never returns customer data', async () => {
      const parcel = await prepared();
      await adapter.createParcel(parcel, GOOD, ctx());
      const text = JSON.stringify(await find());
      for (const field of ['firstname', 'familyname', 'contact_phone', 'address', '***']) {
        expect(text).not.toContain(field);
      }
    });
  });

  describe('fetchStatuses', () => {
    const seed = async (parcels: Array<Record<string, unknown>>) =>
      ((await standin.control(`${courier}/seed`, { parcels })) as { trackings: string[] }).trackings;

    it('maps each parcel and reports absent and invalid trackings', async () => {
      const [a, b] = await seed([
        { order_id: 'A', last_status: 'Livré', date_last_status: '2025-12-30 13:24:34' },
        { order_id: 'B', last_status: 'Sorti en livraison' },
      ]);
      const result = await adapter.fetchStatuses([a as string, b as string, 'yal-MISSING', 'a,b', '../x', 'x?y=1'], GOOD, ctx());
      if (!result.ok) throw new Error(result.cause);
      expect(result.events.find((e) => e.tracking === a)).toMatchObject({
        status: 'delivered',
        occurredAt: 1767097474000,
        eventKey: `${a as string}|Livré|1767097474000`,
      });
      expect(result.events.find((e) => e.tracking === b)?.status).toBe('in_transit');
      expect(result.absent).toEqual(['yal-MISSING']);
      expect(result.invalid).toEqual(['a,b', '../x', 'x?y=1']);
      const url = (await standin.state(courier)).lastUrl ?? '';
      expect(url).not.toContain('..');
      expect(url).toContain('page_size=1000');
    });

    it('never sends a refused tracking', async () => {
      const spy = vi.fn<typeof fetch>();
      const result = await adapter.fetchStatuses(['../x'], GOOD, ctx({ fetch: spy }));
      expect(result).toEqual({ ok: true, events: [], absent: [], invalid: ['../x'], badRows: 0 });
      expect(spy).not.toHaveBeenCalled();
    });

    it('refuses a batch over the limit rather than dropping parcels', async () => {
      const many = Array.from({ length: adapter.capabilities.pollBatchSize + 1 }, (_, i) => `yal-${i}`);
      expect(await adapter.fetchStatuses(many, GOOD, ctx())).toMatchObject({ ok: false, cause: 'batch_too_large' });
    });

    it('fails with a delay on 429, and on a down courier', async () => {
      const [a] = await seed([{ order_id: 'A' }]);
      await standin.scenario(courier, { read: '429' });
      expect(await adapter.fetchStatuses([a as string], GOOD, ctx())).toMatchObject({ ok: false, retryAfterMs: 9000 });
      await standin.scenario(courier, { read: 'ok', down: true });
      expect((await adapter.fetchStatuses([a as string], GOOD, ctx())).ok).toBe(false);
    });

    it('one bad row does not drop the others', async () => {
      const responses = {
        has_more: false,
        total_data: 3,
        data: [
          { tracking: 'yal-1', last_status: 'Livré' },
          { tracking: 'yal-2' },
          'nonsense',
        ],
      };
      const result = await adapter.fetchStatuses(['yal-1', 'yal-2'], GOOD, ctx({
        fetch: async () => new Response(JSON.stringify(responses)),
      }));
      expect(result).toMatchObject({ ok: true, badRows: 2, absent: ['yal-2'] });
      if (result.ok) expect(result.events).toHaveLength(1);
    });

    it('follows has_more and stops at the cap', async () => {
      let calls = 0;
      const endless: typeof fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ has_more: true, total_data: 99, data: [] }));
      };
      expect(await adapter.fetchStatuses(['yal-1'], GOOD, ctx({ fetch: endless }))).toMatchObject({
        ok: false,
        cause: 'too_many_pages',
      });
      expect(calls).toBe(10);
    });

    it('a status walk ends delivered, a duplicate keeps its key, an unknown stays unknown', async () => {
      const parcel = await prepared();
      const created = await adapter.createParcel(parcel, GOOD, ctx());
      if (created.kind !== 'accepted') throw new Error('not accepted');
      const move = (status: string, at: string) =>
        standin.control(`${courier}/parcels/${created.tracking}/status`, { status, at });
      const poll = async () => {
        const result = await adapter.fetchStatuses([created.tracking], GOOD, ctx());
        if (!result.ok || !result.events[0]) throw new Error('no event');
        return result.events[0];
      };

      await move('Sorti en livraison', '2026-01-02 10:00:00');
      const out = await poll();
      expect(out.status).toBe('in_transit');
      expect((await poll()).eventKey).toBe(out.eventKey);

      await move('Statut inventé', '2026-01-02 11:00:00');
      expect((await poll()).status).toBe('unknown');

      await move('Livré', '2026-01-02 12:00:00');
      expect((await poll()).status).toBe('delivered');
    });
  });

  describe('checkCredentials', () => {
    it('good and wrong keys', async () => {
      expect(await adapter.checkCredentials(GOOD, ctx())).toEqual({ kind: 'valid' });
      expect(await adapter.checkCredentials(BAD, ctx())).toMatchObject({ kind: 'invalid' });
    });

    it.each([
      [{ read: '503' }, 'unavailable'],
      [{ down: true }, 'unavailable'],
      [{ read: '429' }, 'rate_limited'],
      [{ read: 'html' }, 'unavailable'],
    ])('%j gives %s, so an outage is never a bad key', async (scenario, kind) => {
      await standin.scenario(courier, scenario);
      expect((await adapter.checkCredentials(GOOD, ctx())).kind).toBe(kind);
    });
  });

  describe('outbound guard through the adapter', () => {
    it('refuses a non-local stand-in URL with nothing sent', async () => {
      const spy = vi.fn<typeof fetch>();
      const parcel = await prepared();
      const result = await adapter.createParcel(parcel, GOOD, ctx({ standinUrl: 'https://api.yalidine.app', fetch: spy }));
      expect(result).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('refuses with no stand-in at all, on every network method', async () => {
      const spy = vi.fn<typeof fetch>();
      const local: CourierContext = { env: 'development', fetch: spy };
      const parcel = await prepared();
      expect(await adapter.createParcel(parcel, GOOD, local)).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
      expect((await adapter.findByReference('X', { attemptedAt: 1 }, GOOD, local)).kind).toBe('unavailable');
      expect((await adapter.fetchStatuses(['yal-1'], GOOD, local)).ok).toBe(false);
      expect((await adapter.checkCredentials(GOOD, local)).kind).toBe('unavailable');
      expect((await adapter.listWilayas(GOOD, local)).ok).toBe(false);
      expect((await adapter.getLabel('yal-1', GOOD, local)).kind).toBe('unavailable');
      expect(spy).not.toHaveBeenCalled();
    });

    it('in production goes to the real base and ignores the stand-in', async () => {
      const spy = vi.fn<typeof fetch>(async () => new Response('{"has_more":false,"total_data":0,"data":[]}'));
      await adapter.findByReference('X', { attemptedAt: 1 }, GOOD, { env: 'production', standinUrl: standin.url, fetch: spy });
      const host = courier === 'yalidine' ? 'https://api.yalidine.app/v1/' : 'https://api.guepex.app/v1/';
      expect(String(spy.mock.calls[0]?.[0])).toMatch(new RegExp(`^${host}`));
    });

    it('no credential value can change the host', async () => {
      const spy = vi.fn<typeof fetch>(async () => new Response('{"data":[]}'));
      const hostile = { apiId: 'https://evil.test', apiToken: 'x', baseUrl: 'https://evil.test', host: 'evil.test' };
      await adapter.checkCredentials(hostile, { env: 'production', fetch: spy });
      expect(new URL(String(spy.mock.calls[0]?.[0])).hostname).toBe(courier === 'yalidine' ? 'api.yalidine.app' : 'api.guepex.app');
    });
  });

  describe('never throws, never leaks', () => {
    const SECRETS = { apiId: 'ID-SECRET-1', apiToken: 'TOKEN-SECRET-2' };

    const allResults = async (context: CourierContext) => {
      const parcel = await prepared();
      return [
        await adapter.createParcel(parcel, SECRETS, context),
        await adapter.findByReference('X', { attemptedAt: 1 }, SECRETS, context),
        await adapter.fetchStatuses(['yal-1'], SECRETS, context),
        await adapter.checkCredentials(SECRETS, context),
        await adapter.listWilayas(SECRETS, context),
        await adapter.listCommunes(16, SECRETS, context),
        await adapter.listStopDesks(16, SECRETS, context),
        await adapter.getLabel('yal-1', SECRETS, context),
      ];
    };

    it.each([
      ['TypeError', new TypeError('fetch failed TOKEN-SECRET-2')],
      ['AbortError', new DOMException('aborted', 'AbortError')],
    ])('an injected fetch rejecting with %s', async (_name, error) => {
      const results = await allResults(ctx({ fetch: (async () => { throw error; }) as typeof fetch }));
      expect(JSON.stringify(results)).not.toContain('SECRET');
    });

    it('a body stream error', async () => {
      const broken: typeof fetch = async () =>
        new Response(new ReadableStream({ start: (c) => c.error(new Error('TOKEN-SECRET-2')) }));
      expect(JSON.stringify(await allResults(ctx({ fetch: broken })))).not.toContain('SECRET');
    });

    it('a courier that echoes the token in its error', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'echo-token' });
      const result = await adapter.createParcel(parcel, GOOD, ctx());
      expect(result.kind).toBe('rejected');
      const text = JSON.stringify(result);
      expect(text).not.toContain('standin-token');
      expect(text).not.toContain('standin-id');
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

    it('refuses what it cannot ship, with the exact reason', () => {
      fails('address_required', { address: '   ' });
      fails('address_required', { address: undefined as never });
      fails('stop_desk_required', { deliveryType: 'stop_desk' });
      fails('stop_desk_mismatch', { deliveryType: 'stop_desk', stopDeskId: '999999' });
      fails('wilaya_unmapped', { wilayaCode: 70 });
      fails('origin_missing', { originWilayaCode: undefined as never });
      fails('amount_out_of_range', { codTotalDzd: 150001 });
      fails('amount_out_of_range', { codTotalDzd: -1 });
      fails('amount_out_of_range', { codTotalDzd: 10.5 });
      fails('commune_unmapped', { commune: { nameFr: 'Nulle Part', nameAr: 'لا مكان' } });
      fails('recipient_required', { recipientName: '   ' });
    });

    it('accepts the top amount', () => {
      expect(adapter.prepare(input({ codTotalDzd: 150000 }), lists).ok).toBe(true);
    });

    it('refuses a stop desk from another wilaya', () => {
      const elsewhere = { ...lists, stopDesks: lists.stopDesks.map((d) => ({ ...d, wilayaCode: 31 })) };
      fails('stop_desk_mismatch', { deliveryType: 'stop_desk', stopDeskId: lists.stopDesks[0]?.id as string }, elsewhere);
    });

    it("takes a stop desk's names from the centre, and the courier accepts it", async () => {
      const desk = lists.stopDesks[0];
      if (!desk) throw new Error('no desk');
      const result = adapter.prepare(input({ deliveryType: 'stop_desk', stopDeskId: desk.id, address: undefined as never }), lists);
      if (!result.ok) throw new Error(result.code);
      expect(result.parcel.payload).toMatchObject({
        to_commune_name: desk.communeName,
        to_wilaya_name: desk.wilayaName,
        address: desk.address,
        is_stopdesk: true,
      });
      expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
    });

    it('reports a commune and a wilaya the courier does not serve', () => {
      const noCommune = { ...lists, communes: lists.communes.map((c) => ({ ...c, deliverable: false })) };
      fails('commune_not_deliverable', {}, noCommune);
      const noWilaya = { ...lists, wilayas: lists.wilayas.map((w) => ({ ...w, deliverable: false })) };
      fails('wilaya_not_deliverable', {}, noWilaya);
    });

    it('needs the lists', () => {
      fails('lists_missing', {}, { wilayas: [], communes: [], stopDesks: [] });
      fails('lists_missing', {}, { ...lists, communes: [] });
    });

    it('ships a new wilaya through its parent, with an origin in 59..69', async () => {
      const elKantara = COMMUNES.find((c) => c.wilaya_code === 61);
      if (!elKantara) throw new Error('no commune');
      const biskra = await loadLists(61);
      const result = adapter.prepare(
        input({
          wilayaCode: 61,
          originWilayaCode: 61,
          commune: { nameFr: elKantara.name_fr, nameAr: elKantara.name_ar },
        }),
        biskra,
      );
      if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
      expect(result.parcel.payload['to_wilaya_name']).toBe('Biskra');
      expect(result.parcel.payload['from_wilaya_name']).toBe('Biskra');
      expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
    });

    it('sends the name the list gives for that code', async () => {
      const everyWilaya = lists.wilayas.find((w) => w.code === WILAYA)?.name;
      const result = adapter.prepare(input(), lists);
      expect(result.ok && result.parcel.payload['to_wilaya_name']).toBe(everyWilaya);
    });

    it.each(['0560417403', '0550123456', '0770123456', '+213560417403', '٠٥٦٠٤١٧٤٠٣'])('accepts phone %s', (phone) => {
      const result = adapter.prepare(input({ phone }), lists);
      expect(result.ok && String(result.parcel.payload['contact_phone'])).toMatch(/^0\d{9}$/);
    });

    it.each(['0543123456', '0565123456', '0760123456', '021123456', ''])('refuses phone %s', (phone) => {
      fails('phone_invalid', { phone });
    });

    it.each([
      ['Amina', 'Amina', 'Amina'],
      ['أمينة بن علي', 'أمينة', 'بن علي'],
      ['  Amina   Ben   Ali ', 'Amina', 'Ben Ali'],
    ])('splits the name %s', (recipientName, firstname, familyname) => {
      const result = adapter.prepare(input({ recipientName }), lists);
      expect(result.ok && result.parcel.payload).toMatchObject({ firstname, familyname });
    });
  });

  describe('list rows from elsewhere', () => {
    const answering = (data: unknown[]): typeof fetch =>
      (async () => new Response(JSON.stringify({ has_more: false, total_data: data.length, data }))) as typeof fetch;

    it('a desk from another wilaya never reaches an order', async () => {
      const centers = [
        { center_id: 5001, name: 'Agence Batna', address: 'a', commune_name: 'Batna', wilaya_id: 5, wilaya_name: 'Batna' },
        { center_id: 16001, name: 'Agence Alger', address: 'b', commune_name: 'Hydra', wilaya_id: 16, wilaya_name: 'Alger' },
      ];
      const desks = await adapter.listStopDesks(16, GOOD, ctx({ fetch: answering(centers) }));
      if (!desks.ok) throw new Error(desks.cause);
      expect(desks.items.map((d) => d.id)).toEqual(['16001']);
      const lists: CourierLists = { wilayas: [{ code: 16, name: 'Alger', deliverable: true }], communes: [], stopDesks: desks.items };
      expect(adapter.prepare(input({ wilayaCode: 16, originWilayaCode: 16, deliveryType: 'stop_desk', stopDeskId: '5001' }), lists)).toMatchObject({
        ok: false,
        code: 'stop_desk_mismatch',
      });
    });

    it('a commune from another wilaya is dropped, and one naming no wilaya too', async () => {
      const rows = [
        { name: 'Batna', wilaya_id: 5 },
        { name: 'Hydra', wilaya_id: 16 },
        { name: 'Sans wilaya' },
      ];
      const communesFound = await adapter.listCommunes(16, GOOD, ctx({ fetch: answering(rows) }));
      if (!communesFound.ok) throw new Error(communesFound.cause);
      expect(communesFound.items.map((c) => c.name)).toEqual(['Hydra']);
    });
  });

  describe('labels', () => {
    it('refuses a row for another parcel', async () => {
      const other = (async () =>
        new Response(JSON.stringify({ data: [{ tracking: 'yal-OTHER', label: 'https://yalidine.app/x' }] }))) as typeof fetch;
      expect(await adapter.getLabel('yal-1', GOOD, { env: 'production', fetch: other })).toEqual({ kind: 'unavailable', cause: 'no_label' });
    });

    it('returns the stand-in waybill URL, with no token in it', async () => {
      const created = await adapter.createParcel(await prepared(), GOOD, ctx());
      if (created.kind !== 'accepted') throw new Error('not accepted');
      const label = await adapter.getLabel(created.tracking, GOOD, ctx());
      expect(label.kind).toBe('url');
      expect(JSON.stringify(label)).not.toContain('standin-token');
    });

    it('drops a javascript or off-list label', async () => {
      const body = (label: string) =>
        (async () => new Response(JSON.stringify({ data: [{ tracking: 'yal-1', label }] }))) as typeof fetch;
      // The tracking matches: only the label itself is at fault here.
      for (const label of ['javascript:alert(1)', 'https://evil.test/x']) {
        expect(await adapter.getLabel('yal-1', GOOD, ctx({ fetch: body(label) }))).toEqual({
          kind: 'unavailable',
          cause: 'no_label',
        });
      }
    });

    it('refuses an invalid tracking without calling out', async () => {
      const spy = vi.fn<typeof fetch>();
      expect((await adapter.getLabel('../x', GOOD, ctx({ fetch: spy }))).kind).toBe('unavailable');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('webhooks', () => {
    const SECRET = 'whsec-standin';
    const encode = (text: string) => new TextEncoder().encode(text);
    const sign = (body: Uint8Array) => createHmac('sha256', SECRET).update(body).digest('hex');
    const envelope = (events: unknown[], type = 'parcel_status_updated') => encode(JSON.stringify({ type, events }));
    const event = (id: string, tracking: string, status: unknown, occurred = '2026-01-02 10:00:00') => ({
      event_id: id,
      occurred_at: occurred,
      data: { tracking, status, reason: null },
    });

    it('verifies a valid signature and parses it', async () => {
      const rawBody = envelope([event('e1', 'yal-1', 'Livré')]);
      expect(await adapter.verifyWebhook({ rawBody, headers: { 'X-Yalidine-Signature': sign(rawBody) }, secret: SECRET })).toEqual({ ok: true });
      const parsed = adapter.parseWebhook(rawBody);
      expect(parsed).toMatchObject({ ok: true, badRows: 0 });
      if (parsed.ok) expect(parsed.events[0]).toMatchObject({ tracking: 'yal-1', status: 'delivered' });
    });

    it('verifies over bytes, including a body that is not valid UTF-8', async () => {
      const rawBody = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x7b, 0x7d]);
      expect(await adapter.verifyWebhook({ rawBody, headers: { 'x-yalidine-signature': sign(rawBody) }, secret: SECRET })).toEqual({ ok: true });
      expect(adapter.parseWebhook(rawBody)).toEqual({ ok: false, reason: 'malformed' });
    });

    it.each<[string, string | undefined, string]>([
      ['wrong signature', 'a'.repeat(64), 'bad_signature'],
      ['non-hex', 'z'.repeat(64), 'bad_signature'],
      ['wrong length', 'abc', 'bad_signature'],
      ['uppercase hex', 'A'.repeat(64), 'bad_signature'],
      ['missing header', undefined, 'missing_signature'],
    ])('%s fails with its reason', async (_name, signature, reason) => {
      const headers: Record<string, string> = signature === undefined ? {} : { 'x-yalidine-signature': signature };
      expect(await adapter.verifyWebhook({ rawBody: envelope([]), headers, secret: SECRET })).toEqual({ ok: false, reason });
    });

    it.each(['', undefined as unknown as string])('an empty secret (%j) fails closed', async (secret) => {
      const rawBody = envelope([]);
      const forged = createHmac('sha256', '').update(rawBody).digest('hex');
      expect(await adapter.verifyWebhook({ rawBody, headers: { 'x-yalidine-signature': forged }, secret })).toEqual({
        ok: false,
        reason: 'missing_secret',
      });
    });

    it('rejects truncated JSON', () => {
      expect(adapter.parseWebhook(encode('{"type":"parcel_stat'))).toEqual({ ok: false, reason: 'malformed' });
    });

    it('ignores other event types', () => {
      expect(adapter.parseWebhook(envelope([event('e1', 'yal-1', 'Livré')], 'other'))).toEqual({ ok: true, events: [], badRows: 0 });
    });

    it('keeps good rows beside a bad one', () => {
      const parsed = adapter.parseWebhook(envelope([event('e1', 'yal-1', 'Livré'), { event_id: 'e2' }, 'x', event('e3', '../x', 'Livré')]));
      expect(parsed).toMatchObject({ ok: true, badRows: 3 });
      if (parsed.ok) expect(parsed.events).toHaveLength(1);
    });

    it('caps the number of events', () => {
      const many = Array.from({ length: 501 }, (_, i) => event(`e${i}`, 'yal-1', 'Livré'));
      expect(adapter.parseWebhook(envelope(many))).toEqual({ ok: false, reason: 'too_many_events' });
    });

    it('a redelivery has the same key', () => {
      const once = adapter.parseWebhook(envelope([event('e1', 'yal-1', 'Livré')]));
      const twice = adapter.parseWebhook(envelope([event('e1', 'yal-1', 'Livré')]));
      expect(once.ok && twice.ok && once.events[0]?.eventKey === twice.events[0]?.eventKey).toBe(true);
    });

    it('an unparseable time falls back to the event id', () => {
      const parsed = adapter.parseWebhook(envelope([event('e1', 'yal-1', 'Livré', 'whenever')]));
      expect(parsed.ok && parsed.events[0]).toMatchObject({ occurredAt: null, eventKey: 'yal-1|Livré|ev:e1' });
    });

    it('an unknown status stays unknown', () => {
      const parsed = adapter.parseWebhook(envelope([event('e1', 'yal-1', 'Nouveau')]));
      expect(parsed.ok && parsed.events[0]?.status).toBe('unknown');
    });

    describe('handshake', () => {
      it('echoes a valid token as plain text', () => {
        expect(adapter.webhookHandshake({ crc_token: 'abc-123_x.y~z' })).toEqual({ body: 'abc-123_x.y~z', contentType: 'text/plain' });
      });

      it.each(['', 'x'.repeat(257), '<script>', 'a b', 'a"b'])('refuses %j', (crc_token) => {
        expect(adapter.webhookHandshake({ crc_token })).toBeNull();
      });

      it('refuses a missing token', () => {
        expect(adapter.webhookHandshake({})).toBeNull();
      });
    });

    it('verifies what the stand-in actually sends, and a duplicate is the same key', async () => {
      const received: Array<{ body: Buffer; signature: string | undefined }> = [];
      const hook = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          received.push({ body: Buffer.concat(chunks), signature: req.headers['x-yalidine-signature'] as string | undefined });
          res.end('ok');
        });
      });
      await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
      try {
        const port = (hook.address() as AddressInfo).port;
        await standin.scenario(courier, { webhookUrl: `http://127.0.0.1:${port}/hook`, webhookSecret: SECRET });
        const created = await adapter.createParcel(await prepared(), GOOD, ctx());
        if (created.kind !== 'accepted') throw new Error('not accepted');
        await standin.control(`${courier}/parcels/${created.tracking}/status`, { status: 'Livré', times: 2 });
        expect(received).toHaveLength(2);
        const keys = [];
        for (const { body, signature } of received) {
          const rawBody = new Uint8Array(body);
          expect(await adapter.verifyWebhook({ rawBody, headers: { 'x-yalidine-signature': signature ?? '' }, secret: SECRET })).toEqual({ ok: true });
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

  it('has the expected capabilities', () => {
    expect(adapter.capabilities).toMatchObject({
      verifyByReference: true,
      verifyAfterSeconds: 300,
      verifyWithinSeconds: null,
      needsValidation: false,
      webhook: 'hmac',
      sendPerMinute: 50,
    });
  });
});

describe('the stand-in holds couriers to the real rules', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'X-API-ID': GOOD.apiId, 'X-API-TOKEN': GOOD.apiToken }) =>
    fetch(`${standin.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  beforeEach(async () => {
    await standin.reset();
    await standin.scenario('yalidine', { quota: false });
  });

  it('requires an array body', async () => {
    expect((await post('/yalidine/v1/parcels/', {})).status).toBe(400);
  });

  it('requires the trailing slash', async () => {
    expect((await post('/yalidine/v1/parcels', [])).status).toBe(404);
  });

  it('requires auth headers', async () => {
    expect((await post('/yalidine/v1/parcels/', [], {})).status).toBe(401);
  });

  it('refuses our spelling of a commune', async () => {
    const response = await post('/yalidine/v1/parcels/', [
      {
        order_id: 'R1',
        from_wilaya_name: 'Alger',
        firstname: 'A',
        familyname: 'B',
        contact_phone: '0560417403',
        address: 'x',
        to_wilaya_name: wilayaName,
        to_commune_name: accented.name_fr,
        product_list: 'x',
        price: 100,
        do_insurance: false,
        declared_value: 100,
        length: 0,
        width: 0,
        height: 0,
        weight: 0,
        freeshipping: true,
        is_stopdesk: false,
        has_exchange: false,
      },
    ]);
    const body = (await response.json()) as Record<string, { success: boolean; message: string }>;
    expect(body['R1']).toMatchObject({ success: false, message: 'to_commune_name is not valid' });
  });

  it('adds its fee when freeshipping is false', async () => {
    const response = await post('/yalidine/v1/parcels/', [
      {
        order_id: 'R2',
        from_wilaya_name: 'Alger',
        firstname: 'A',
        familyname: 'B',
        contact_phone: '0560417403',
        address: 'x',
        to_wilaya_name: 'Oran',
        to_commune_name: 'Oran',
        product_list: 'x',
        price: 5600,
        do_insurance: false,
        declared_value: 5600,
        length: 0,
        width: 0,
        height: 0,
        weight: 0,
        freeshipping: false,
        is_stopdesk: false,
        has_exchange: false,
      },
    ]);
    expect(((await response.json()) as Record<string, { success: boolean }>)['R2']?.success).toBe(true);
    expect((await standin.state('yalidine')).parcels[0]?.['collected']).toBe(6200);
  });

  it('refuses an unknown filter', async () => {
    const response = await fetch(`${standin.url}/yalidine/v1/parcels/?nope=1`, {
      headers: { 'X-API-ID': GOOD.apiId, 'X-API-TOKEN': GOOD.apiToken },
    });
    expect(response.status).toBe(400);
  });

  it('enforces a per-second quota with Retry-After', async () => {
    await standin.scenario('yalidine', { quota: true });
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(`${standin.url}/yalidine/v1/wilayas/`, {
        headers: { 'X-API-ID': GOOD.apiId, 'X-API-TOKEN': GOOD.apiToken },
      });
      statuses.push(response.status);
      retryAfter ??= response.headers.get('retry-after');
    }
    expect(statuses).toContain(429);
    expect(retryAfter).not.toBeNull();
  });

  it('is not reachable on a non-loopback address', async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return;
    await expect(
      fetch(`http://${external.address}:${standin.port}/__control/yalidine/state`, { signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow();
  });
});

describe('dz-delivery fixtures replayed through the adapter (MIT, see fixtures/dz-delivery)', () => {
  type Native = Array<{ status: number; headers: Record<string, string>; body: unknown }>;
  const fixture = (path: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/dz-delivery/yalidine/${path}`, import.meta.url), 'utf8')) as Native;

  /** Answers each request with the next recorded response. */
  const replay = (responses: Native): typeof fetch => {
    let index = 0;
    return (async () => {
      const entry = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 });
    }) as typeof fetch;
  };

  const ctx = (fetcher: typeof fetch): CourierContext => ({ env: 'production', fetch: fetcher });
  const parcelFor = (reference: string): PreparedParcel => ({ courier: 'yalidine', reference, payload: { order_id: reference } });
  const lastOnly = (responses: Native): Native => responses.slice(-1);

  it('home-delivery create', async () => {
    const responses = fixture('createParcel/home-delivery.native.json');
    const reference = Object.keys(responses[responses.length - 1]?.body as object)[0] as string;
    const result = await yalidine.createParcel(parcelFor(reference), GOOD, ctx(replay(lastOnly(responses))));
    expect(result).toMatchObject({ kind: 'accepted', draft: false });
    if (result.kind === 'accepted') expect(result.labelUrl).toContain('yalidine.app');
  });

  it('rejected create', async () => {
    const responses = fixture('createParcel/rejected.native.json');
    const result = await yalidine.createParcel(parcelFor('ORDER-2002'), GOOD, ctx(replay(lastOnly(responses))));
    expect(result).toEqual({ kind: 'rejected', code: 'courier_refused', detail: 'stopdesk_id is not valid' });
  });

  it('track: basic and out for delivery are in transit', async () => {
    for (const [file, tracking] of [
      ['track/basic.native.json', 'yal-000TST'],
      ['track/out-for-delivery.native.json', 'yal-ABC123'],
    ] as const) {
      const result = await yalidine.fetchStatuses([tracking], GOOD, ctx(replay(fixture(file))));
      if (!result.ok) throw new Error(result.cause);
      expect(result.events[0]).toMatchObject({ tracking, status: 'in_transit' });
      expect(result.events[0]?.occurredAt).not.toBeNull();
    }
  });

  it('track: not found is absent, and a lookup says not_found', async () => {
    const responses = fixture('track/not-found.native.json');
    expect(await yalidine.fetchStatuses(['yal-NONE'], GOOD, ctx(replay(responses)))).toMatchObject({ ok: true, absent: ['yal-NONE'] });
    expect((await yalidine.findByReference('NONE', { attemptedAt: 1 }, GOOD, ctx(replay(responses)))).kind).toBe('not_found');
  });

  it('list: several pages are followed', async () => {
    const responses = fixture('listParcels/all-pages.native.json');
    const trackings = responses.flatMap((r) => ((r.body as { data: Array<{ tracking: string }> }).data ?? []).map((row) => row.tracking));
    const result = await yalidine.fetchStatuses(trackings, GOOD, ctx(replay(responses)));
    if (!result.ok) throw new Error(result.cause);
    expect(result.events.map((e) => e.tracking).sort()).toEqual([...new Set(trackings)].sort());
    expect(result.absent).toEqual([]);
  });

  it('list: duplicate order ids are not resolved to the first', async () => {
    const responses = fixture('listParcels/first-page.native.json');
    const result = await yalidine.findByReference('ORDER-1', { attemptedAt: 1 }, GOOD, ctx(replay(responses.map((r) => ({ ...r, body: { ...(r.body as object), has_more: false } })))));
    expect(result.kind).toBe('multiple');
  });
});
