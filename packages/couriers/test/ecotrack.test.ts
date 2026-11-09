import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ecotrackAdapters } from '../src/ecotrack/adapter.ts';
import { ECOTRACK_ACTIVITY, ECOTRACK_LABELS, ECOTRACK_SLUGS } from '../src/ecotrack/statuses.ts';
import { getCourier, listCouriers } from '../src/registry.ts';
import { canEnable, foundDisposition, isResendSafe } from '../src/resend.ts';
import { mapStatus } from '../src/status.ts';
import type {
  CourierAdapter,
  CourierContext,
  CourierLists,
  LookupFound,
  ParcelInput,
  PreparedParcel,
} from '../src/types.ts';
import { startStandin, type Standin } from './helpers/standin.ts';

const GOOD = { apiToken: 'standin-token' };
const BAD = { apiToken: 'wrong' };

let standin: Standin;
beforeAll(async () => {
  standin = await startStandin();
});
afterAll(async () => {
  await standin.stop();
});

const tenantRows = readFileSync(new URL('./status-lists/ecotrack-tenants.md', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return { name: cells[1] as string, host: (cells[2] as string).replaceAll('`', ''), probe: cells[3] as string };
  });

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const adapterFor = (name: string) => {
  const adapter = getCourier(`ecotrack-${slug(name)}`);
  if (!adapter) throw new Error(`no adapter for ${name}`);
  return adapter;
};

describe('tenant registry', () => {
  it('has every tenant from the research table', () => {
    expect(tenantRows).toHaveLength(82);
    expect(ecotrackAdapters).toHaveLength(82);
    expect(new Set(listCouriers().map((a) => a.id)).size).toBe(listCouriers().length);
  });

  it('lists exactly the expected ids', () => {
    expect(listCouriers().map((a) => a.id)).toEqual([
      'yalidine',
      'guepex',
      ...tenantRows.map((row) => `ecotrack-${slug(row.name)}`),
      'zr-express',
      'noest',
      'maystro',
    ]);
  });

  it.each(tenantRows)('$name: confidence matches the probe ($probe)', (row) => {
    const adapter = adapterFor(row.name);
    expect(adapter.displayName).toBe(row.name);
    expect(adapter.confidence.statusList).toBe('official');
    if (row.probe === 'live') {
      expect(adapter.confidence.baseUrl).toBe('probed');
      expect(adapter.confidence.notes).not.toContain('tenant_url_unconfirmed');
    } else {
      expect(adapter.confidence.baseUrl).toBe('unconfirmed');
      expect(adapter.confidence.notes).toContain('tenant_url_unconfirmed');
    }
  });

  it('14 tenants are unconfirmed', () => {
    expect(ecotrackAdapters.filter((a) => a.confidence.baseUrl === 'unconfirmed')).toHaveLength(14);
  });

  it('an unconfirmed tenant needs a valid check before it can be enabled', () => {
    const unconfirmed = adapterFor('Atlas Express');
    expect(canEnable(unconfirmed, null)).toBe(false);
    expect(canEnable(unconfirmed, 'valid')).toBe(true);
    expect(canEnable(adapterFor('Anderson Delivery'), null)).toBe(true);
  });

  it.each(tenantRows)('$name goes to its own host in production, with no credential able to change it', async (row) => {
    const spy = vi.fn<typeof fetch>(async () => new Response('[]'));
    await adapterFor(row.name).listWilayas(
      { apiToken: 'x', host: 'evil.test', baseUrl: 'https://evil.test' },
      { env: 'production', standinUrl: 'http://127.0.0.1:1', fetch: spy },
    );
    expect(new URL(String(spy.mock.calls[0]?.[0])).origin).toBe(`https://${row.host}`);
  });

  it('every tenant is covered by the stand-in', async () => {
    await standin.reset();
    for (const row of tenantRows.slice(0, 3)) {
      const adapter = adapterFor(row.name);
      expect(await adapter.checkCredentials(GOOD, { env: 'test', standinUrl: standin.url })).toEqual({ kind: 'valid' });
    }
  });
});

