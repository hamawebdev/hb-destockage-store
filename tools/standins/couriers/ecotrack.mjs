// Stand-in for one EcoTrack tenant. Paths and shapes follow the official Postman docs, as read in
// artifacts/delivery-research/ecotrack.md.
import { algeriaTimestamp, createQuota, loadGeo, sendJson, sendText, sleep } from './lib.mjs';

export const ECOTRACK_TOKEN = 'standin-token';

const PAGE_SIZE = 40;

const DEFAULT_SCENARIO = {
  create: 'ok',
  validate: 'auto',
  read: 'ok',
  label: 'ok',
  token: 'auto',
  down: false,
  slowMs: 0,
  lateMs: 500,
  quota: true,
  noDeliveryWilayas: [],
};

const PDF = Buffer.from('%PDF-1.4\n% stand-in waybill\n%%EOF\n');

export function createEcotrackTenant({ id }) {
  const geo = loadGeo();
  const postal = (commune) => String(commune.id).padStart(4, '0');
  const deskCommunes = new Set(
    geo.wilayas.flatMap((w) => geo.communes.filter((c) => c.wilayaCode === w.code).slice(0, 2).map((c) => c.id)),
  );

  let state;
  const quota = createQuota({ perSecond: 1000, perMinute: 50 });

  function reset() {
    quota.reset();
    state = {
      scenario: { ...DEFAULT_SCENARIO },
      parcels: new Map(),
      nextTracking: 1,
      createCount: 0,
      validateCount: 0,
      readCount: 0,
      read503Sent: false,
      lastCreateQuery: null,
      lastUrl: null,
    };
  }
  reset();

  function newTracking() {
    return `ECSTND${String(state.nextTracking++).padStart(10, '0')}`;
  }

  const today = () => algeriaTimestamp().slice(0, 10);

  function storeParcel(query) {
    const tracking = newTracking();
    const parcel = {
      tracking,
      reference: query.get('reference'),
      client: query.get('nom_client'),
      phone: query.get('telephone'),
      adresse: query.get('adresse'),
      commune: query.get('commune'),
      wilaya_id: Number(query.get('code_wilaya')),
      montant: query.get('montant'),
      type_id: Number(query.get('type')),
      stop_desk: query.get('stop_desk'),
      created_at: today(),
      status: 'prete_a_expedier',
      validated: false,
      activity: [],
    };
    state.parcels.set(tracking, parcel);
    return parcel;
  }

  function validateQuery(query) {
    const errors = {};
    for (const field of ['nom_client', 'telephone', 'adresse', 'commune', 'code_wilaya', 'montant', 'type']) {
      if (!query.get(field)) errors[field] = [`Le champ ${field} est obligatoire.`];
    }
    if (Object.keys(errors).length > 0) return errors;
    if (!/^\d{9,10}$/.test(query.get('telephone'))) errors.telephone = ['Le champ téléphone est invalide.'];
    const wilaya = Number(query.get('code_wilaya'));
    if (!Number.isInteger(wilaya) || wilaya < 1 || wilaya > 58) errors.code_wilaya = ['Le champ code wilaya est invalide.'];
    if (!/^\d+(\.\d+)?$/.test(query.get('montant'))) errors.montant = ['Le champ montant est invalide.'];
    if (!geo.communes.some((c) => c.wilayaCode === wilaya && c.name === query.get('commune'))) {
      errors.commune = ['Commune mal écrite, ou désactivée.'];
    }
    return Object.keys(errors).length > 0 ? errors : null;
  }

  async function handleCreate(req, res, url) {
    const query = url.searchParams;
    state.lastCreateQuery = Object.fromEntries(query);
    const scenario = state.scenario.create;
    const valid = () => validateQuery(query) === null;

    switch (scenario) {
      case 'reject':
        return sendJson(res, 200, { success: false, error: 10002, message: 'Pas de livraison pour la wilaya sélectionnée' });
      case 'create-then-hang':
        if (valid()) storeParcel(query);
        return undefined;
      case 'headers-then-stall':
        if (valid()) storeParcel(query);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        return undefined;
      case 'hang-no-create':
        return undefined;
      case 'create-late':
        await sleep(state.scenario.lateMs);
        if (valid()) storeParcel(query);
        return undefined;
      case '500-no-create':
        return sendJson(res, 500, { message: 'Server Error' });
      case '500-after-create':
        if (valid()) storeParcel(query);
        return sendJson(res, 500, { message: 'Server Error' });
      case 'redirect':
        res.writeHead(302, { Location: 'https://anderson-ecommerce.ecotrack.dz/' });
        return res.end();
      case 'echo-token':
        return sendJson(res, 400, { message: `bad token ${url.searchParams.get('api_token') ?? req.headers.authorization}` });
      case 'bad-json':
        return sendText(res, 200, '{"oops', 'application/json');
      case 'html':
        return sendText(res, 200, '<html></html>', 'text/html');
      case 'tracking-null':
        return sendJson(res, 200, { success: true, tracking: null });
      case 'tracking-empty':
        return sendJson(res, 200, { success: true, tracking: '' });
      case 'tracking-number':
        return sendJson(res, 200, { success: true, tracking: 12345 });
      case 'success-1':
        return sendJson(res, 200, { success: 1, tracking: 'ECONE' });
      case 'success-string':
        return sendJson(res, 200, { success: 'true', tracking: 'ECSTR' });
      case 'false-with-tracking':
        return sendJson(res, 200, { success: false, tracking: 'ECFLS', message: 'x' });
      case 'disagree':
        return sendJson(res, 200, { success: true, tracking: 'ECAAA', data: { tracking: 'ECBBB' } });
      case 'nested-data':
        if (valid()) return sendJson(res, 200, { success: true, data: { tracking: storeParcel(query).tracking } });
        break;
      case 'nested-order':
        if (valid()) return sendJson(res, 200, { success: true, order: { tracking: storeParcel(query).tracking } });
        break;
      default:
        break;
    }
    if (/^\d{3}$/.test(scenario)) return sendJson(res, Number(scenario), { message: 'scenario' });

    const errors = validateQuery(query);
    if (errors) return sendJson(res, 422, { message: 'The given data was invalid.', errors });
    if (state.scenario.noDeliveryWilayas.includes(Number(query.get('code_wilaya')))) {
      return sendJson(res, 200, { success: false, error: 10002, message: 'Pas de livraison pour la wilaya sélectionnée' });
    }
    return sendJson(res, 200, { success: true, tracking: storeParcel(query).tracking });
  }

  async function handleValidate(res, url) {
    state.validateCount += 1;
    const scenario = state.scenario.validate;
    const parcel = state.parcels.get(url.searchParams.get('tracking'));
    if (scenario === 'hang') return undefined;
    if (scenario === '500') return sendJson(res, 500, { message: 'Server Error' });
    if (!parcel) return sendJson(res, 422, { message: 'The given data was invalid.', errors: { tracking: ['Le champ tracking sélectionné est invalide.'] } });
    if (scenario === 'locked' || parcel.validated) {
      return sendJson(res, 200, { success: false, error: 10001, message: 'Commande non modifiable' });
    }
    parcel.validated = true;
    parcel.askCollection = url.searchParams.get('ask_collection');
    return sendJson(res, 200, { success: true, message: 'Commande expedier avec succès' });
  }

  function readFailure(req, res) {
    const scenario = state.scenario.read;
    switch (scenario) {
      case 'html':
        sendText(res, 200, '<html></html>', 'text/html');
        return true;
      case 'bad-json':
        sendText(res, 200, '{"oops', 'application/json');
        return true;
      case '401':
        sendJson(res, 401, { message: 'Unauthenticated.' });
        return true;
      case '429':
        sendJson(res, 429, { message: 'Too Many Attempts.' }, { 'Retry-After': '9' });
        return true;
      case '503':
        sendJson(res, 503, { message: 'Service Unavailable' });
        return true;
      case '503-once':
        if (state.read503Sent) return false;
        state.read503Sent = true;
        sendJson(res, 503, { message: 'Service Unavailable' });
        return true;
      case 'down':
        req.socket.destroy();
        return true;
      default:
        return false;
    }
  }

  function handleOrders(res, url) {
    const start = url.searchParams.get('start_date');
    const end = url.searchParams.get('end_date');
    const items = [...state.parcels.values()].filter(
      (p) => (!start || p.created_at >= start) && (!end || p.created_at <= end),
    );
    const page = Math.max(Number(url.searchParams.get('page') ?? 1) || 1, 1);
    const lastPage = Math.max(Math.ceil(items.length / PAGE_SIZE), 1);
    const data = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((p) => {
      const { validated: _v, activity: _a, askCollection: _c, stop_desk: _s, ...row } = p;
      return state.scenario.read === 'rows-no-ref' ? (({ reference: _r, ...rest }) => rest)(row) : row;
    });
    const body = { current_page: page, data, last_page: lastPage, per_page: PAGE_SIZE, total: items.length };
    if (state.scenario.read === 'no-last-page') delete body.last_page;
    if (state.scenario.read === 'last-page-changes') body.last_page = lastPage + page;
    if (state.scenario.read === 'many-pages') body.last_page = 500;
    return sendJson(res, 200, body);
  }

  function handleStatus(res, url) {
    if (url.searchParams.get('api_token') !== ECOTRACK_TOKEN) return sendJson(res, 401, { message: 'Unauthenticated.' });
    const wanted = (url.searchParams.get('trackings') ?? '').split(',').filter(Boolean);
    const data = {};
    for (const tracking of wanted) {
      const parcel = state.parcels.get(tracking);
      if (parcel) data[tracking] = { status: parcel.status, order_id: '', activity: parcel.activity };
    }
    return sendJson(res, 200, { data: Object.keys(data).length === 0 ? [] : data });
  }

  async function handle(req, res, url, rest) {
    const scenario = state.scenario;
    state.lastUrl = url.pathname + url.search;
    const isCreate = req.method === 'POST' && rest === '/api/v1/create/order';
    if (isCreate) state.createCount += 1;
    else if (rest !== '/api/v1/valid/order') state.readCount += 1;

    if (scenario.down) {
      req.socket.destroy();
      return undefined;
    }
    if (scenario.slowMs > 0) await sleep(scenario.slowMs);

    if (rest === '/api/v1/validate/token' && req.method === 'GET') {
      if (scenario.token === 'not-allowed') return sendJson(res, 200, { success: false, message: 'TOKEN_NOT_ALLOWED' });
      if (scenario.token === 'odd') return sendJson(res, 200, { hello: 'world' });
      if (scenario.token === '404') return sendJson(res, 404, { message: '' });
      if (readFailure(req, res)) return undefined;
      return url.searchParams.get('api_token') === ECOTRACK_TOKEN
        ? sendJson(res, 200, { success: true, message: 'VALID_TOKEN' })
        : sendJson(res, 200, { success: false, message: 'INVALID_TOKEN' });
    }

    if (rest !== '/api/v1/get/orders/status' && req.headers.authorization !== `Bearer ${ECOTRACK_TOKEN}`) {
      return sendJson(res, 401, { message: 'Unauthenticated.' });
    }

    if (scenario.quota) {
      const wait = quota.take();
      if (wait !== null) return sendJson(res, 429, { message: 'Too Many Attempts.' }, { 'Retry-After': String(wait) });
      res.setHeader('X-RateLimit-Remaining-Minute', String(quota.left().minute));
    }

    if (isCreate) return handleCreate(req, res, url);
    if (rest === '/api/v1/valid/order' && req.method === 'POST') return handleValidate(res, url);
    if (req.method !== 'GET') return sendJson(res, 404, { message: '' });

    if (rest === '/api/v1/get/order/label') {
      if (readFailure(req, res)) return undefined;
      if (scenario.label === 'not-pdf') return sendText(res, 200, '<html>login</html>', 'text/html');
      if (!state.parcels.has(url.searchParams.get('tracking'))) return sendJson(res, 404, { message: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(PDF);
    }

    if (readFailure(req, res)) return undefined;
    if (rest === '/api/v1/get/wilayas') {
      return sendJson(res, 200, geo.wilayas.map((w) => ({ wilaya_id: w.code, wilaya_name: w.name })));
    }
    if (rest === '/api/v1/get/communes') {
      const wilaya = Number(url.searchParams.get('wilaya_id'));
      const rows = geo.communes.filter((c) => c.wilayaCode === wilaya);
      const indexed = {};
      rows.forEach((c, index) => {
        indexed[String(index)] = {
          nom: c.name,
          wilaya_id: c.wilayaCode,
          code_postal: postal(c),
          has_stop_desk: deskCommunes.has(c.id) ? 1 : 0,
        };
      });
      return sendJson(res, 200, indexed);
    }
    if (rest === '/api/v1/get/orders') return handleOrders(res, url);
    if (rest === '/api/v1/get/orders/status') return handleStatus(res, url);
    return sendJson(res, 404, { message: '' });
  }

  async function control(method, parts, body, res) {
    const [resource, tracking, action] = parts;
    if (method === 'GET' && resource === 'state') {
      return sendJson(res, 200, {
        createCount: state.createCount,
        validateCount: state.validateCount,
        readCount: state.readCount,
        scenario: state.scenario,
        lastCreateBody: state.lastCreateQuery,
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
        const newId = row.tracking ?? newTracking();
        state.parcels.set(newId, {
          tracking: newId,
          reference: row.reference ?? null,
          client: 'A',
          phone: '0560417403',
          adresse: 'x',
          commune: 'x',
          wilaya_id: 16,
          montant: '100',
          type_id: 1,
          created_at: row.created_at ?? today(),
          status: row.status ?? 'prete_a_expedier',
          validated: row.validated ?? false,
          activity: row.activity ?? [],
        });
        trackings.push(newId);
      }
      return sendJson(res, 200, { trackings });
    }
    if (method === 'POST' && resource === 'parcels' && action === 'status') {
      const parcel = state.parcels.get(tracking);
      if (!parcel) return sendJson(res, 404, { error: 'unknown tracking' });
      if (body.status !== undefined) parcel.status = body.status;
      if (Array.isArray(body.activity)) parcel.activity.push(...body.activity);
      return sendJson(res, 200, { tracking, status: parcel.status });
    }
    return sendJson(res, 404, { error: 'unknown control' });
  }

  return { handle, control, reset, id };
}
