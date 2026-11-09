// Stand-in for Maystro Delivery: the two hosts in use, under /maystro/orders-management and
// /maystro/backend. Shapes follow artifacts/delivery-research/maystro.md and dz-delivery's fixtures.
import { algeriaTimestamp, createQuota, loadGeo, sendJson, sendText, sleep } from './lib.mjs';

export const MAYSTRO_TOKEN = 'standin-token';

// As in the official sample, these wilayas are not served.
const UNSERVED = new Set([11, 33, 37, 50, 52, 53, 54, 56]);
const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;

const DEFAULT_SCENARIO = {
  create: 'ok',
  read: 'ok',
  label: 'ok',
  wilayaShape: 'objects',
  down: false,
  slowMs: 0,
  lateMs: 500,
  quota: false,
};

const PDF = Buffer.from('%PDF-1.4\n% stand-in waybill\n%%EOF\n');

export function createMaystro() {
  const geo = loadGeo();
  const served = geo.wilayas.filter((w) => !UNSERVED.has(w.code));

  let state;
  const quota = createQuota({ perSecond: 1000, perMinute: 60 });

  function reset() {
    quota.reset();
    state = {
      scenario: { ...DEFAULT_SCENARIO },
      parcels: new Map(),
      recent: [],
      next: 1,
      createCount: 0,
      readCount: 0,
      lastCreateBody: null,
      lastUrl: null,
      lastLabelBody: null,
      lastAccept: null,
    };
  }
  reset();

  const newTracking = () => `1723169768${String(state.next++).padStart(5, '0')}`;
  const now = () => new Date(Date.now()).toISOString().replace('Z', '+00:00');

  function storeParcel(row) {
    const tracking = newTracking();
    state.parcels.set(tracking, {
      id: `0000000${state.next}-0000-4000-8000-000000000000`,
      display_id: tracking,
      updated_at: now(),
      status: 4,
      external_order_id: row.external_id,
      total_price: row.total_price,
      delivery_type: row.delivery_type,
      commune: row.commune,
    });
    state.recent.push({ name: row.customer_name, phone: row.customer_phone, at: Date.now() });
    return tracking;
  }

  function validateRow(row) {
    if (!row.customer_name || !/^0\d{9}$/.test(row.customer_phone ?? '')) return 30;
    if (!row.destination_text) return 20;
    const wilaya = served.find((w) => w.name === row.wilaya);
    if (!wilaya) return 40;
    if (!Number.isInteger(row.commune) || !geo.communes.some((c) => c.id === row.commune && c.wilayaCode === wilaya.code)) return 40;
    if (!Array.isArray(row.details) || row.details.length === 0) return 50;
    if (!Number.isInteger(row.total_price) || row.total_price < 0) return 10;
    if (row.delivery_type !== 1 && row.delivery_type !== 2) return 45;
    return null;
  }

  const failure = (row, errors) => ({ id: null, external_id: row?.external_id ?? null, tracking: null, success: false, delivery_price: null, errors });

  async function handleCreate(req, res, rawBody) {
    let rows;
    try {
      rows = JSON.parse(rawBody);
    } catch {
      return sendJson(res, 400, { detail: 'Invalid JSON' });
    }
    state.lastCreateBody = rows;
    if (!Array.isArray(rows)) return sendJson(res, 400, { detail: 'Expected a list' });
    const row = rows[0] ?? {};
    const scenario = state.scenario.create;
    const valid = () => validateRow(row) === null;
    const code = /^code:(\d+)$/.exec(scenario);
    const objectCode = /^code-object:(\d+)$/.exec(scenario);

    if (code) return sendJson(res, 200, [failure(row, [Number(code[1])])]);
    if (objectCode) return sendJson(res, 200, [failure(row, [{ code: Number(objectCode[1]), message: `Erreur ${objectCode[1]}` }])]);
    switch (scenario) {
      case 'non-integer':
        return sendJson(res, 200, [failure(row, ['x'])]);
      case 'no-errors':
        return sendJson(res, 200, [failure(row, [])]);
      case 'two-rows':
        return sendJson(res, 200, [failure(row, [40]), failure(row, [40])]);
      case 'other-external':
        return sendJson(res, 200, [{ id: 'x', external_id: 'someone-else', tracking: '172316976899999', success: true, errors: [] }]);
      case 'tracking-number':
        return sendJson(res, 200, [{ id: 'x', external_id: row.external_id, tracking: 172316976899999, success: true, errors: [] }]);
      case 'tracking-null':
        return sendJson(res, 200, [{ id: 'x', external_id: row.external_id, tracking: null, success: true, errors: [] }]);
      case 'create-then-hang':
        if (valid()) storeParcel(row);
        return undefined;
      case 'headers-then-stall':
        if (valid()) storeParcel(row);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[');
        return undefined;
      case 'hang-no-create':
        return undefined;
      case 'create-late':
        await sleep(state.scenario.lateMs);
        if (valid()) storeParcel(row);
        return undefined;
      case '500-no-create':
        return sendJson(res, 500, { detail: 'Server Error' });
      case '500-after-create':
        if (valid()) storeParcel(row);
        return sendJson(res, 500, { detail: 'Server Error' });
      case 'redirect':
        res.writeHead(302, { Location: 'https://orders-management.maystro-delivery.com/' });
        return res.end();
      case 'echo-token':
        return sendJson(res, 400, { detail: `bad token ${req.headers.authorization}` });
      case 'bad-json':
        return sendText(res, 200, '[{"oops', 'application/json');
      case 'html':
        return sendText(res, 200, '<html></html>', 'text/html');
      default:
        break;
    }
    if (/^\d{3}$/.test(scenario)) return sendJson(res, Number(scenario), { detail: 'scenario', status_code: Number(scenario) });

    const problem = validateRow(row);
    if (problem !== null) return sendJson(res, 200, [failure(row, [problem])]);
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    if (state.recent.some((r) => r.at >= cutoff && r.name === row.customer_name && r.phone === row.customer_phone)) {
      return sendJson(res, 200, [failure(row, [{ code: 55, message: 'Duplicated order' }])]);
    }
    const tracking = storeParcel(row);
    return sendJson(res, 200, [{ id: 'x', external_id: row.external_id, tracking, success: true, delivery_price: 400, errors: [] }]);
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
        sendJson(res, 401, { detail: 'Token non valide.', status_code: 401 });
        return true;
      case '429':
        sendJson(res, 429, { detail: 'Too many' }, { 'Retry-After': '9' });
        return true;
      case '503':
        sendJson(res, 503, { detail: 'Unavailable' });
        return true;
      case '503-once':
        if (state.read503Sent) return false;
        state.read503Sent = true;
        sendJson(res, 503, { detail: 'Unavailable' });
        return true;
      case 'down':
        req.socket.destroy();
        return true;
      default:
        return false;
    }
  }

  function handleOrders(res, url) {
    const displayId = url.searchParams.get('display_id');
    if (displayId === null) {
      return sendJson(res, 200, { list: { count: state.parcels.size, next: null, previous: null, results: [...state.parcels.values()].slice(0, 20) } });
    }
    if (state.scenario.read === 'two-rows') {
      const row = state.parcels.get(displayId) ?? { display_id: displayId, status: 41 };
      return sendJson(res, 200, { list: { count: 2, next: null, previous: null, results: [row, row] } });
    }
    const parcel = state.parcels.get(displayId);
    return sendJson(res, 200, { list: { count: parcel ? 1 : 0, next: null, previous: null, results: parcel ? [parcel] : [] } });
  }

  async function handle(req, res, url, rest, rawBody) {
    const scenario = state.scenario;
    state.lastUrl = url.pathname + url.search;
    const isCreate = req.method === 'POST' && rest === '/orders-management/api/orders/';
    if (isCreate) state.createCount += 1;
    else state.readCount += 1;

    if (scenario.down) {
      req.socket.destroy();
      return undefined;
    }
    if (scenario.slowMs > 0) await sleep(scenario.slowMs);

    if (req.headers.authorization !== `Token ${MAYSTRO_TOKEN}`) {
      return sendJson(res, 401, { detail: 'Token non valide.', status_code: 401 });
    }
    if (scenario.quota) {
      const wait = quota.take();
      if (wait !== null) return sendJson(res, 429, { detail: 'Too many' }, { 'Retry-After': String(wait) });
    }

    if (isCreate) return handleCreate(req, res, rawBody);

    if (rest === '/backend/api/delivery/starter/starter_bordureau/' && req.method === 'POST') {
      state.lastLabelBody = JSON.parse(rawBody);
      state.lastAccept = req.headers.accept ?? null;
      if ((req.headers.accept ?? '').includes('application/pdf')) return sendJson(res, 406, { detail: 'Not acceptable' });
      if (scenario.label === 'not-pdf') return sendText(res, 200, '<html></html>', 'text/html');
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(PDF);
    }

    if (readFailure(req, res)) return undefined;
    if (req.method !== 'GET') return sendJson(res, 404, { detail: 'Not found' });

    if (rest === '/orders-management/api/base/wilayas/') {
      if (scenario.wilayaShape === 'tuples') return sendJson(res, 200, served.map((w) => [w.code, w.name]));
      return sendJson(res, 200, served.map((w) => ({ display_id: w.code, code: w.code, name_lt: w.name, name_ar: w.name, country: 1 })));
    }
    if (rest === '/orders-management/api/base/communes/') {
      const wilaya = Number(url.searchParams.get('wilaya'));
      return sendJson(res, 200, geo.communes.filter((c) => c.wilayaCode === wilaya).map((c) => ({ id: c.id, wilaya: c.wilayaCode, name: c.name, postcode: 0, zone: 1 })));
    }
    if (rest === '/backend/api/stores/orders/') return handleOrders(res, url);
    return sendJson(res, 404, { detail: 'Not found' });
  }

  async function control(method, parts, body, res) {
    const [resource, tracking, action] = parts;
    if (method === 'GET' && resource === 'state') {
      return sendJson(res, 200, {
        createCount: state.createCount,
        readCount: state.readCount,
        scenario: state.scenario,
        lastCreateBody: state.lastCreateBody,
        lastLabelBody: state.lastLabelBody,
        lastAccept: state.lastAccept,
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
        const id = row.tracking ?? newTracking();
        state.parcels.set(id, { id: 'seeded', display_id: id, updated_at: row.updated_at ?? now(), status: row.status ?? 4, alert_reason: row.alert_reason ?? null, abort_reason: row.abort_reason ?? null });
        trackings.push(id);
      }
      return sendJson(res, 200, { trackings });
    }
    if (method === 'POST' && resource === 'parcels' && action === 'status') {
      const parcel = state.parcels.get(tracking);
      if (!parcel) return sendJson(res, 404, { error: 'unknown tracking' });
      if (body.status !== undefined) parcel.status = body.status;
      parcel.updated_at = body.updated_at ?? algeriaTimestamp();
      return sendJson(res, 200, { tracking });
    }
    return sendJson(res, 404, { error: 'unknown control' });
  }

  return { handle, control, reset };
}
