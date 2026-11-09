// Stand-in for NOEST Express. No public docs exist: shapes follow artifacts/delivery-research/noest.md
// and the dz-delivery fixtures, themselves read from a partner PDF.
import { algeriaTimestamp, createQuota, loadGeo, sendJson, sendText, sleep } from './lib.mjs';

export const NOEST_CREDENTIALS = { apiToken: 'standin-token', userGuid: 'standin-guid' };

const DEFAULT_SCENARIO = {
  create: 'ok',
  validate: 'auto',
  read: 'ok',
  label: 'ok',
  down: false,
  slowMs: 0,
  lateMs: 500,
  quota: true,
};

const PDF = Buffer.from('%PDF-1.4\n% stand-in waybill\n%%EOF\n');

const STATIC_422 = {
  duplicate: { errors: { duplicate_order: 'Commande déjà existante' } },
  'duplicate-value': { errors: { order: 'duplicate_order' } },
  suspended: { errors: { account_suspended: 'Compte suspendu' } },
  'field-error': { message: 'The given data was invalid.', errors: { phone: ['Le champ phone est invalide.'] } },
  mixed: { errors: { duplicate_order: 'x', phone: ['bad'] } },
  'unlisted-422': { errors: { something_new: 'x' } },
  'no-errors-422': { message: 'nope' },
};

