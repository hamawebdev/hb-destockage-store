// Stand-in for ZR Express. Paths and shapes follow the official docs at docs.zrexpress.app, as read
// in artifacts/delivery-research/zr-express.md and artifacts/CARR-0/addendum-zr-express.md.
import { createHmac } from 'node:crypto';
import { createQuota, isLoopbackUrl, loadGeo, sendJson, sendText, sleep } from './lib.mjs';

export const ZR_CREDENTIALS = { apiKey: 'standin-key', tenantId: 'standin-tenant' };
export const ZR_WEBHOOK_SECRET = `whsec_${Buffer.from('standin-zr-secret').toString('base64')}`;

const uuid = (kind, n) => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const STATE_NAMES = [
  'commande_recue',
  'commande_confirmee',
  'pret_a_expedier',
  'dispatch',
  'sortie_en_livraison',
  'livre',
  'recupere_par_fournisseur',
];

const workflow = (prefix, id, name, isDefault, extra = []) => ({
  id,
  name,
  isDefault,
  states: [...STATE_NAMES, ...extra].map((state, index) => ({ id: uuid(prefix, index + 1), name: state, description: state })),
});

const WORKFLOWS = [workflow('a', uuid('e', 1), 'Standard', true), workflow('b', uuid('e', 2), 'Second', false, ['etat_maison'])];

const DEFAULT_SCENARIO = {
  create: 'ok',
  validate: 'auto',
  read: 'ok',
  down: false,
  slowMs: 0,
  lateMs: 500,
  quota: true,
  webhookUrl: null,
  noHomeCommunes: [],
  noPickupCommunes: [],
  workflows: null,
  pollFilter: 'honoured',
};

const FAILURE_BY_SCENARIO = {
  reject: ['General.Validation', 'Validation failed'],
  'db-error': ['DatabaseError', 'Failed to persist'],
  'unexpected-error': ['UnexpectedError', 'Unexpected'],
  'unlisted-error': ['ParcelErrors.Whatever', 'New code'],
};

