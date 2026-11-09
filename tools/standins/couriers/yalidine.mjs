// Stand-in for the Yalidine platform (Yalidine, Guepex). Paths and shapes follow
// artifacts/delivery-research/yalidine.md, which is itself third-party sourced.
import { createHmac } from 'node:crypto';
import {
  algeriaTimestamp,
  createQuota,
  isLoopbackUrl,
  loadGeo,
  sendJson,
  sendText,
  sleep,
} from './lib.mjs';

export const YALIDINE_CREDENTIALS = { apiId: 'standin-id', apiToken: 'standin-token' };

/** What the stand-in adds on top of `price` when `freeshipping` is false. */
export const STANDIN_FEE = 600;

const REQUIRED = [
  'order_id',
  'from_wilaya_name',
  'firstname',
  'familyname',
  'contact_phone',
  'address',
  'to_wilaya_name',
  'to_commune_name',
  'product_list',
  'price',
  'do_insurance',
  'declared_value',
  'length',
  'width',
  'height',
  'weight',
  'freeshipping',
  'is_stopdesk',
  'has_exchange',
];

const DEFAULT_SCENARIO = {
  create: 'ok',
  read: 'ok',
  down: false,
  slowMs: 0,
  lateMs: 500,
  quota: true,
  accountDisabled: false,
  webhookUrl: null,
  webhookSecret: null,
  undeliverableCommunes: [],
};

const FILTERS = new Set(['tracking', 'order_id', 'last_status', 'date_last_status', 'date_creation', 'order_by']);