export function createNoest() {
  const geo = loadGeo();
  const deskCode = (wilaya, index) => `${wilaya}${'ABC'[index]}`;
  const desks = {};
  for (const wilaya of geo.wilayas) {
    geo.communes
      .filter((c) => c.wilayaCode === wilaya.code)
      .slice(0, 2)
      .forEach((commune, index) => {
        const code = deskCode(wilaya.code, index);
        desks[wilaya.code < 10 ? `0${code}` : code] = {
          code,
          name: `${wilaya.name} ${commune.name}`,
          address: `${index + 1} rue Test`,
          commune: commune.name,
          phones: { 0: '0550000000' },
          horaires: 'Sam–Jeu',
          map: '',
          email: '',
        };
      });
  }

  let state;
  const quota = createQuota({ perSecond: 1000, perMinute: 60 });

  function reset() {
    quota.reset();
    state = {
      scenario: { ...DEFAULT_SCENARIO },
      parcels: new Map(),
      references: new Set(),
      next: 1,
      createCount: 0,
      validateCount: 0,
      readCount: 0,
      lastCreateBody: null,
      lastTrackingsBody: null,
      lastUrl: null,
    };
  }
  reset();

  const newTracking = () => `NST-STN-${String(state.next++).padStart(8, '0')}`;

  function storeParcel(body) {
    const tracking = newTracking();
    state.parcels.set(tracking, { tracking, reference: body.reference, montant: body.montant, validated: false, activity: [] });
    state.references.add(body.reference);
    return tracking;
  }

  function validateBody(body) {
    for (const field of ['client', 'phone', 'adresse', 'commune', 'produit']) {
      if (!body[field]) return { [field]: [`Le champ ${field} est obligatoire.`] };
    }
    if (typeof body.reference !== 'string' || body.reference.length < 5) return { reference: ['Le champ reference est invalide.'] };
    if (!/^0\d{8,9}$/.test(body.phone)) return { phone: ['Le champ phone est invalide.'] };
    if (!Number.isInteger(body.wilaya_id) || body.wilaya_id < 1 || body.wilaya_id > 58) return { wilaya_id: ['Le champ wilaya_id est invalide.'] };
    if (typeof body.montant !== 'number') return { montant: ['Le champ montant est invalide.'] };
    if (body.type_id !== 1) return { type_id: ['Le champ type_id est invalide.'] };
    if (body.stop_desk) {
      const desk = Object.values(desks).find((d) => d.code === body.station_code);
      if (!desk || !desk.code.startsWith(String(body.wilaya_id))) return { station_code: 'Station invalide' };
      return null;
    }
    if (!geo.communes.some((c) => c.wilayaCode === body.wilaya_id && c.name === body.commune)) {
      return { inactive_commune: 'Commune inactive ou inconnue' };
    }
    return null;
  }

  async function handleCreate(req, res, body) {
    state.lastCreateBody = body;
    const scenario = state.scenario.create;
    const valid = () => validateBody(body) === null && !state.references.has(body.reference);

    if (STATIC_422[scenario]) return sendJson(res, 422, STATIC_422[scenario]);
    switch (scenario) {
      case 'exists':
        return sendJson(res, 200, { success: false, message: 'Colis déja existant' });
      case 'create-then-hang':
        if (valid()) storeParcel(body);
        return undefined;
      case 'headers-then-stall':
        if (valid()) storeParcel(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        return undefined;
      case 'hang-no-create':
        return undefined;
      case 'create-late':
        await sleep(state.scenario.lateMs);
        if (valid()) storeParcel(body);
        return undefined;
      case '500-no-create':
        return sendJson(res, 500, { message: 'Server Error' });
      case '500-after-create':
        if (valid()) storeParcel(body);
        return sendJson(res, 500, { message: 'Server Error' });
      case 'redirect':
        res.writeHead(302, { Location: 'https://app.noest-dz.com/' });
        return res.end();
      case 'echo-token':
        return sendJson(res, 400, { message: `bad token ${req.headers.authorization}` });
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
        return sendJson(res, 200, { success: 1, tracking: 'NST-ONE' });
      case 'other-ref':
        return sendJson(res, 200, { success: true, tracking: 'NST-OTHER', reference: 'someone-else' });
      default:
        break;
    }
    if (/^\d{3}$/.test(scenario)) return sendJson(res, Number(scenario), { message: 'scenario' });

    if (state.references.has(body.reference)) return sendJson(res, 422, STATIC_422.duplicate);
    const errors = validateBody(body);
    if (errors) return sendJson(res, 422, { message: 'The given data was invalid.', errors });
    const tracking = storeParcel(body);
    return sendJson(res, 200, { success: true, tracking, reference: body.reference, regional_hub_name: 'W', wilaya_rank: '16B' });
  }

  function handleValidate(res, body) {
    state.validateCount += 1;
    const scenario = state.scenario.validate;
    const parcel = state.parcels.get(body.tracking);
    if (scenario === 'hang') return undefined;
    if (scenario === '500') return sendJson(res, 500, { message: 'Server Error' });
    if (!parcel) return sendJson(res, 404, { message: 'Colis introuvable' });
    if (parcel.validated) return sendJson(res, 422, { errors: { already_validated: 'Déjà validé' } });
    parcel.validated = true;
    return sendJson(res, 200, { success: true });
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
        sendJson(res, 401, { error: 'Unauthenticated.' });
        return true;
      case '429':
        sendJson(res, 429, { message: 'Too Many Attempts.' }, { 'Retry-After': '9' });
        return true;
      case '503':
        sendJson(res, 503, { message: 'Service Unavailable' });
        return true;
      case 'odd-404':
        sendJson(res, 404, { message: 'Autre' });
        return true;
      case 'check-422':
        sendJson(res, 422, { errors: { trackings: ['invalide'] } });
        return true;
      case 'down':
        req.socket.destroy();
        return true;
      default:
        return false;
    }
  }

  function handleTrackings(res, body) {
    state.lastTrackingsBody = body;
    const data = {};
    for (const tracking of body.trackings ?? []) {
      const parcel = state.parcels.get(tracking);
      if (parcel) {
        data[tracking] = {
          OrderInfo: { tracking, reference: parcel.reference },
          recipientName: 'M***',
          shippedBy: 'Stand-in',
          activity: parcel.activity,
          deliveryAttempts: 0,
        };
      }
    }
    if (Object.keys(data).length === 0) return sendJson(res, 404, { message: 'Trackings non trouvés' });
    return sendJson(res, 200, data);
  }

  async function handle(req, res, url, rest, rawBody) {
    const scenario = state.scenario;
    state.lastUrl = url.pathname + url.search;
    const isCreate = req.method === 'POST' && rest === '/api/public/create/order';
    if (isCreate) state.createCount += 1;
    else state.readCount += 1;

    if (scenario.down) {
      req.socket.destroy();
      return undefined;
    }
    if (scenario.slowMs > 0) await sleep(scenario.slowMs);

    if (req.headers.authorization !== `Bearer ${NOEST_CREDENTIALS.apiToken}`) {
      return sendJson(res, 401, { error: 'Unauthenticated.' });
    }
    let body = {};
    if (req.method === 'POST') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return sendJson(res, 400, { message: 'Invalid JSON' });
      }
      if (body.user_guid !== NOEST_CREDENTIALS.userGuid) {
        return sendJson(res, 404, { success: false, message: 'Partenaire introuvable' });
      }
    }
    if (scenario.quota) {
      const wait = quota.take();
      if (wait !== null) return sendJson(res, 429, { message: 'Too Many Attempts.' }, { 'Retry-After': String(wait) });
    }

    if (isCreate) return handleCreate(req, res, body);
    if (rest === '/api/public/valid/order' && req.method === 'POST') return handleValidate(res, body);
    if (readFailure(req, res)) return undefined;

    if (rest === '/api/public/get/trackings/info' && req.method === 'POST') return handleTrackings(res, body);
    if (req.method !== 'GET') return sendJson(res, 404, { message: 'Not found' });
    if (rest === '/api/public/get/wilayas') {
      return sendJson(res, 200, geo.wilayas.map((w) => ({ code: w.code, nom: w.name, is_active: w.code === 50 ? 0 : 1 })));
    }
    const communes = /^\/api\/public\/get\/communes\/(\d+)$/.exec(rest);
    if (communes) {
      const wilaya = Number(communes[1]);
      return sendJson(res, 200, geo.communes.filter((c) => c.wilayaCode === wilaya).map((c) => ({ id: c.id, nom: c.name, wilaya_id: c.wilayaCode, code_postal: '0', is_active: 1 })));
    }
    if (rest === '/api/public/desks') return sendJson(res, 200, desks);
    if (rest === '/api/public/get/order/label') {
      if (scenario.label === 'not-pdf') return sendText(res, 200, '<html>login</html>', 'text/html');
      if (!state.parcels.has(url.searchParams.get('tracking'))) return sendJson(res, 404, { message: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(PDF);
    }
    return sendJson(res, 404, { message: 'Not found' });
  }

  async function control(method, parts, body, res) {
    const [resource, tracking, action] = parts;
    if (method === 'GET' && resource === 'state') {
      return sendJson(res, 200, {
        createCount: state.createCount,
        validateCount: state.validateCount,
        readCount: state.readCount,
        scenario: state.scenario,
        lastCreateBody: state.lastCreateBody,
        lastTrackingsBody: state.lastTrackingsBody,
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
        state.parcels.set(id, { tracking: id, reference: row.reference ?? null, validated: row.validated ?? false, activity: row.activity ?? [] });
        trackings.push(id);
      }
      return sendJson(res, 200, { trackings });
    }
    if (method === 'POST' && resource === 'parcels' && action === 'status') {
      const parcel = state.parcels.get(tracking);
      if (!parcel) return sendJson(res, 404, { error: 'unknown tracking' });
      parcel.activity.push({
        event: body.event ?? null,
        event_key: body.event_key ?? null,
        causer: 'STANDIN',
        by: '',
        name: '',
        driver: '',
        fdr: '',
        date: body.date ?? algeriaTimestamp(),
      });
      return sendJson(res, 200, { tracking });
    }
    return sendJson(res, 404, { error: 'unknown control' });
  }

  return { handle, control, reset };
}
