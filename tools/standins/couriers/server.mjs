#!/usr/bin/env node
// Local courier stand-ins (BRIEF §5). No dependencies. Binds 127.0.0.1 only.
//
//   node tools/standins/couriers/server.mjs --port 4401     (0 = ephemeral; prints the port)
//
// Point COURIER_STANDIN_URL at http://127.0.0.1:<port>. Each courier lives under its id:
//   /yalidine/v1/parcels/   /guepex/v1/parcels/   /ecotrack-<tenant>/api/v1/create/order
//
// Yalidine and Guepex accept API ID `standin-id`, API token `standin-token`; EcoTrack tenants accept
// API token `standin-token`. Anything else is refused.
//
// Control endpoints (JSON bodies):
//   GET  /__control/<courier>/state                     createCount, readCount, parcels, last request
//   POST /__control/<courier>/scenario                  merge settings: {create, read, down, slowMs,
//                                                       lateMs, quota, accountDisabled, webhookUrl,
//                                                       webhookSecret, undeliverableCommunes}
//   POST /__control/<courier>/parcels/<tracking>/status {status, reason?, at?, times?, signature?}
//                                                       moves the parcel; emits a webhook if configured
//   POST /__control/<courier>/webhook                   {tracking, status, reason?, at?, eventId?,
//                                                       times?, type?, signature: 'bad'|'none'}
//   POST /__control/<courier>/seed                      {parcels: [{tracking?, order_id, last_status?}]}
//   POST /__control/reset                               clears every courier, including quota windows
//
// `create` scenarios: ok, reject, create-then-hang, headers-then-stall, hang-no-create, create-late,
// 500-no-create, 500-after-create, redirect, echo-token, bad-json, html, missing-ref, tracking-null,
// tracking-empty, tracking-number, success-1, success-string, false-with-tracking, two-rows, or a
// three-digit HTTP status. `read` scenarios: ok, down, html, bad-json, no-total, none-exact, 401, 429,
// 503, 503-once.
// EcoTrack also has: `create` nested-data, nested-order, disagree; `validate` auto, locked, hang, 500;
// `read` no-last-page, last-page-changes, rows-no-ref, many-pages; `label` ok, not-pdf; `token` auto,
// not-allowed, odd, 404. Its seed takes {parcels: [{tracking?, reference, status?, created_at?, activity?}]}
// and its status control takes {status?, activity?}. State adds `validateCount`.
// ZR Express (/zr-express/api/v1/...) accepts X-Api-Key `standin-key` with X-Tenant `standin-tenant`.
// `create` adds reject, db-error, unexpected-error, unlisted-error, request-error, zero, other-ref,
// both, bad-tracking; `validate` auto, hang, 500, other-name; `read` adds no-items, no-total, endless,
// workflows-down; `pollFilter` honoured or ignored; `noHomeCommunes`, `noPickupCommunes`; `workflows`.
// Its seed takes {parcels: [{tracking?, externalId, state?, isReturn?, lastStateUpdateAt?, situation?}]};
// its status control takes {state?, isReturn?, at?, eventType?, situation?, times?, id?} and emits a
// Svix-signed webhook to `webhookUrl`, with the secret ZR_WEBHOOK_SECRET from zr-express.mjs.
// NOEST (/noest/api/public/...) accepts Bearer `standin-token` with user_guid `standin-guid`. `create`
// adds exists, duplicate, duplicate-value, suspended, field-error, mixed, unlisted-422, no-errors-422,
// other-ref; `validate` auto, hang, 500; `read` adds odd-404, check-422; `label` ok, not-pdf. Its seed
// takes {parcels: [{tracking?, reference?, activity?}]}; status control takes {event_key?, event?, date?}.
// Maystro (/maystro/orders-management/... and /maystro/backend/...) accepts `Token standin-token`.
// `create` adds code:<n>, code-object:<n>, non-integer, no-errors, two-rows, other-external;
// `read` adds two-rows; `wilayaShape` objects or tuples; `quota` is off by default. Its seed takes
// {parcels: [{tracking?, status?, updated_at?, alert_reason?, abort_reason?}]}; status control takes
// {status?, updated_at?}.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { sendJson } from './lib.mjs';
import { createEcotrackTenant } from './ecotrack.mjs';
import { createMaystro } from './maystro.mjs';
import { createNoest } from './noest.mjs';
import { createYalidineFamily } from './yalidine.mjs';
import { createZrExpress } from './zr-express.mjs';

function createCouriers() {
  const couriers = new Map([
    ['yalidine', createYalidineFamily({ id: 'yalidine', trackingPrefix: 'yal' })],
    ['guepex', createYalidineFamily({ id: 'guepex', trackingPrefix: 'gpx' })],
    ['zr-express', createZrExpress()],
    ['noest', createNoest()],
    ['maystro', createMaystro()],
  ]);
  return {
    all: () => couriers.values(),
    // Any `ecotrack-<tenant>` exists on first use.
    get(name) {
      if (!couriers.has(name) && /^ecotrack-[a-z0-9-]+$/.test(name)) {
        couriers.set(name, createEcotrackTenant({ id: name }));
      }
      return couriers.get(name);
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createStandin() {
  const couriers = createCouriers();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const rawBody = await readBody(req);

      if (url.pathname === '/__control/reset' && req.method === 'POST') {
        for (const courier of couriers.all()) courier.reset();
        sendJson(res, 200, { reset: true });
        return;
      }
      if (url.pathname.startsWith('/__control/')) {
        const [name, ...parts] = url.pathname.slice('/__control/'.length).split('/');
        const courier = couriers.get(name);
        if (!courier) {
          sendJson(res, 404, { error: 'unknown courier' });
          return;
        }
        let body = {};
        if (rawBody !== '') {
          try {
            body = JSON.parse(rawBody);
          } catch {
            sendJson(res, 400, { error: 'invalid JSON' });
            return;
          }
        }
        await courier.control(req.method, parts, body, res);
        return;
      }

      const slash = url.pathname.indexOf('/', 1);
      const name = slash === -1 ? url.pathname.slice(1) : url.pathname.slice(1, slash);
      const courier = couriers.get(name);
      if (!courier) {
        sendJson(res, 404, { error: 'unknown courier' });
        return;
      }
      await courier.handle(req, res, url, slash === -1 ? '/' : url.pathname.slice(slash), rawBody);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.destroy();
    }
  });
  return server;
}

function portFromArgs(argv) {
  const index = argv.indexOf('--port');
  const value = index === -1 ? '0' : argv[index + 1];
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port ${value}`);
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createStandin();
  server.listen(portFromArgs(process.argv.slice(2)), '127.0.0.1', () => {
    console.log(`courier stand-ins listening on http://127.0.0.1:${server.address().port}`);
  });
}