export function createYalidineFamily({ id, trackingPrefix }) {
  const geo = loadGeo();
  const centers = geo.wilayas.flatMap((wilaya) =>
    geo.communes
      .filter((c) => c.wilayaCode === wilaya.code)
      .slice(0, 2)
      .map((commune, index) => ({
        center_id: wilaya.code * 1000 + index + 1,
        name: `Agence ${commune.name}`,
        address: `${index + 1} rue de la Gare, ${commune.name}`,
        gps: null,
        commune_id: commune.id,
        commune_name: commune.name,
        wilaya_id: wilaya.code,
        wilaya_name: wilaya.name,
      })),
  );
  const desksOf = new Set(centers.map((c) => c.commune_id));

  let state;
  const quota = createQuota({ perSecond: 5, perMinute: 50 });

  function reset() {
    quota.reset();
    state = {
      scenario: { ...DEFAULT_SCENARIO },
      parcels: new Map(),
      nextTracking: 1,
      createCount: 0,
      readCount: 0,
      read503Sent: false,
      lastCreateBody: null,
      lastUrl: null,
    };
  }
  reset();

  function newTracking() {
    const n = state.nextTracking++;
    return `${trackingPrefix}-${String(n).padStart(6, '0')}`;
  }

  function collected(row) {
    return row.freeshipping === true ? row.price : row.price + STANDIN_FEE;
  }

  function storeParcel(row, origin) {
    const tracking = newTracking();
    const now = algeriaTimestamp();
    const parcel = {
      tracking,
      order_id: row.order_id,
      firstname: `${String(row.firstname).slice(0, 1)}***`,
      familyname: `${String(row.familyname).slice(0, 1)}***`,
      contact_phone: '05******',
      address: '***',
      to_wilaya_name: row.to_wilaya_name,
      to_commune_name: row.to_commune_name,
      price: row.price,
      is_stopdesk: row.is_stopdesk ? 1 : 0,
      date_creation: now,
      date_last_status: now,
      last_status: 'En préparation',
      label: `${origin}/${id}/label/${tracking}`,
      import_id: state.nextTracking,
      collected: collected(row),
      history: [{ date_status: now, status: 'En préparation', reason: '' }],
    };
    state.parcels.set(tracking, parcel);
    return parcel;
  }

  function validateRow(row) {
    if (row === null || typeof row !== 'object') return 'invalid row';
    for (const field of REQUIRED) {
      if (row[field] === undefined || row[field] === null || row[field] === '') return `${field} is required`;
    }
    if (!/^0\d{9}(,0\d{9})*$/.test(row.contact_phone)) return 'contact_phone is not valid';
    if (typeof row.price !== 'number' || row.price < 0 || row.price > 150000) return 'price is not valid';
    if (!geo.wilayas.some((w) => w.name === row.from_wilaya_name)) return 'from_wilaya_name is not valid';
    const wilaya = geo.wilayas.find((w) => w.name === row.to_wilaya_name);
    if (!wilaya) return 'to_wilaya_name is not valid';
    const commune = geo.communes.find(
      (c) => c.wilayaCode === wilaya.code && c.name === row.to_commune_name,
    );
    if (!commune) return 'to_commune_name is not valid';
    if (state.scenario.undeliverableCommunes.includes(commune.name)) return 'to_commune_name is not deliverable';
    if (row.is_stopdesk === true) {
      const center = centers.find((c) => c.center_id === row.stopdesk_id);
      if (!center) return 'stopdesk_id is not valid';
      if (center.wilaya_name !== row.to_wilaya_name || center.commune_name !== row.to_commune_name) {
        return 'to_commune_name does not match the stop desk';
      }
    }
    return null;
  }

  function rowResult(row, parcel, message) {
    return parcel
      ? {
          success: true,
          order_id: row.order_id,
          tracking: parcel.tracking,
          import_id: parcel.import_id,
          label: parcel.label,
          labels: null,
          message: '',
        }
      : {
          success: false,
          order_id: row?.order_id ?? null,
          tracking: null,
          import_id: null,
          label: null,
          labels: null,
          message,
        };
  }

  async function handleCreate(req, res, rawBody, origin) {
    const scenario = state.scenario.create;
    let rows;
    try {
      rows = JSON.parse(rawBody);
    } catch {
      return sendJson(res, 400, { error: { code: 400, message: 'Invalid JSON' } });
    }
    state.lastCreateBody = rows;
    if (!Array.isArray(rows)) {
      return sendJson(res, 400, { error: { code: 400, message: 'The body must be an array' } });
    }
    const row = rows[0] ?? {};
    const ref = row.order_id;

    if (state.scenario.accountDisabled) {
      return sendJson(res, 401, {
        error: { code: 401, message: 'Your account is disabled and cannot create new parcels' },
      });
    }

    const makeOk = () => storeParcel(row, origin);
    switch (scenario) {
      case 'reject':
        return sendJson(res, 200, { [ref]: rowResult(row, null, 'stopdesk_id is not valid') });
      case 'create-then-hang':
        if (!validateRow(row)) makeOk();
        return undefined;
      case 'headers-then-stall':
        if (!validateRow(row)) makeOk();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        return undefined;
      case 'hang-no-create':
        return undefined;
      case 'create-late':
        await sleep(state.scenario.lateMs);
        if (!validateRow(row)) makeOk();
        return undefined;
      case '500-no-create':
        return sendJson(res, 500, { error: { code: 500, message: 'Internal Server Error' } });
      case '500-after-create':
        if (!validateRow(row)) makeOk();
        return sendJson(res, 500, { error: { code: 500, message: 'Internal Server Error' } });
      case 'redirect':
        res.writeHead(302, { Location: 'https://api.yalidine.app/v1/parcels/' });
        return res.end();
      case 'echo-token':
        return sendJson(res, 400, {
          error: { code: 400, message: `bad token ${req.headers['x-api-token']} for ${req.headers['x-api-id']}` },
        });
      case 'bad-json':
        return sendText(res, 200, '{"oops', 'application/json');
      case 'html':
        return sendText(res, 200, '<html><title>Just a moment</title></html>', 'text/html');
      case 'missing-ref':
        return sendJson(res, 200, { other: { success: true, order_id: 'other', tracking: 'yal-OTHER1' } });
      case 'tracking-null':
        return sendJson(res, 200, { [ref]: { success: true, order_id: ref, tracking: null } });
      case 'tracking-empty':
        return sendJson(res, 200, { [ref]: { success: true, order_id: ref, tracking: '' } });
      case 'tracking-number':
        return sendJson(res, 200, { [ref]: { success: true, order_id: ref, tracking: 12345 } });
      case 'success-1':
        return sendJson(res, 200, { [ref]: { success: 1, order_id: ref, tracking: 'yal-ONE001' } });
      case 'success-string':
        return sendJson(res, 200, { [ref]: { success: 'true', order_id: ref, tracking: 'yal-STR001' } });
      case 'false-with-tracking':
        return sendJson(res, 200, { [ref]: { success: false, order_id: ref, tracking: 'yal-FLS001', message: 'x' } });
      case 'two-rows':
        return sendJson(res, 200, {
          [ref]: { success: true, order_id: ref, tracking: 'yal-TWO001' },
          second: { success: true, order_id: 'second', tracking: 'yal-TWO002' },
        });
      default:
        break;
    }
    if (/^\d{3}$/.test(scenario)) {
      return sendJson(res, Number(scenario), { error: { code: Number(scenario), message: 'scenario' } });
    }

    const response = {};
    for (const each of rows) {
      const problem = validateRow(each);
      response[each?.order_id] = problem
        ? rowResult(each, null, problem)
        : rowResult(each, storeParcel(each, origin));
    }
    return sendJson(res, 200, response);
  }

  function publicParcel(parcel) {
    const { history: _history, collected: _collected, ...rest } = parcel;
    return rest;
  }

  function paged(url, items) {
    const pageSize = Math.min(Number(url.searchParams.get('page_size') ?? 100) || 100, 1000);
    const page = Math.max(Number(url.searchParams.get('page') ?? 1) || 1, 1);
    const data = items.slice((page - 1) * pageSize, page * pageSize);
    return { has_more: page * pageSize < items.length, total_data: items.length, data, links: {} };
  }

  function readFailure(res, req) {
    const scenario = state.scenario.read;
    switch (scenario) {
      case 'html':
        sendText(res, 200, '<html><title>Just a moment</title></html>', 'text/html');
        return true;
      case 'bad-json':
        sendText(res, 200, '{"oops', 'application/json');
        return true;
      case 'no-total':
        sendJson(res, 200, { has_more: false, data: [] });
        return true;
      case '401':
        sendJson(res, 401, { error: { code: 401, message: 'Unauthorized' } });
        return true;
      case '429':
        sendJson(res, 429, { error: { code: 429, message: 'Too many' } }, { 'Retry-After': '9' });
        return true;
      case '503':
        sendJson(res, 503, { error: { code: 503, message: 'Unavailable' } });
        return true;
      case '503-once':
        if (state.read503Sent) return false;
        state.read503Sent = true;
        sendJson(res, 503, { error: { code: 503, message: 'Unavailable' } });
        return true;
      case 'down':
        req.socket.destroy();
        return true;
      default:
        return false;
    }
  }

  function handleParcelList(req, res, url) {
    if (readFailure(res, req)) return;
    for (const key of url.searchParams.keys()) {
      if (key !== 'page' && key !== 'page_size' && !FILTERS.has(key)) {
        sendJson(res, 400, { error: { code: 400, message: 'There is one or more invalid filter' } });
        return;
      }
    }
    let items = [...state.parcels.values()];
    const orderId = url.searchParams.get('order_id');
    if (orderId !== null) {
      items =
        state.scenario.read === 'none-exact'
          ? items.slice(0, 1).map((p) => ({ ...p, order_id: `${orderId}-other` }))
          : items.filter((p) => p.order_id === orderId);
    }
    const tracking = url.searchParams.get('tracking');
    if (tracking !== null) {
      const wanted = new Set(tracking.split(','));
      items = items.filter((p) => wanted.has(p.tracking));
    }
    sendJson(res, 200, { ...paged(url, items), data: paged(url, items).data.map(publicParcel) });
  }

  async function emitWebhook(event, options = {}) {
    const { webhookUrl, webhookSecret } = state.scenario;
    if (!webhookUrl || !isLoopbackUrl(webhookUrl)) return { sent: 0, statuses: [], skipped: 'no local webhook url' };
    const body = JSON.stringify({
      type: options.type ?? 'parcel_status_updated',
      events: [
        {
          event_id: options.eventId ?? `evt-${event.tracking}-${event.status}`,
          occurred_at: event.at,
          data: { tracking: event.tracking, status: event.status, reason: event.reason ?? null },
        },
      ],
    });
    const headers = { 'Content-Type': 'application/json' };
    if (options.signature !== 'none') {
      headers['X-YALIDINE-SIGNATURE'] =
        options.signature === 'bad'
          ? '0'.repeat(64)
          : createHmac('sha256', webhookSecret ?? '').update(body).digest('hex');
    }
    const statuses = [];
    for (let i = 0; i < (options.times ?? 1); i += 1) {
      try {
        const response = await fetch(webhookUrl, { method: 'POST', body, headers });
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
    const isCreate = req.method === 'POST' && rest === '/v1/parcels/';
    if (isCreate) state.createCount += 1;
    else state.readCount += 1;

    if (scenario.down) {
      req.socket.destroy();
      return undefined;
    }
    if (scenario.slowMs > 0) await sleep(scenario.slowMs);

    const labelMatch = /^\/label\/([\w-]+)$/.exec(rest);
    if (labelMatch && req.method === 'GET') {
      return sendText(res, 200, `<!doctype html><title>Waybill</title><h1>Waybill ${labelMatch[1]}</h1>`, 'text/html');
    }

    if (req.headers['x-api-id'] !== YALIDINE_CREDENTIALS.apiId || req.headers['x-api-token'] !== YALIDINE_CREDENTIALS.apiToken) {
      return sendJson(res, 401, { error: { code: 401, message: 'Invalid API credentials' } });
    }

    if (scenario.quota) {
      const wait = quota.take();
      if (wait !== null) {
        return sendJson(
          res,
          429,
          { error: { code: 429, message: 'Too Many Requests', description: 'Quota exceeded' } },
          { 'Retry-After': String(wait) },
        );
      }
      const left = quota.left();
      res.setHeader('x-second-quota-left', String(left.second));
      res.setHeader('x-minute-quota-left', String(left.minute));
    }

    const origin = `http://${req.headers.host}`;
    if (isCreate) return handleCreate(req, res, rawBody, origin);

    if (req.method !== 'GET') return sendJson(res, 404, { error: { code: 404, message: 'Not found' } });

    if (rest === '/v1/wilayas/') {
      if (readFailure(res, req)) return undefined;
      return sendJson(res, 200, paged(url, geo.wilayas.map((w) => ({ id: w.code, name: w.name, zone: 1, is_deliverable: 1 }))));
    }
    if (rest === '/v1/communes/') {
      if (readFailure(res, req)) return undefined;
      const wilayaId = Number(url.searchParams.get('wilaya_id'));
      const rows = geo.communes
        .filter((c) => c.wilayaCode === wilayaId)
        .map((c) => ({
          id: c.id,
          name: c.name,
          wilaya_id: c.wilayaCode,
          wilaya_name: c.wilayaName,
          has_stop_desk: desksOf.has(c.id) ? 1 : 0,
          is_deliverable: scenario.undeliverableCommunes.includes(c.name) ? 0 : 1,
          delivery_time_parcel: 2,
          delivery_time_payment: 7,
        }));
      return sendJson(res, 200, paged(url, rows));
    }
    if (rest === '/v1/centers/') {
      if (readFailure(res, req)) return undefined;
      const wilayaId = Number(url.searchParams.get('wilaya_id'));
      return sendJson(res, 200, paged(url, centers.filter((c) => c.wilaya_id === wilayaId)));
    }
    if (rest === '/v1/parcels/') return handleParcelList(req, res, url);

    const item = /^\/v1\/(parcels|histories)\/([\w-]+)$/.exec(rest);
    if (item) {
      if (readFailure(res, req)) return undefined;
      const parcel = state.parcels.get(item[2]);
      if (!parcel) return sendJson(res, 200, { has_more: false, total_data: 0, data: [], links: {} });
      if (item[1] === 'parcels') {
        return sendJson(res, 200, { has_more: false, total_data: 1, data: [publicParcel(parcel)], links: {} });
      }
      const rows = parcel.history.map((h) => ({ ...h, tracking: parcel.tracking }));
      return sendJson(res, 200, { has_more: false, total_data: rows.length, data: rows, links: {} });
    }
    return sendJson(res, 404, { error: { code: 404, message: 'Not found' } });
  }

  async function control(method, parts, body, res) {
    const [resource, tracking, action] = parts;
    if (method === 'GET' && resource === 'state') {
      return sendJson(res, 200, {
        createCount: state.createCount,
        readCount: state.readCount,
        scenario: state.scenario,
        lastCreateBody: state.lastCreateBody,
        lastUrl: state.lastUrl,
        parcels: [...state.parcels.values()],
      });
    }
    if (method === 'POST' && resource === 'scenario') {
      state.scenario = { ...state.scenario, ...body };
      return sendJson(res, 200, { scenario: state.scenario });
    }
    if (method === 'POST' && resource === 'seed') {
      const made = [];
      for (const row of body.parcels ?? []) {
        const tracking = row.tracking ?? newTracking();
        const now = algeriaTimestamp();
        const parcel = {
          tracking,
          order_id: row.order_id,
          firstname: 'A***',
          familyname: 'B***',
          contact_phone: '05******',
          address: '***',
          date_creation: now,
          date_last_status: row.date_last_status ?? now,
          last_status: row.last_status ?? 'En préparation',
          label: row.label ?? `https://yalidine.app/app/bordereau.php?tracking=${tracking}`,
          import_id: 1,
          collected: 0,
          history: [],
        };
        state.parcels.set(tracking, parcel);
        made.push(tracking);
      }
      return sendJson(res, 200, { trackings: made });
    }
    if (method === 'POST' && resource === 'parcels' && action === 'status') {
      const parcel = state.parcels.get(tracking);
      if (!parcel) return sendJson(res, 404, { error: 'unknown tracking' });
      const at = body.at ?? algeriaTimestamp();
      parcel.last_status = body.status;
      parcel.date_last_status = at;
      parcel.history.push({ date_status: at, status: body.status, reason: body.reason ?? '' });
      const webhook = await emitWebhook({ tracking, status: body.status, reason: body.reason, at }, body);
      return sendJson(res, 200, { tracking, status: body.status, at, webhook });
    }
    if (method === 'POST' && resource === 'webhook') {
      const at = body.at ?? algeriaTimestamp();
      const webhook = await emitWebhook({ tracking: body.tracking, status: body.status, reason: body.reason, at }, body);
      return sendJson(res, 200, { at, webhook });
    }
    return sendJson(res, 404, { error: 'unknown control' });
  }

  return { handle, control, reset };
}
