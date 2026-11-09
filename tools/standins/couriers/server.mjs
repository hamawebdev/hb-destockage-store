#!/usr/bin/env node
// Local courier stand-ins (BRIEF §5). No dependencies. Binds 127.0.0.1 only.
//
//   node tools/standins/couriers/server.mjs --port 4401     (0 = ephemeral; prints the port)
//
// Point COURIER_STANDIN_URL at http://127.0.0.1:<port>. Each courier lives under its id:
//   /yalidine/v1/parcels/   /guepex/v1/parcels/
//
// Yalidine and Guepex accept API ID `standin-id`, API token `standin-token`; anything else is 401.
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
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { sendJson } from './lib.mjs';
import { createYalidineFamily } from './yalidine.mjs';

function createCouriers() {
  return new Map([
    ['yalidine', createYalidineFamily({ id: 'yalidine', trackingPrefix: 'yal' })],
    ['guepex', createYalidineFamily({ id: 'guepex', trackingPrefix: 'gpx' })],
  ]);
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
        for (const courier of couriers.values()) courier.reset();
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