describe.each(['Anderson Delivery', 'Atlas Express'])('%s', (name) => {
  const adapter: CourierAdapter = adapterFor(name);
  const courier = adapter.id;

  const ctx = (extra: Partial<CourierContext> = {}): CourierContext => ({
    env: 'test',
    standinUrl: standin.url,
    timeoutMs: 400,
    ...extra,
  });

  const communes = JSON.parse(readFileSync(new URL('../../../data/geo/communes.json', import.meta.url), 'utf8')) as Array<{
    wilaya_code: number;
    name_fr: string;
    name_ar: string;
  }>;
  const sample = communes.find((c) => c.wilaya_code <= 58 && /[éèïîâ]/.test(c.name_fr));
  if (!sample) throw new Error('needs an accented commune');
  const WILAYA = sample.wilaya_code;

  const input = (overrides: Partial<ParcelInput> = {}): ParcelInput => ({
    reference: 'HB-EC001',
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
  const validateCount = async () => ((await standin.state(courier)) as unknown as { validateCount: number }).validateCount;

  beforeEach(async () => {
    await standin.reset();
    await standin.scenario(courier, { quota: false });
  });

  describe('createParcel', () => {
    it('creates a draft, in the tenant spelling, with the total as the amount', async () => {
      const parcel = await prepared();
      const result = await adapter.createParcel(parcel, GOOD, ctx());
      expect(result).toMatchObject({ kind: 'accepted', draft: true });
      const state = await standin.state(courier);
      expect(state.createCount).toBe(1);
      const query = state.lastCreateBody as Record<string, string>;
      expect(query).toMatchObject({ montant: '5600', stock: '0', type: '1', stop_desk: '0', telephone: '0560417403', reference: 'HB-EC001' });
      expect(query['commune']).not.toBe(sample.name_fr);
    });

    it.each(['nested-data', 'nested-order'])('reads the tracking from %s', async (create) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create });
      expect(await adapter.createParcel(parcel, GOOD, ctx())).toMatchObject({ kind: 'accepted', draft: true });
    });

    it('a business refusal is rejected', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'reject' });
      expect(await adapter.createParcel(parcel, GOOD, ctx())).toEqual({
        kind: 'rejected',
        code: 'courier_refused',
        detail: 'Pas de livraison pour la wilaya sélectionnée',
      });
    });

    it('a field error is rejected with its message', async () => {
      const bad = { ...(await prepared()) };
      const payload = { ...bad.payload, commune: 'Nulle Part' };
      expect(await adapter.createParcel({ ...bad, payload }, GOOD, ctx())).toMatchObject({
        kind: 'rejected',
        code: 'bad_request',
        detail: 'Commune mal écrite, ou désactivée.',
      });
    });

    it('wrong credentials are refused with no forced scenario', async () => {
      expect(await adapter.createParcel(await prepared(), BAD, ctx())).toMatchObject({ kind: 'rejected', code: 'auth' });
    });

    it('a quota overrun is rejected with a delay', async () => {
      const parcel = await prepared();
      await standin.reset();
      await standin.scenario(courier, { quota: true });
      let limited;
      for (let i = 0; i < 60 && !limited; i += 1) {
        const result = await adapter.createParcel(parcel, GOOD, ctx());
        if (result.kind === 'rejected') limited = result;
      }
      expect(limited).toMatchObject({ kind: 'rejected', code: 'rate_limited' });
      expect(limited).toHaveProperty('retryAfterMs');
    });

    it.each(['408', '409', '425'])('HTTP %s is uncertain', async (create) => {
      const parcel = await prepared();
      await standin.scenario(courier, { create });
      expect((await adapter.createParcel(parcel, GOOD, ctx())).kind).toBe('uncertain');
    });

    it.each(['bad-json', 'html', 'tracking-null', 'tracking-empty', 'tracking-number', 'success-1', 'success-string', 'false-with-tracking', 'disagree', 'redirect'])(
      'a malformed answer (%s) is uncertain',
      async (create) => {
        const parcel = await prepared();
        await standin.scenario(courier, { create });
        expect((await adapter.createParcel(parcel, GOOD, ctx())).kind).toBe('uncertain');
        expect((await standin.state(courier)).createCount).toBe(1);
      },
    );

    it('never leaks a token the courier echoes', async () => {
      const parcel = await prepared();
      await standin.scenario(courier, { create: 'echo-token' });
      const result = await adapter.createParcel(parcel, GOOD, ctx());
      expect(result.kind).toBe('rejected');
      expect(JSON.stringify(result)).not.toContain('standin-token');
    });
  });

  describe('a create that may or may not have happened', () => {
    const attemptedAt = () => Date.now();
    const lookup = () => adapter.findByReference('HB-EC001', { attemptedAt: attemptedAt() }, GOOD, ctx({ timeoutMs: 2000 }));

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
      expect((await standin.state(courier)).createCount).toBe(1);
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
    const created = async () => {
      const result = await adapter.createParcel(await prepared(), GOOD, ctx());
      if (result.kind !== 'accepted') throw new Error('not accepted');
      return result.tracking;
    };
    const options = { askCollection: false };

    it('validates once and leaves createCount alone', async () => {
      const tracking = await created();
      expect(await adapter.validateParcel(tracking, options, GOOD, ctx())).toEqual({ kind: 'validated' });
      const state = await standin.state(courier);
      expect(state.createCount).toBe(1);
      expect((state.parcels[0] as { askCollection: string }).askCollection).toBe('0');
    });

    it('sends the caller’s pickup choice', async () => {
      const tracking = await created();
      await adapter.validateParcel(tracking, { askCollection: true }, GOOD, ctx());
      expect(((await standin.state(courier)).parcels[0] as { askCollection: string }).askCollection).toBe('1');
    });

    it('a repeat answers locked, which means it may already be shipped', async () => {
      const tracking = await created();
      await adapter.validateParcel(tracking, options, GOOD, ctx());
      expect(await adapter.validateParcel(tracking, options, GOOD, ctx())).toMatchObject({ kind: 'rejected', code: 'locked' });
      expect((await standin.state(courier)).createCount).toBe(1);
      expect(await validateCount()).toBe(2);
    });

    it('error 10001 is locked', async () => {
      const tracking = await created();
      await standin.scenario(courier, { validate: 'locked' });
      expect(await adapter.validateParcel(tracking, options, GOOD, ctx())).toMatchObject({ kind: 'rejected', code: 'locked' });
    });

    it('a hang is uncertain and is not retried', async () => {
      const tracking = await created();
      await standin.scenario(courier, { validate: 'hang' });
      expect(await adapter.validateParcel(tracking, options, GOOD, ctx({ timeoutMs: 100 }))).toEqual({ kind: 'uncertain', cause: 'timeout' });
      expect(await validateCount()).toBe(1);
    });

    it('a 500 is uncertain', async () => {
      const tracking = await created();
      await standin.scenario(courier, { validate: '500' });
      expect((await adapter.validateParcel(tracking, options, GOOD, ctx())).kind).toBe('uncertain');
    });

    it('refuses an invalid tracking without calling out', async () => {
      const spy = vi.fn<typeof fetch>();
      expect(await adapter.validateParcel('../x', options, GOOD, ctx({ fetch: spy }))).toMatchObject({ kind: 'rejected', code: 'bad_request' });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('findByReference scan', () => {
    const NOON = Date.UTC(2026, 0, 15, 11, 0, 0);
    const find = (reference: string, attemptedAt = NOON, extra: Partial<CourierContext> = {}) =>
      adapter.findByReference(reference, { attemptedAt }, GOOD, ctx({ timeoutMs: 2000, ...extra }));
    const filler = (count: number, created_at = '2026-01-15') =>
      Array.from({ length: count }, (_, i) => ({ reference: `OTHER-${i}`, created_at }));

    it('finds an order on page 3', async () => {
      await seed([...filler(85), { reference: 'HB-TARGET', created_at: '2026-01-15', status: 'en_hub' }]);
      expect(await find('HB-TARGET')).toMatchObject({ kind: 'found', status: 'in_transit', gone: false });
    });

    it('a complete scan with no match is not_found, stamped', async () => {
      await seed(filler(85));
      expect(await find('HB-NOPE', NOON, { now: () => 777 })).toEqual({ kind: 'not_found', checkedAt: 777 });
    });

    it('stops at the page cap as unavailable', async () => {
      await seed(filler(3));
      await standin.scenario(courier, { read: 'many-pages' });
      expect(await find('HB-NOPE')).toMatchObject({ kind: 'unavailable', cause: 'too_many_pages' });
    });

    it.each(['no-last-page', 'last-page-changes', 'rows-no-ref', 'html', 'bad-json', '401', '429', '503', 'down'])(
      '%s is unavailable, never not_found',
      async (read) => {
        await seed(filler(45));
        await standin.scenario(courier, { read });
        expect((await find('HB-NOPE')).kind).toBe('unavailable');
      },
    );

    it('a null reference is not a match', async () => {
      await seed([{ reference: null, created_at: '2026-01-15' }]);
      expect((await find('null')).kind).toBe('not_found');
    });

    it.each([
      ['23:30 Algeria, dated the next day', Date.UTC(2026, 0, 15, 22, 30), '2026-01-16', 'found'],
      ['00:30 Algeria, dated the previous day', Date.UTC(2026, 0, 14, 23, 30), '2026-01-14', 'found'],
      ['outside a day either side', Date.UTC(2026, 0, 15, 11, 0), '2026-01-10', 'not_found'],
    ])('%s', async (_label, attemptedAt, created_at, expected) => {
      await seed([{ reference: 'HB-EDGE', created_at }]);
      expect((await find('HB-EDGE', attemptedAt)).kind).toBe(expected);
    });

    it('needs the attempt time', async () => {
      expect(await adapter.findByReference('X', { attemptedAt: Number.NaN }, GOOD, ctx())).toMatchObject({
        kind: 'unavailable',
        cause: 'attempted_at_missing',
      });
    });

    it('two exact rows are multiple', async () => {
      await seed([{ reference: 'HB-DUP', created_at: '2026-01-15' }, { reference: 'HB-DUP', created_at: '2026-01-15' }]);
      const result = await find('HB-DUP');
      expect(result.kind).toBe('multiple');
    });

    it('annule is gone', async () => {
      await seed([{ reference: 'HB-CANCEL', created_at: '2026-01-15', status: 'annule' }]);
      const result = await find('HB-CANCEL');
      expect(result).toMatchObject({ kind: 'found', gone: true, status: 'exception' });
      expect(foundDisposition(result as LookupFound, adapter.capabilities)).toBe('person');
    });

    it.each([
      ['en_livraison', 'shipped'],
      ['livre_non_encaisse', 'shipped'],
      ['retour_recu', 'shipped'],
      ['retour_chez_livreur', 'shipped'],
      ['prete_a_expedier', 'draft'],
      ['en_ramassage', 'draft'],
      ['suspendu', 'person'],
      ['statut_invente', 'person'],
    ])('disposition of a found %s is %s', async (status, disposition) => {
      await seed([{ reference: 'HB-D', created_at: '2026-01-15', status }]);
      const result = await find('HB-D');
      if (result.kind !== 'found') throw new Error('not found');
      expect(foundDisposition(result, adapter.capabilities)).toBe(disposition);
    });

    it('a not_found past the upper bound is not safe', async () => {
      const attemptEndedAt = 1_000_000;
      const checkedAt = attemptEndedAt + 86_401_000;
      expect(isResendSafe({ kind: 'not_found', checkedAt }, attemptEndedAt, adapter.capabilities, null)).toBe(false);
    });
  });

  describe('fetchStatuses', () => {
    const remark = (date: string, time: string, reason: string) => ({ reason, details: '', station: 'S', driver: '', date, time, postponed_to: null });

    it('maps slugs, and reports absent and invalid trackings', async () => {
      const [a, b] = await seed([{ status: 'en_livraison' }, { status: 'retour_recu' }]);
      const result = await adapter.fetchStatuses([a as string, b as string, 'ECMISSING', 'a,b'], GOOD, ctx());
      if (!result.ok) throw new Error(result.cause);
      expect(result.events.find((e) => e.tracking === a)?.status).toBe('in_transit');
      expect(result.events.find((e) => e.tracking === b)?.status).toBe('returned');
      expect(result.absent).toEqual(['ECMISSING']);
      expect(result.invalid).toEqual(['a,b']);
    });

    it('an empty answer, encoded as [], is absent rather than an error', async () => {
      expect(await adapter.fetchStatuses(['ECMISSING'], GOOD, ctx())).toMatchObject({ ok: true, absent: ['ECMISSING'] });
    });

    it('sends the documented api_token, and the stand-in requires it', async () => {
      const [a] = await seed([{ status: 'en_hub' }]);
      expect((await adapter.fetchStatuses([a as string], GOOD, ctx())).ok).toBe(true);
      expect((await standin.state(courier)).lastUrl).toContain('api_token=standin-token');
      const bare = await fetch(`${standin.url}/${courier}/api/v1/get/orders/status?trackings=${a as string}&status=all`, {
        headers: { Authorization: 'Bearer standin-token' },
      });
      expect(bare.status).toBe(401);
      expect((await adapter.fetchStatuses([a as string], BAD, ctx())).ok).toBe(false);
    });

    it('never puts the token in a failure', async () => {
      await standin.scenario(courier, { read: '503' });
      expect(JSON.stringify(await adapter.fetchStatuses(['ECA'], GOOD, ctx()))).not.toContain('standin-token');
    });

    it('a new remark on the same status keeps the key', async () => {
      const [a] = await seed([{ status: 'en_preparation', activity: [remark('2025-07-16', '02:08:51', 'Client ne réponds pas')] }]);
      const poll = async () => {
        const result = await adapter.fetchStatuses([a as string], GOOD, ctx());
        if (!result.ok || !result.events[0]) throw new Error('no event');
        return result.events[0];
      };
      const first = await poll();
      expect(first.eventKey).toBe(`${a as string}|en_preparation|none`);
      await standin.control(`${courier}/parcels/${a as string}/status`, { activity: [remark('2025-07-16', '09:00:00', 'Écrire une remarque')] });
      const second = await poll();
      expect(second.eventKey).toBe(first.eventKey);
      expect(second.reason).toBe('Écrire une remarque');
    });

    it('takes the latest activity by time, not by position', async () => {
      const [a] = await seed([
        {
          status: 'en_hub',
          activity: [remark('2025-07-16', '10:00:00', 'Plus récent'), remark('2025-07-16', '08:00:00', 'Plus ancien')],
        },
      ]);
      const result = await adapter.fetchStatuses([a as string], GOOD, ctx());
      expect(result.ok && result.events[0]).toMatchObject({ reason: 'Plus récent', occurredAt: Date.UTC(2025, 6, 16, 9, 0, 0) });
    });

    it('an empty activity still reports the status', async () => {
      const [a] = await seed([{ status: 'encaisse_non_paye', activity: [] }]);
      const result = await adapter.fetchStatuses([a as string], GOOD, ctx());
      expect(result.ok && result.events[0]).toMatchObject({ status: 'delivered', occurredAt: null, reason: null });
    });

    it('an unlisted slug is unknown', async () => {
      const [a] = await seed([{ status: 'statut_invente' }]);
      const result = await adapter.fetchStatuses([a as string], GOOD, ctx());
      expect(result.ok && result.events[0]?.status).toBe('unknown');
    });

    it('fails with a delay on 429 and on a down courier', async () => {
      await standin.scenario(courier, { read: '429' });
      expect(await adapter.fetchStatuses(['ECA'], GOOD, ctx())).toMatchObject({ ok: false, retryAfterMs: 9000 });
      await standin.scenario(courier, { read: 'ok', down: true });
      expect((await adapter.fetchStatuses(['ECA'], GOOD, ctx())).ok).toBe(false);
    });

    it('keeps good rows beside a bad one, and ignores trackings it did not ask for', async () => {
      const body = { data: { ECA: { status: 'en_hub', activity: [] }, ECB: { activity: [] }, ECZ: { status: 'en_hub', activity: [] } } };
      const result = await adapter.fetchStatuses(['ECA', 'ECB'], GOOD, ctx({ fetch: async () => new Response(JSON.stringify(body)) }));
      expect(result).toMatchObject({ ok: true, badRows: 2, absent: ['ECB'] });
    });

    it('refuses a batch over 100', async () => {
      const many = Array.from({ length: 101 }, (_, i) => `EC${i}`);
      expect(await adapter.fetchStatuses(many, GOOD, ctx())).toMatchObject({ ok: false, cause: 'batch_too_large' });
    });
  });

  describe('checkCredentials', () => {
    it('good and wrong tokens', async () => {
      expect(await adapter.checkCredentials(GOOD, ctx())).toEqual({ kind: 'valid' });
      expect(await adapter.checkCredentials(BAD, ctx())).toEqual({ kind: 'invalid', detail: 'INVALID_TOKEN' });
    });

    it('TOKEN_NOT_ALLOWED is invalid', async () => {
      await standin.scenario(courier, { token: 'not-allowed' });
      expect(await adapter.checkCredentials(GOOD, ctx())).toEqual({ kind: 'invalid', detail: 'TOKEN_NOT_ALLOWED' });
    });

    it('an odd 200 is unavailable, never valid', async () => {
      await standin.scenario(courier, { token: 'odd' });
      expect((await adapter.checkCredentials(GOOD, ctx())).kind).toBe('unavailable');
    });

    it('a 404 is an unknown tenant, not a bad key', async () => {
      await standin.scenario(courier, { token: '404' });
      expect(await adapter.checkCredentials(GOOD, ctx())).toEqual({ kind: 'unavailable', cause: 'tenant_not_found' });
    });

    it.each([
      [{ read: '503' }, 'unavailable'],
      [{ read: '429' }, 'rate_limited'],
      [{ down: true }, 'unavailable'],
    ])('%j gives %s', async (scenario, kind) => {
      await standin.scenario(courier, scenario);
      expect((await adapter.checkCredentials(GOOD, ctx())).kind).toBe(kind);
    });

    it('reads the docs’ single-quoted body', async () => {
      const singleQuoted: typeof fetch = async () => new Response("{ 'success' : true, 'message' : 'VALID_TOKEN'}");
      expect(await adapter.checkCredentials(GOOD, ctx({ fetch: singleQuoted }))).toEqual({ kind: 'valid' });
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
      fails('address_required', { address: '  ' });
      fails('address_required', { address: 'x'.repeat(256) });
      fails('stop_desk_required', { deliveryType: 'stop_desk' });
      fails('stop_desk_mismatch', { deliveryType: 'stop_desk', stopDeskId: '999999' });
      fails('wilaya_unmapped', { wilayaCode: 70 });
      fails('wilaya_not_deliverable', {}, { ...lists, wilayas: lists.wilayas.filter((w) => w.code !== WILAYA) });
      fails('commune_unmapped', { commune: { nameFr: 'Nulle Part', nameAr: 'لا مكان' } });
      fails('amount_out_of_range', { codTotalDzd: 1.5 });
      fails('phone_invalid', { phone: '0543123456' });
      fails('recipient_required', { recipientName: ' ' });
      fails('lists_missing', {}, { wilayas: [], communes: [], stopDesks: [] });
    });

    it('needs no origin wilaya', () => {
      expect(adapter.prepare(input(), lists).ok).toBe(true);
    });

    it('ships a new wilaya through its parent code', async () => {
      const elKantara = communes.find((c) => c.wilaya_code === 61);
      if (!elKantara) throw new Error('no commune');
      const result = adapter.prepare(
        input({ wilayaCode: 61, commune: { nameFr: elKantara.name_fr, nameAr: elKantara.name_ar } }),
        await loadLists(61),
      );
      if (!result.ok) throw new Error(result.code);
      expect(result.parcel.payload['code_wilaya']).toBe('7');
      expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
    });

    it('stop desk: sends the commune and its postal code, with a fallback address', async () => {
      const desk = lists.stopDesks[0];
      if (!desk) throw new Error('no desk');
      const result = adapter.prepare(input({ deliveryType: 'stop_desk', stopDeskId: desk.id, address: undefined as never }), lists);
      if (!result.ok) throw new Error(result.code);
      expect(result.parcel.payload).toMatchObject({ commune: desk.communeName, code_postal: desk.id, stop_desk: '1', adresse: desk.address });
      expect((await adapter.createParcel(result.parcel, GOOD, ctx())).kind).toBe('accepted');
    });
  });

  describe('labels', () => {
    it('returns PDF bytes, with no token in the result', async () => {
      const created = await adapter.createParcel(await prepared(), GOOD, ctx());
      if (created.kind !== 'accepted') throw new Error('not accepted');
      const label = await adapter.getLabel(created.tracking, GOOD, ctx());
      if (label.kind !== 'pdf') throw new Error(label.kind);
      expect(new TextDecoder().decode(label.bytes.slice(0, 5))).toBe('%PDF-');
      expect(label.contentType).toBe('application/pdf');
    });

    it('a 200 that is not a PDF is an error', async () => {
      const created = await adapter.createParcel(await prepared(), GOOD, ctx());
      if (created.kind !== 'accepted') throw new Error('not accepted');
      await standin.scenario(courier, { label: 'not-pdf' });
      expect(await adapter.getLabel(created.tracking, GOOD, ctx())).toEqual({ kind: 'unavailable', cause: 'not_pdf' });
    });

    it('refuses an invalid tracking without calling out', async () => {
      const spy = vi.fn<typeof fetch>();
      expect((await adapter.getLabel('../x', GOOD, ctx({ fetch: spy }))).kind).toBe('unavailable');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('outbound guard and failure values', () => {
    it('refuses with no stand-in, on every network method', async () => {
      const spy = vi.fn<typeof fetch>();
      const local: CourierContext = { env: 'development', fetch: spy };
      const parcel = await prepared();
      expect(await adapter.createParcel(parcel, GOOD, local)).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
      expect(await adapter.validateParcel('ECA', { askCollection: false }, GOOD, local)).toMatchObject({ kind: 'rejected', code: 'guard_refused' });
      expect((await adapter.findByReference('X', { attemptedAt: 1 }, GOOD, local)).kind).toBe('unavailable');
      expect((await adapter.fetchStatuses(['ECA'], GOOD, local)).ok).toBe(false);
      expect((await adapter.checkCredentials(GOOD, local)).kind).toBe('unavailable');
      expect((await adapter.getLabel('ECA', GOOD, local)).kind).toBe('unavailable');
      expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      ['TypeError', new TypeError('fetch failed SECRET-T')],
      ['AbortError', new DOMException('aborted', 'AbortError')],
    ])('never throws when fetch rejects with %s', async (_name, error) => {
      const context = ctx({ fetch: (async () => { throw error; }) as typeof fetch });
      const secrets = { apiToken: 'SECRET-T' };
      const parcel = await prepared();
      const results = [
        await adapter.createParcel(parcel, secrets, context),
        await adapter.validateParcel('ECA', { askCollection: false }, secrets, context),
        await adapter.findByReference('X', { attemptedAt: 1 }, secrets, context),
        await adapter.fetchStatuses(['ECA'], secrets, context),
        await adapter.checkCredentials(secrets, context),
        await adapter.listCommunes(16, secrets, context),
        await adapter.listStopDesks(16, secrets, context),
        await adapter.listWilayas(secrets, context),
        await adapter.getLabel('ECA', secrets, context),
      ];
      expect(JSON.stringify(results)).not.toContain('SECRET');
    });

    it('a read is retried once on 503 and not on 429', async () => {
      await standin.scenario(courier, { read: '503-once' });
      expect((await adapter.findByReference('X', { attemptedAt: Date.now() }, GOOD, ctx())).kind).toBe('not_found');
      expect((await standin.state(courier)).readCount).toBe(2);
      await standin.reset();
      await standin.scenario(courier, { quota: false, read: '429' });
      await adapter.findByReference('X', { attemptedAt: Date.now() }, GOOD, ctx());
      expect((await standin.state(courier)).readCount).toBe(1);
    });

    it('a slow multi-page scan stops at its deadline', async () => {
      await seed(Array.from({ length: 85 }, (_, i) => ({ reference: `R${i}` })));
      await standin.scenario(courier, { slowMs: 80 });
      const result = await adapter.findByReference('X', { attemptedAt: Date.now() }, GOOD, ctx({ timeoutMs: 1000, deadlineMs: 120 }));
      expect(result.kind).toBe('unavailable');
    });
  });

  it('has no webhook', async () => {
    expect(adapter.capabilities.webhook).toBe('none');
    expect(adapter.webhookHandshake({ crc_token: 'x' })).toBeNull();
    expect((await adapter.verifyWebhook({ rawBody: new Uint8Array(), headers: {}, secret: 's' })).ok).toBe(false);
    expect(adapter.parseWebhook(new Uint8Array()).ok).toBe(false);
  });

  it('has the expected capabilities', () => {
    expect(adapter.capabilities).toMatchObject({
      verifyByReference: true,
      verifyAfterSeconds: 300,
      verifyWithinSeconds: 86_400,
      needsValidation: true,
      pollBatchSize: 100,
      needsOriginWilaya: false,
    });
  });
});

describe('fixtures replayed through the adapter', () => {
  type Native = Array<{ status: number; body: unknown }>;
  const adapter = adapterFor('Anderson Delivery');
  const fixture = (path: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/dz-delivery/ecotrack/${path}`, import.meta.url), 'utf8')) as Native;
  const docs = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ecotrack-docs/${name}`, import.meta.url), 'utf8')) as unknown;

  const answer = (entry: { status: number; body: unknown } | undefined): typeof fetch =>
    (async () => new Response(JSON.stringify(entry?.body), { status: entry?.status ?? 500 })) as typeof fetch;
  const ctx = (fetcher: typeof fetch): CourierContext => ({ env: 'production', fetch: fetcher });
  const parcel: PreparedParcel = { courier: adapter.id, reference: 'R', payload: { reference: 'R' } };
  const last = (file: string) => {
    const responses = fixture(file);
    return responses[responses.length - 1];
  };

  it.each([
    ['createParcel/home-delivery.native.json', 'ECTEST2510200001'],
    ['createParcel/nested-tracking.native.json', 'ECTEST2510200099'],
    ['createParcel/stop-desk.native.json', 'ECTEST2510200002'],
  ])('%s is accepted as a draft', async (file, tracking) => {
    expect(await adapter.createParcel(parcel, GOOD, ctx(answer(last(file))))).toEqual({ kind: 'accepted', tracking, draft: true });
  });

  it('a wilaya refusal is rejected with its message', async () => {
    expect(await adapter.createParcel(parcel, GOOD, ctx(answer(last('createParcel/no-delivery-wilaya.native.json'))))).toEqual({
      kind: 'rejected',
      code: 'courier_refused',
      detail: 'Pas de livraison pour la wilaya sélectionnée',
    });
  });

  it('a field error is rejected with its first message', async () => {
    expect(await adapter.createParcel(parcel, GOOD, ctx(answer(last('createParcel/validation-error.native.json'))))).toMatchObject({
      kind: 'rejected',
      code: 'bad_request',
      detail: 'Commune mal écrite, ou désactivée.',
    });
  });

  it('the validate response from auto-validate is validated', async () => {
    expect(await adapter.validateParcel('ECTEST2510200003', { askCollection: false }, GOOD, ctx(answer(last('createParcel/auto-validate.native.json'))))).toEqual({ kind: 'validated' });
  });

  it('index-keyed communes parse', async () => {
    const entry = fixture('getCommunes/index-keyed.native.json')[0];
    const result = await adapter.listCommunes(16, GOOD, ctx(answer(entry)));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.map((c) => c.name)).toContain('Bab Ezzouar');
    expect(result.items.find((c) => c.name === 'Bab Ezzouar')?.hasStopDesk).toBe(true);
  });

  it('stop desks come from communes with a desk, by postal code', async () => {
    const entries = fixture('getStopDesks/by-wilaya-name.native.json');
    const result = await adapter.listStopDesks(16, GOOD, ctx(answer(entries[1])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.map((d) => d.id)).toEqual(['1625', '1640']);
  });

  it('a desk from another wilaya in the answer never reaches an order', async () => {
    const entries = fixture('getStopDesks/by-wilaya-name.native.json');
    const desks = await adapter.listStopDesks(16, GOOD, ctx(answer(entries[1])));
    if (!desks.ok) throw new Error(desks.cause);
    const lists: CourierLists = {
      wilayas: [{ code: 16, name: 'Alger', deliverable: true }],
      communes: [],
      stopDesks: desks.items,
    };
    const order: ParcelInput = {
      reference: 'R-1',
      recipientName: 'Amina',
      phone: '0560417403',
      wilayaCode: 16,
      commune: { nameFr: 'x', nameAr: 'y' },
      deliveryType: 'stop_desk',
      stopDeskId: '501',
      codTotalDzd: 100,
      productLabel: 'x',
    };
    expect(adapter.prepare(order, lists)).toMatchObject({ ok: false, code: 'stop_desk_mismatch' });
  });

  it('communes from another wilaya are dropped', async () => {
    const result = await adapter.listCommunes(16, GOOD, ctx(answer(fixture('getCommunes/index-keyed.native.json')[0])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.map((c) => c.name)).not.toContain('Batna');
  });

  it('two exact rows are multiple even if one tracking is unusable, and junk is left out', async () => {
    const body = {
      current_page: 1,
      last_page: 1,
      data: [
        { reference: 'R', tracking: 'ECGOOD1', status: 'en_hub' },
        { reference: 'R', status: 'en_hub' },
      ],
    };
    const result = await adapter.findByReference('R', { attemptedAt: 1 }, GOOD, ctx(async () => new Response(JSON.stringify(body))));
    expect(result).toEqual({ kind: 'multiple', trackings: ['ECGOOD1'] });
  });

  it('wilayas parse', async () => {
    const result = await adapter.listWilayas(GOOD, ctx(answer(fixture('getWilayas/basic.native.json')[0])));
    if (!result.ok) throw new Error(result.cause);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((w) => w.deliverable)).toBe(true);
  });

  it('a rate-limited list carries its failure', async () => {
    expect((await adapter.listWilayas(GOOD, ctx(answer(fixture('getWilayas/rate-limited.native.json')[0])))).ok).toBe(false);
  });

  it('auth failure on a list is a failure', async () => {
    expect((await adapter.listWilayas(GOOD, ctx(answer(fixture('getWilayas/auth-failed.native.json')[0])))).ok).toBe(false);
  });

  it('dz-delivery statuses are in our tables, apart from a remark and its own edge cases', () => {
    const statuses = JSON.parse(readFileSync(new URL('./fixtures/dz-delivery/ecotrack/statuses.json', import.meta.url), 'utf8')) as Record<string, string>;
    const missing = Object.keys(statuses).filter((raw) => ![ECOTRACK_SLUGS, ECOTRACK_LABELS, ECOTRACK_ACTIVITY].some((t) => t.has(raw)));
    // A remark, a filter value, another courier's wording, and dz-delivery's made-up and empty cases.
    expect(missing.sort()).toEqual(['', 'SomethingNew', 'Sorti en livraison', 'all', 'notification_on_order'].sort());
    for (const raw of missing) expect(mapStatus(ECOTRACK_SLUGS, raw)).toBe('unknown');
  });

  it('activity statuses in the track fixture are all mapped', () => {
    const body = fixture('track/delivered.native.json')[0]?.body as { activity: Array<{ status: string }> };
    for (const { status } of body.activity) {
      if (status !== 'notification_on_order') expect(ECOTRACK_ACTIVITY.has(status)).toBe(true);
    }
  });

  it('the official polling example, including activity: []', async () => {
    const trackings = ['ECLWIT2505052286', 'ECLWIT2507162547', 'ECLWIT2505052287'];
    const result = await adapter.fetchStatuses(trackings, GOOD, ctx(async () => new Response(JSON.stringify(docs('orders-status.json')))));
    if (!result.ok) throw new Error(result.cause);
    expect(result.badRows).toBe(0);
    expect(result.events.find((e) => e.tracking === 'ECLWIT2505052286')).toMatchObject({
      status: 'in_transit',
      reason: 'Écrire une remarque',
      eventKey: 'ECLWIT2505052286|en_preparation|none',
    });
    expect(result.events.find((e) => e.tracking === 'ECLWIT2507162547')).toMatchObject({ status: 'in_transit' });
    expect(result.events.find((e) => e.tracking === 'ECLWIT2505052287')).toMatchObject({ status: 'delivered', occurredAt: null, reason: null });
  });

  it('the official list example: a null reference is not a match, the accented slug maps', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(docs('orders.json')));
    expect(await adapter.findByReference('REF123', { attemptedAt: 1 }, GOOD, ctx(fetcher))).toMatchObject({
      kind: 'found',
      tracking: 'ECG4SU2111175434',
      status: 'delivered',
    });
    expect((await adapter.findByReference('null', { attemptedAt: 1 }, GOOD, ctx(fetcher))).kind).toBe('not_found');
  });
});