export function createZrExpress() {
  const geo = loadGeo();
  const wilayaId = (code) => uuid('c', code);
  const communeId = (id) => uuid('d', id);
  const desks = new Set(geo.wilayas.flatMap((w) => geo.communes.filter((c) => c.wilayaCode === w.code).slice(0, 2).map((c) => c.id)));
  const hubs = geo.wilayas.flatMap((w) =>
    geo.communes
      .filter((c) => c.wilayaCode === w.code && desks.has(c.id))
      .map((c, index) => ({
        id: uuid('f', w.code * 1000 + index),
        name: `Bureau ${c.name}`,
        type: 'stopdesk',
        isPickupPoint: true,
        address: {
          street: `${index + 1} rue de la Poste`,
          city: w.name,
          cityTerritoryId: wilayaId(w.code),
          // Half the hubs have no commune tag, as many real ones do.
          ...(index === 0 ? { district: c.name, districtTerritoryId: communeId(c.id) } : {}),
        },
      })),
  );

  let state;
  const quota = createQuota({ perSecond: 1000, perMinute: 60 });

  function reset() {
    quota.reset();
    state = {
      scenario: { ...DEFAULT_SCENARIO },
      parcels: new Map(),
      externalIds: new Set(),
      next: 1,
      createCount: 0,
      stateWrites: 0,
      readCount: 0,
      lastCreateBody: null,
      lastSearchBody: null,
      lastUrl: null,
      lastStateBody: null,
    };
  }
  reset();

  const workflows = () => state.scenario.workflows ?? WORKFLOWS;
  const stateByName = (name) =>
    workflows().flatMap((w) => w.states).find((s) => s.name === name) ?? { id: uuid('9', 1), name, description: name };

  function storeParcel(row) {
    const n = state.next++;
    const parcel = {
      id: uuid('1', n),
      trackingNumber: `16-STN${String(n).padStart(4, '0')}-ZR`,
      externalId: row.externalId,
      amount: row.amount,
      customer: row.customer,
      deliveryType: row.deliveryType,
      state: stateByName('commande_recue'),
      isReturn: false,
      lastStateUpdateAt: new Date().toISOString(),
    };
    state.parcels.set(parcel.trackingNumber, parcel);
    state.externalIds.add(row.externalId);
    return parcel;
  }

  function validateRow(row) {
    if (!row || typeof row !== 'object') return 'row';
    if (typeof row.externalId !== 'string' || row.externalId === '' || row.externalId.length > 100) return 'externalId';
    const name = row.customer?.name;
    if (typeof name !== 'string' || name.length < 2 || name.length > 100) return 'customer.name';
    if (!/^\+213\d{9}$/.test(row.customer?.phone?.number1 ?? '')) return 'customer.phone.number1';
    if (typeof row.description !== 'string' || row.description.length < 2 || row.description.length > 250) return 'description';
    if (typeof row.amount !== 'number' || row.amount < 0 || row.amount > 150000) return 'amount';
    if (!['home', 'pickup-point'].includes(row.deliveryType)) return 'deliveryType';
    if (row.deliveryType === 'pickup-point' && !hubs.some((h) => h.id === row.hubId)) return 'hubId';
    const wilaya = geo.wilayas.find((w) => wilayaId(w.code) === row.deliveryAddress?.cityTerritoryId);
    if (!wilaya) return 'cityTerritoryId';
    const commune = geo.communes.find((c) => communeId(c.id) === row.deliveryAddress?.districtTerritoryId);
    if (!commune || commune.wilayaCode !== wilaya.code) return 'districtTerritoryId';
    const products = row.orderedProducts;
    if (!Array.isArray(products) || products.length === 0) return 'orderedProducts';
    for (const p of products) {
      if (p.stockType !== 'none' || !p.productName || typeof p.unitPrice !== 'number' || !p.quantity) return 'orderedProducts';
    }
    return null;
  }

  const bulkBody = (successes, failures) => ({
    totalRequested: successes.length + failures.length,
    successCount: successes.length,
    failureCount: failures.length,
    successes,
    failures,
  });
  const failureRow = (externalId, code, message) => ({ index: 0, externalId, errorCode: code, errorMessage: message });
  const successRow = (parcel) => ({ index: 0, parcelId: parcel.id, trackingNumber: parcel.trackingNumber, externalId: parcel.externalId });

  async function handleBulk(res, rawBody) {
    const body = JSON.parse(rawBody);
    state.lastCreateBody = body;
    const row = Array.isArray(body.parcels) ? body.parcels[0] : undefined;
    const ref = row?.externalId;
    const scenario = state.scenario.create;
    const valid = () => validateRow(row) === null && !state.externalIds.has(ref);

    if (FAILURE_BY_SCENARIO[scenario]) {
      const [code, message] = FAILURE_BY_SCENARIO[scenario];
      return sendJson(res, 400, bulkBody([], [failureRow(ref, code, message)]));
    }
    switch (scenario) {
      case 'create-then-hang':
        if (valid()) storeParcel(row);
        return undefined;
      case 'headers-then-stall':
        if (valid()) storeParcel(row);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        return undefined;
      case 'hang-no-create':
        return undefined;
      case 'create-late':
        await sleep(state.scenario.lateMs);
        if (valid()) storeParcel(row);
        return undefined;
      case '500-no-create':
        return sendJson(res, 500, { title: 'Server error', status: 500 });
      case '500-after-create':
        if (valid()) storeParcel(row);
        return sendJson(res, 500, { title: 'Server error', status: 500 });
      case 'redirect':
        res.writeHead(302, { Location: 'https://api.zrexpress.app/' });
        return res.end();
      case 'echo-token':
        return sendJson(res, 422, { title: 'Bad', detail: `bad key ${res.req.headers['x-api-key']}` });
      case 'request-error':
        return sendJson(res, 400, { type: 'x', title: 'Bad Request', status: 400, detail: 'Malformed body', errors: [] });
      case 'bad-json':
        return sendText(res, 200, '{"oops', 'application/json');
      case 'html':
        return sendText(res, 200, '<html></html>', 'text/html');
      case 'zero':
        return sendJson(res, 200, bulkBody([], []));
      case 'other-ref':
        return sendJson(res, 200, { ...bulkBody([{ index: 0, parcelId: uuid('1', 9), trackingNumber: '16-OTHER-ZR', externalId: 'someone-else' }], []) });
      case 'both':
        return sendJson(res, 207, bulkBody([{ index: 0, parcelId: uuid('1', 9), trackingNumber: '16-BOTH-ZR', externalId: ref }], [failureRow(ref, 'General.Validation', 'x')]));
      case 'bad-tracking':
        return sendJson(res, 200, bulkBody([{ index: 0, parcelId: uuid('1', 9), trackingNumber: null, externalId: ref }], []));
      default:
        break;
    }
    if (/^\d{3}$/.test(scenario)) return sendJson(res, Number(scenario), { title: 'scenario', status: Number(scenario) });

    const problem = validateRow(row);
    if (problem) return sendJson(res, 400, bulkBody([], [failureRow(ref, 'General.Validation', `Invalid ${problem}`)]));
    if (state.externalIds.has(ref)) {
      return sendJson(res, 400, bulkBody([], [failureRow(ref, 'ParcelErrors.DuplicateExternalId', 'externalId already exists')]));
    }
    return sendJson(res, 200, bulkBody([successRow(storeParcel(row))], []));
  }

  function readFailure(req, res) {
    switch (state.scenario.read) {
      case 'html':
        sendText(res, 200, '<html></html>', 'text/html');
        return true;
      case 'bad-json':
        sendText(res, 200, '{"oops', 'application/json');
        return true;
      case '401':
        sendJson(res, 401, { title: 'Unauthorized', status: 401 });
        return true;
      case '429':
        sendJson(res, 429, { title: 'Too many' }, { 'Retry-After': '9' });
        return true;
      case '503':
        sendJson(res, 503, { title: 'Unavailable', status: 503 });
        return true;
      case 'down':
        req.socket.destroy();
        return true;
      default:
        return false;
    }
  }

  function matches(row, filter) {
    const value = filter.field.split('.').reduce((o, key) => o?.[key], row);
    return value === filter.value;
  }

  function filtered(items, advanced) {
    if (!advanced) return items;
    return items.filter((row) => {
      const test = (f) => matches(row, f);
      return advanced.logic === 'or' ? advanced.filters.some(test) : advanced.filters.every(test);
    });
  }

  function paged(body, items) {
    const pageSize = Math.min(body.pageSize ?? 50, 1000);
    const pageNumber = body.pageNumber ?? 1;
    const data = items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    return {
      items: data,
      pageNumber,
      pageSize,
      totalCount: items.length,
      totalPages: Math.ceil(items.length / pageSize),
      hasPrevious: pageNumber > 1,
      hasNext: pageNumber * pageSize < items.length,
    };
  }

  const publicParcel = ({ customer: _c, ...parcel }) => parcel;

  function territories() {
    const noHome = state.scenario.noHomeCommunes;
    const noPickup = state.scenario.noPickupCommunes;
    return [
      ...geo.wilayas.map((w) => ({
        id: wilayaId(w.code),
        code: w.code,
        name: w.name,
        level: 'wilaya',
        parentId: null,
        delivery: { hasHomeDelivery: true, hasPickupPoint: true },
      })),
      ...geo.communes.map((c) => ({
        id: communeId(c.id),
        code: c.id,
        name: c.name,
        level: 'commune',
        parentId: wilayaId(c.wilayaCode),
        delivery: {
          hasHomeDelivery: !noHome.includes(c.name),
          hasPickupPoint: desks.has(c.id) && !noPickup.includes(c.name),
        },
      })),
    ];
  }

  async function handleStateChange(res, parcelId, rawBody) {
    state.stateWrites += 1;
    const body = JSON.parse(rawBody);
    state.lastStateBody = body;
    if (state.scenario.validate === 'hang') return undefined;
    if (state.scenario.validate === '500') return sendJson(res, 500, { title: 'Server error' });
    const parcel = [...state.parcels.values()].find((p) => p.id === parcelId);
    const target = workflows().flatMap((w) => w.states).find((s) => s.id === body.newStateId);
    if (!parcel || !target) return sendJson(res, 404, { title: 'ParcelStateErrors.NotFound', status: 404 });
    parcel.state = target;
    parcel.lastStateUpdateAt = new Date().toISOString();
    return sendJson(res, 200, {
      parcelId,
      newStateId: target.id,
      newStateName: state.scenario.validate === 'other-name' ? 'autre_etat' : target.name,
      trackingNumber: parcel.trackingNumber,
    });
  }

  async function emitWebhook(parcel, eventType, options = {}) {
    const url = state.scenario.webhookUrl;
    if (!url || !isLoopbackUrl(url)) return { sent: 0, statuses: [] };
    const body = JSON.stringify({
      eventType,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      data: {
        trackingNumber: parcel.trackingNumber,
        state: parcel.state,
        isReturn: parcel.isReturn,
        lastStateUpdateAt: parcel.lastStateUpdateAt,
        ...(options.situation ? { situation: { name: options.situation } } : {}),
      },
    });
    const id = options.id ?? `msg_${parcel.trackingNumber}_${parcel.lastStateUpdateAt}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(ZR_WEBHOOK_SECRET.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    const statuses = [];
    for (let i = 0; i < (options.times ?? 1); i += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
        });
        statuses.push(response.status);
      } catch {
        statuses.push(0);
      }
    }
    return { sent: statuses.length, statuses };
  }

  async function handle(req, res, url, rest, rawBody) {
    const scenario = state.scenario;
    state.lastUrl = url.pathname + url.search;
    const isCreate = req.method === 'POST' && rest === '/api/v1/parcels/bulk';
    if (isCreate) state.createCount += 1;
    else state.readCount += 1;

    if (scenario.down) {
      req.socket.destroy();
      return undefined;
    }
    if (scenario.slowMs > 0) await sleep(scenario.slowMs);

    const labelPage = /^\/label\/([\w-]+)$/.exec(rest);
    if (labelPage && req.method === 'GET') {
      return sendText(res, 200, `<!doctype html><title>Bordereau</title><h1>Bordereau ${labelPage[1]}</h1>`, 'text/html');
    }

    if (req.headers['x-api-key'] !== ZR_CREDENTIALS.apiKey || req.headers['x-tenant'] !== ZR_CREDENTIALS.tenantId) {
      return sendJson(res, 401, { title: 'Unauthorized', status: 401 });
    }
    if (scenario.quota) {
      const wait = quota.take();
      if (wait !== null) return sendJson(res, 429, { title: 'Bulk operation rate limit exceeded' }, { 'Retry-After': String(wait) });
    }

    if (isCreate) return handleBulk(res, rawBody);

    const stateChange = /^\/api\/v1\/parcels\/([\w-]+)\/state$/.exec(rest);
    if (stateChange && req.method === 'POST') return handleStateChange(res, stateChange[1], rawBody);

    if (readFailure(req, res)) return undefined;
    const body = rawBody ? JSON.parse(rawBody) : {};

    if (rest === '/api/v1/parcels/search' && req.method === 'POST') {
      state.lastSearchBody = body;
      let items = [...state.parcels.values()].map(publicParcel);
      if (scenario.read === 'none-exact') return sendJson(res, 200, paged(body, items.slice(0, 1).map((p) => ({ ...p, externalId: 'near-miss' }))));
      if (scenario.read === 'no-items') return sendJson(res, 200, { totalCount: 0 });
      if (scenario.read === 'no-total') return sendJson(res, 200, { items: [] });
      if (scenario.pollFilter === 'ignored') return sendJson(res, 200, paged(body, []));
      items = filtered(items, body.advancedFilter);
      return sendJson(res, 200, paged(body, items));
    }
    if (rest === '/api/v1/territories/search' && req.method === 'POST') {
      if (scenario.read === 'endless') return sendJson(res, 200, { ...paged({ ...body, pageNumber: 1 }, territories()), hasNext: true });
      return sendJson(res, 200, paged(body, filtered(territories(), body.advancedFilter)));
    }
    if (rest === '/api/v1/hubs/search' && req.method === 'POST') {
      return sendJson(res, 200, paged(body, filtered(hubs, body.advancedFilter)));
    }
    if (rest === '/api/v1/workflows/search' && req.method === 'POST') {
      if (scenario.read === 'workflows-down') return sendJson(res, 503, { title: 'Unavailable' });
      return sendJson(res, 200, paged(body, workflows()));
    }
    if (rest === '/api/v1/parcels/labels/individual' && req.method === 'POST') {
      const tracking = body.trackingNumbers?.[0];
      if (!state.parcels.has(tracking)) {
        return sendJson(res, 200, { parcelLabelFiles: [], failedTrackingNumbers: [tracking] });
      }
      return sendJson(res, 200, {
        parcelLabelFiles: [{ trackingNumber: tracking, fileUrl: `http://${req.headers.host}/zr-express/label/${tracking}` }],
        failedTrackingNumbers: [],
      });
    }
    const single = /^\/api\/v1\/parcels\/([\w-]+)$/.exec(rest);
    if (single && req.method === 'GET') {
      const parcel = state.parcels.get(single[1]);
      if (!parcel) return sendJson(res, 404, { title: 'ParcelErrors.NotFound', status: 404 });
      return sendJson(res, 200, publicParcel(parcel));
    }
    return sendJson(res, 404, { title: 'Not found', status: 404 });
  }

  async function control(method, parts, body, res) {
    const [resource, tracking, action] = parts;
    if (method === 'GET' && resource === 'state') {
      return sendJson(res, 200, {
        createCount: state.createCount,
        stateWrites: state.stateWrites,
        readCount: state.readCount,
        scenario: state.scenario,
        lastCreateBody: state.lastCreateBody,
        lastSearchBody: state.lastSearchBody,
        lastStateBody: state.lastStateBody,
        lastUrl: state.lastUrl,
        parcels: [...state.parcels.values()],
      });
    }
    if (method === 'POST' && resource === 'scenario') {
      state.scenario = { ...state.scenario, ...body };
      return sendJson(res, 200, { scenario: state.scenario });
    }
    if (method === 'POST' && resource === 'seed') {
      const trackings = [];
      for (const row of body.parcels ?? []) {
        const n = state.next++;
        const tracking = row.tracking ?? `16-SEED${String(n).padStart(4, '0')}-ZR`;
        state.parcels.set(tracking, {
          id: uuid('1', n),
          trackingNumber: tracking,
          externalId: row.externalId ?? null,
          state: stateByName(row.state ?? 'commande_recue'),
          isReturn: row.isReturn ?? false,
          lastStateUpdateAt: row.lastStateUpdateAt ?? new Date().toISOString(),
          ...(row.situation ? { situation: { name: row.situation } } : {}),
        });
        trackings.push(tracking);
      }
      return sendJson(res, 200, { trackings });
    }
    if (method === 'POST' && resource === 'parcels' && action === 'status') {
      const parcel = state.parcels.get(tracking);
      if (!parcel) return sendJson(res, 404, { error: 'unknown tracking' });
      if (body.state !== undefined) {
        parcel.state = stateByName(body.state);
        parcel.lastStateUpdateAt = body.at ?? new Date().toISOString();
      }
      if (body.isReturn !== undefined) parcel.isReturn = body.isReturn;
      const webhook = await emitWebhook(parcel, body.eventType ?? 'parcel.state.updated', body);
      return sendJson(res, 200, { tracking, webhook });
    }
    return sendJson(res, 404, { error: 'unknown control' });
  }

  return { handle, control, reset };
}
