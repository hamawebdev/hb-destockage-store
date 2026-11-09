/**
 * ZR Express, new platform (artifacts/delivery-research/zr-express.md, official docs at
 * docs.zrexpress.app; addendum artifacts/CARR-0/addendum-zr-express.md). Parcels stay drafts until
 * moved to the ready state. Webhooks are signed the Svix way.
 */
import { normalizePhone } from '@hb/shared/phone';
import {
  classifyCredentialHttp,
  classifyWrite,
  courierBase,
  failureCause,
  isValidTracking,
  listFailure,
  parseObject,
  read,
  redact,
  safeLabelUrl,
  send,
  startDeadline,
  unavailable,
} from '../client.ts';
import { matchCommune } from '../commune.ts';
import { parseCourierDate } from '../event.ts';
import type { GuardedResult } from '../http.ts';
import { VERIFY_AFTER_SECONDS } from '../resend.ts';
import { normaliseRaw } from '../status.ts';
import { toWilaya58 } from '../wilaya.ts';
import type {
  CourierAdapter,
  CourierCapabilities,
  CourierCommune,
  CourierContext,
  CourierCredentials,
  CourierLists,
  CourierStopDesk,
  CourierWilaya,
  CreateResult,
  ListResult,
  LookupResult,
  ParcelEvent,
  ParcelInput,
  PreparedParcel,
  PrepareResult,
  StatusFetchResult,
  ValidateResult,
  WebhookInput,
  WebhookParseResult,
  WebhookVerification,
} from '../types.ts';
import { ZR_GONE, ZR_READY_STATES, ZR_STATUSES, zrStatus } from './statuses.ts';

const ID = 'zr-express';
const MAX_AMOUNT = 150_000;
const MAX_LIST_PAGES = 20;
const LIST_PAGE_SIZE = 1000;
const WORKFLOW_PAGE_SIZE = 50;
const MAX_UNLISTED = 50;
const WEBHOOK_TOLERANCE_SECONDS = 300;
const DUPLICATE = 'ParcelErrors.DuplicateExternalId';
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'General.Validation',
  'ParcelErrors.DeliveryPriceNotFound',
  'ParcelErrors.HubStockIdRequiredForWarehouseStockType',
  'ParcelErrors.HubStockIdMustBeAStorageHub',
  'ParcelStateErrors.NotFound',
  'HubErrors.HubNotFound',
  'TerritoryErrors.NotFound',
]);
const LABEL_HOSTS = ['zrexpressstorage.blob.core.windows.net'];
const WEBHOOK_EVENTS = new Set(['parcel.state.updated', 'parcel.state.situation.created', 'parcel.isReturn.updated']);

const CAPABILITIES: CourierCapabilities = {
  verifyByReference: true,
  verifyAfterSeconds: VERIFY_AFTER_SECONDS,
  verifyWithinSeconds: null,
  needsValidation: true,
  stopDesk: true,
  pollBatchSize: 100,
  minPollSeconds: 300,
  sendPerMinute: 30,
  webhook: 'hmac',
  needsOriginWilaya: false,
  credentialFields: [
    { key: 'apiKey', secret: true, labelFr: 'Clé API secrète', labelAr: 'مفتاح API السري' },
    { key: 'tenantId', secret: true, labelFr: 'Identifiant du compte (tenant)', labelAr: 'معرّف الحساب (tenant)' },
  ],
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function headers(credentials: CourierCredentials): Record<string, string> {
  return {
    'X-Api-Key': credentials['apiKey'] ?? '',
    'X-Tenant': credentials['tenantId'] ?? '',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

const api = (ctx: CourierContext) => `${courierBase('https://api.zrexpress.app', ID, ctx)}/api/v1`;

function post(path: string, body: unknown, credentials: CourierCredentials, ctx: CourierContext): Promise<GuardedResult> {
  return send(`${api(ctx)}/${path}`, { method: 'POST', headers: headers(credentials), body: JSON.stringify(body) }, ctx);
}

const equals = (field: string, value: unknown) => ({ field, operator: 'eq', value });

function errorMessage(body: string): unknown {
  const json = parseObject(body);
  if (!json) return undefined;
  return typeof json['detail'] === 'string' ? json['detail'] : json['title'];
}

function eventKeyFor(tracking: string, name: unknown, isReturn: unknown, at: number | null): string {
  return `${tracking}|${normaliseRaw(name) ?? ''}|${isReturn === true}|${at ?? 'none'}`;
}

function refuse(result: GuardedResult): ValidateResult | null {
  if (result.kind === 'refused') return { kind: 'rejected', code: 'guard_refused', detail: failureCause(result) };
  return result.kind === 'response' && result.status === 200 ? null : { kind: 'uncertain', cause: failureCause(result) };
}

function prepare(input: ParcelInput, lists: CourierLists): PrepareResult {
  if (lists.wilayas.length === 0) {
    return { ok: false, code: 'lists_missing', detail: "The courier's wilaya list is not loaded" };
  }
  const destination = toWilaya58(input.wilayaCode);
  if (!destination.ok) return { ok: false, code: 'wilaya_unmapped', detail: destination.detail };
  const wilaya = lists.wilayas.find((w) => w.code === destination.code);
  if (!wilaya?.id) return { ok: false, code: 'wilaya_unmapped', detail: `The courier has no wilaya ${destination.code}` };
  if (!wilaya.deliverable) {
    return { ok: false, code: 'wilaya_not_deliverable', detail: `The courier does not deliver to ${wilaya.name}` };
  }

  const phone = normalizePhone(input.phone);
  if (!phone.ok) return { ok: false, code: 'phone_invalid', detail: phone.code };

  const name = input.recipientName.trim().replace(/\s+/gu, ' ');
  if (name.length < 2) return { ok: false, code: 'recipient_required', detail: 'The recipient name is too short' };

  if (!Number.isInteger(input.codTotalDzd) || input.codTotalDzd < 0 || input.codTotalDzd > MAX_AMOUNT) {
    return { ok: false, code: 'amount_out_of_range', detail: `Amount must be 0 to ${MAX_AMOUNT} DZD` };
  }

  const communes = lists.communes.filter((c) => c.wilayaCode === destination.code);
  let hubId: string | undefined;
  let districtId: string | undefined;
  let street = input.address?.trim() ?? '';

  if (input.deliveryType === 'stop_desk') {
    if (!input.stopDeskId) return { ok: false, code: 'stop_desk_required', detail: 'No stop desk was chosen' };
    const desk = lists.stopDesks.find((d) => d.id === input.stopDeskId);
    if (!desk || desk.wilayaCode !== destination.code) {
      return { ok: false, code: 'stop_desk_mismatch', detail: 'This stop desk is not in the order wilaya' };
    }
    hubId = desk.id;
    street ||= desk.address;
    // Many hubs carry no commune tag, and the district is still required.
    if (desk.communeId) {
      const tagged = communes.find((c) => c.id === desk.communeId);
      if (tagged && !tagged.hasStopDesk) {
        return { ok: false, code: 'commune_not_deliverable', detail: 'This commune has no pickup point' };
      }
      districtId = desk.communeId;
    } else {
      if (communes.length === 0) return { ok: false, code: 'lists_missing', detail: "The courier's commune list is not loaded" };
      const match = matchCommune(input.commune, communes.map((c) => ({ ...c, deliverable: c.hasStopDesk })));
      if (!match.ok) return { ok: false, code: match.code, detail: match.detail };
      districtId = match.commune.id;
    }
  } else {
    if (street === '') return { ok: false, code: 'address_required', detail: 'A home delivery needs an address' };
    if (communes.length === 0) return { ok: false, code: 'lists_missing', detail: "The courier's commune list is not loaded" };
    const match = matchCommune(input.commune, communes);
    if (!match.ok) return { ok: false, code: match.code, detail: match.detail };
    districtId = match.commune.id;
  }
  if (!districtId) return { ok: false, code: 'commune_unmapped', detail: 'The courier gave this commune no id' };

  const label = input.productLabel.trim();
  return {
    ok: true,
    parcel: {
      courier: ID,
      reference: input.reference,
      payload: {
        externalId: input.reference,
        customer: {
          customerId: crypto.randomUUID(),
          name: name.slice(0, 100),
          phone: { number1: phone.e164 },
        },
        deliveryAddress: { cityTerritoryId: wilaya.id, districtTerritoryId: districtId, street },
        deliveryType: input.deliveryType === 'stop_desk' ? 'pickup-point' : 'home',
        ...(hubId ? { hubId } : {}),
        description: label.length >= 2 ? label.slice(0, 250) : input.reference,
        // The order total. The docs conflict on whether this includes delivery (shown in the admin).
        amount: input.codTotalDzd,
        orderedProducts: [{ productName: label || input.reference, unitPrice: input.codTotalDzd, quantity: 1, stockType: 'none' }],
      },
    },
  };
}

function parseBulk(json: Record<string, unknown>, reference: string, credentials: CourierCredentials): CreateResult {
  const successes = json['successes'] ?? [];
  const failures = json['failures'] ?? [];
  if (!Array.isArray(successes) || !Array.isArray(failures)) return { kind: 'uncertain', cause: 'malformed_response' };

  if (successes.length === 1 && failures.length === 0 && json['successCount'] === 1) {
    const row = asRecord(successes[0]);
    if (row?.['externalId'] === reference && isValidTracking(row['trackingNumber'])) {
      return { kind: 'accepted', tracking: row['trackingNumber'], draft: true };
    }
    return { kind: 'uncertain', cause: 'malformed_response' };
  }
  if (successes.length === 0 && failures.length === 1) {
    const row = asRecord(failures[0]);
    if (row?.['externalId'] !== reference) return { kind: 'uncertain', cause: 'malformed_response' };
    const code = row['errorCode'];
    if (code === DUPLICATE) return { kind: 'uncertain', cause: 'duplicate_external_id' };
    if (typeof code === 'string' && REFUSED_CODES.has(code)) {
      return { kind: 'rejected', code: 'courier_refused', detail: redact(row['errorMessage'], credentials) || code };
    }
  }
  return { kind: 'uncertain', cause: 'malformed_response' };
}

async function createParcel(parcel: PreparedParcel, credentials: CourierCredentials, ctx: CourierContext): Promise<CreateResult> {
  if (parcel.courier !== ID) return { kind: 'rejected', code: 'wrong_courier', detail: 'Prepared for another courier' };
  const result = await post('parcels/bulk', { parcels: [parcel.payload] }, credentials, ctx);

  // With one parcel, a row-level failure is a 400 carrying the same body as a partial success.
  if (result.kind === 'response' && result.status === 400) {
    const json = parseObject(result.text);
    if (json && Array.isArray(json['failures'])) return parseBulk(json, parcel.reference, credentials);
  }
  const classified = classifyWrite(result, errorMessage, credentials);
  if ('done' in classified) return classified.done;
  const json = parseObject(classified.body);
  return json ? parseBulk(json, parcel.reference, credentials) : { kind: 'uncertain', cause: 'malformed_response' };
}

async function validateParcel(tracking: string, credentials: CourierCredentials, ctx: CourierContext): Promise<ValidateResult> {
  if (!isValidTracking(tracking)) return { kind: 'rejected', code: 'bad_request', detail: 'Invalid tracking' };

  const current = await read(`${api(ctx)}/parcels/${tracking}`, headers(credentials), ctx, startDeadline(ctx));
  const failedRead = refuse(current);
  if (failedRead || current.kind !== 'response') return failedRead ?? { kind: 'uncertain', cause: 'malformed_response' };
  const parcel = parseObject(current.text);
  const state = asRecord(parcel?.['state']);
  if (!parcel || typeof parcel['id'] !== 'string' || !state) return { kind: 'uncertain', cause: 'malformed_response' };
  if (typeof state['name'] === 'string' && ZR_READY_STATES.includes(state['name'])) return { kind: 'validated' };
  // Anything already moving (or that we can't read) must never be pushed back to the ready state.
  if (zrStatus(state['name'], parcel['isReturn']) !== 'pending') {
    return { kind: 'rejected', code: 'locked', detail: 'The parcel has moved past preparation' };
  }

  const workflows = await post('workflows/search', { pageNumber: 1, pageSize: WORKFLOW_PAGE_SIZE }, credentials, ctx);
  const failedWorkflows = refuse(workflows);
  if (failedWorkflows || workflows.kind !== 'response') return failedWorkflows ?? { kind: 'uncertain', cause: 'malformed_response' };
  const items = parseObject(workflows.text)?.['items'];
  if (!Array.isArray(items)) return { kind: 'uncertain', cause: 'malformed_response' };

  const statesOf = (workflow: unknown): Array<Record<string, unknown>> => {
    const states = asRecord(workflow)?.['states'];
    return Array.isArray(states) ? states.map(asRecord).filter((s): s is Record<string, unknown> => s !== undefined) : [];
  };
  const workflow = items.find((w) => statesOf(w).some((s) => s['id'] === state['id']));
  if (workflow === undefined) {
    return { kind: 'rejected', code: 'bad_request', detail: 'No workflow holds this parcel' };
  }
  // A declared preference: the slug, and the alias only when the slug isn't there.
  let targets: Array<Record<string, unknown>> = [];
  for (const name of ZR_READY_STATES) {
    targets = statesOf(workflow).filter((s) => s['name'] === name);
    if (targets.length > 0) break;
  }
  const target = targets[0];
  if (targets.length !== 1 || !target || typeof target['id'] !== 'string') {
    return { kind: 'rejected', code: 'bad_request', detail: 'The workflow has no single ready state' };
  }

  const moved = await post(`parcels/${parcel['id']}/state`, { parcelId: parcel['id'], newStateId: target['id'] }, credentials, ctx);
  const classified = classifyWrite(moved, errorMessage, credentials);
  if ('done' in classified) return classified.done;
  return parseObject(classified.body)?.['newStateName'] === target['name']
    ? { kind: 'validated' }
    : { kind: 'uncertain', cause: 'malformed_response' };
}

async function findByReference(
  reference: string,
  options: { readonly attemptedAt: number },
  credentials: CourierCredentials,
  ctx: CourierContext,
): Promise<LookupResult> {
  if (!Number.isFinite(options?.attemptedAt)) return { kind: 'unavailable', cause: 'attempted_at_missing' };
  const result = await post(
    'parcels/search',
    { pageNumber: 1, pageSize: 10, advancedFilter: { logic: 'and', filters: [equals('externalId', reference)] } },
    credentials,
    ctx,
  );
  if (result.kind !== 'response' || result.status !== 200) return unavailable(result);
  const body = parseObject(result.text);
  const items = body?.['items'];
  const total = body?.['totalCount'];
  if (!body || !Array.isArray(items) || typeof total !== 'number') return { kind: 'unavailable', cause: 'malformed_response' };
  if (total === 0 && items.length === 0) return { kind: 'not_found', checkedAt: (ctx.now ?? Date.now)() };
  if (body['hasNext'] === true) return { kind: 'unavailable', cause: 'too_many_rows' };

  const exact = items.map(asRecord).filter((row): row is Record<string, unknown> => row?.['externalId'] === reference);
  const first = exact[0];
  if (first === undefined) return { kind: 'unavailable', cause: 'no_exact_match' };
  if (exact.length > 1) {
    return { kind: 'multiple', trackings: exact.map((row) => row['trackingNumber']).filter(isValidTracking) };
  }
  if (!isValidTracking(first['trackingNumber'])) return { kind: 'unavailable', cause: 'malformed_response' };
  const rawStatus = asRecord(first['state'])?.['name'];
  const name = typeof rawStatus === 'string' ? rawStatus : '';
  return {
    kind: 'found',
    tracking: first['trackingNumber'] as string,
    rawStatus: name,
    status: zrStatus(name, first['isReturn']),
    gone: ZR_GONE.has(normaliseRaw(name) ?? ''),
  };
}

function eventFromParcel(row: Record<string, unknown>, tracking: string): ParcelEvent | null {
  const name = asRecord(row['state'])?.['name'];
  if (normaliseRaw(name) === null) return null;
  const occurredAt = parseCourierDate(row['lastStateUpdateAt']);
  const situation = asRecord(row['situation'])?.['name'];
  return {
    tracking,
    rawStatus: name as string,
    status: zrStatus(name, row['isReturn']),
    reason: typeof situation === 'string' && situation !== '' ? situation : null,
    occurredAt,
    eventKey: eventKeyFor(tracking, name, row['isReturn'], occurredAt),
  };
}

async function fetchStatuses(
  trackings: readonly string[],
  credentials: CourierCredentials,
  ctx: CourierContext,
): Promise<StatusFetchResult> {
  const invalid = trackings.filter((t) => !isValidTracking(t));
  const valid = [...new Set(trackings.filter(isValidTracking))];
  if (valid.length > CAPABILITIES.pollBatchSize) return { ok: false, cause: 'batch_too_large' };
  if (valid.length === 0) return { ok: true, events: [], absent: [], invalid, badRows: 0 };

  const result = await post(
    'parcels/search',
    {
      pageNumber: 1,
      pageSize: CAPABILITIES.pollBatchSize,
      advancedFilter: { logic: 'or', filters: valid.map((t) => equals('trackingNumber', t)) },
    },
    credentials,
    ctx,
  );
  if (result.kind !== 'response' || result.status !== 200) {
    const failure = unavailable(result);
    return { ok: false, cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
  }
  const body = parseObject(result.text);
  const items = body?.['items'];
  if (!body || !Array.isArray(items)) return { ok: false, cause: 'malformed_response' };
  if (body['hasNext'] === true) return { ok: false, cause: 'too_many_rows' };

  const wanted = new Set(valid);
  const seen = new Set<string>();
  const events: ParcelEvent[] = [];
  let badRows = 0;
  for (const raw of items) {
    const row = asRecord(raw);
    const tracking = row?.['trackingNumber'];
    const event = row && isValidTracking(tracking) && wanted.has(tracking) ? eventFromParcel(row, tracking) : null;
    if (event === null) {
      badRows += 1;
      continue;
    }
    seen.add(event.tracking);
    events.push(event);
  }
  const absent = valid.filter((t) => !seen.has(t));
  // Our trackings exist, so an empty answer for a whole batch means the query is wrong.
  if (valid.length >= 2 && absent.length === valid.length) return { ok: false, cause: 'filter_returned_nothing' };
  return { ok: true, events, absent, invalid, badRows };
}

/** Follows `hasNext` to a cap. A truncated list is a failure, never a short list. */
async function collect(
  path: string,
  body: Record<string, unknown>,
  credentials: CourierCredentials,
  ctx: CourierContext,
): Promise<ListResult<Record<string, unknown>>> {
  const deadline = startDeadline(ctx);
  const items: Array<Record<string, unknown>> = [];
  for (let pageNumber = 1; pageNumber <= MAX_LIST_PAGES; pageNumber += 1) {
    if (deadline.remaining() <= 0) return { ok: false, cause: 'timeout' };
    const result = await post(path, { ...body, pageNumber, pageSize: LIST_PAGE_SIZE }, credentials, ctx);
    if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
    const json = parseObject(result.text);
    const rows = json?.['items'];
    if (!json || !Array.isArray(rows)) return { ok: false, cause: 'malformed_response' };
    for (const row of rows) {
      const record = asRecord(row);
      if (record) items.push(record);
    }
    if (json['hasNext'] !== true) return { ok: true, items };
  }
  return { ok: false, cause: 'too_many_pages' };
}

const delivery = (row: Record<string, unknown>) => asRecord(row['delivery']);

async function territoriesOfLevel(
  filters: unknown[],
  credentials: CourierCredentials,
  ctx: CourierContext,
): Promise<ListResult<Record<string, unknown>>> {
  return collect('territories/search', { advancedFilter: { logic: 'and', filters } }, credentials, ctx);
}

async function wilayaUuid(
  wilayaCode: number,
  credentials: CourierCredentials,
  ctx: CourierContext,
): Promise<{ ok: true; id: string; code: number } | { ok: false; cause: string; retryAfterMs?: number }> {
  const mapped = toWilaya58(wilayaCode);
  if (!mapped.ok) return { ok: false, cause: mapped.code };
  const result = await territoriesOfLevel([equals('level', 'wilaya'), equals('code', mapped.code)], credentials, ctx);
  if (!result.ok) return result;
  const row = result.items.find((item) => item['code'] === mapped.code);
  return typeof row?.['id'] === 'string' ? { ok: true, id: row['id'], code: mapped.code } : { ok: false, cause: 'wilaya_not_found' };
}

async function verifyWebhook(input: WebhookInput): Promise<WebhookVerification> {
  const { rawBody, headers: received, secret, now } = input;
  if (typeof now !== 'number' || !Number.isFinite(now)) return { ok: false, reason: 'malformed' };
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return { ok: false, reason: 'missing_secret' };
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, reason: 'missing_secret' };
  }
  if (keyBytes.length === 0) return { ok: false, reason: 'missing_secret' };

  const lower = new Map(Object.entries(received).map(([k, v]) => [k.toLowerCase(), v]));
  const id = lower.get('svix-id');
  const timestamp = lower.get('svix-timestamp');
  const signatures = lower.get('svix-signature');
  if (!id || !timestamp || !signatures) return { ok: false, reason: 'missing_signature' };
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'bad_signature' };
  }

  try {
    const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
    const signed = new Uint8Array(prefix.length + rawBody.length);
    signed.set(prefix, 0);
    signed.set(rawBody, prefix.length);
    for (const entry of signatures.split(' ')) {
      if (!entry.startsWith('v1,')) continue;
      let candidate: Uint8Array;
      try {
        candidate = Uint8Array.from(atob(entry.slice(3)), (c) => c.charCodeAt(0));
      } catch {
        continue;
      }
      if (await crypto.subtle.verify('HMAC', key, candidate as BufferSource, signed as BufferSource)) return { ok: true };
    }
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: false, reason: 'bad_signature' };
}

function parseWebhook(rawBody: Uint8Array): WebhookParseResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const body = parseObject(text);
  if (!body || typeof body['eventType'] !== 'string') return { ok: false, reason: 'malformed' };
  const type = body['eventType'];
  if (!WEBHOOK_EVENTS.has(type)) return { ok: true, events: [], badRows: 0 };

  const data = asRecord(body['data']);
  const tracking = data?.['trackingNumber'];
  const name = asRecord(data?.['state'])?.['name'];
  if (!data || !isValidTracking(tracking) || normaliseRaw(name) === null) return { ok: true, events: [], badRows: 1 };

  // The same timestamp polling uses, so one state gives one key on both channels.
  const stateAt = parseCourierDate(data['lastStateUpdateAt']);
  const occurredAt = stateAt ?? (type === 'parcel.state.updated' ? parseCourierDate(body['occurredAt']) : null);
  if (occurredAt === null) return { ok: true, events: [], badRows: 1 };

  const situation = asRecord(data['situation'])?.['name'];
  return {
    ok: true,
    badRows: 0,
    events: [
      {
        tracking,
        rawStatus: name as string,
        status: zrStatus(name, data['isReturn']),
        reason: typeof situation === 'string' && situation !== '' ? situation : null,
        occurredAt,
        eventKey: eventKeyFor(tracking, name, data['isReturn'], occurredAt),
      },
    ],
  };
}

export const zrExpress: CourierAdapter = {
  id: ID,
  family: 'zr-express',
  displayName: 'ZR Express',
  capabilities: CAPABILITIES,
  confidence: {
    baseUrl: 'probed',
    statusList: 'unofficial',
    notes: ['status_list_tenant_configurable', 'key_expires', 'amount_split_unconfirmed', 'return_rule_inferred', 'state_names_unconfirmed'],
  },
  mapWilaya: toWilaya58,
  prepare,

  async checkCredentials(credentials, ctx) {
    const probe = await post('territories/search', { pageNumber: 1, pageSize: 1 }, credentials, ctx);
    const http = classifyCredentialHttp(probe);
    if (http) return http;
    const body = probe.kind === 'response' ? parseObject(probe.text) : undefined;
    if (!Array.isArray(body?.['items'])) return { kind: 'unavailable', cause: 'malformed_response' };

    const workflows = await post('workflows/search', { pageNumber: 1, pageSize: WORKFLOW_PAGE_SIZE }, credentials, ctx);
    if (workflows.kind !== 'response' || workflows.status !== 200) return { kind: 'valid' };
    const items = parseObject(workflows.text)?.['items'];
    if (!Array.isArray(items)) return { kind: 'valid' };
    const names = new Set<string>();
    for (const workflow of items) {
      const states = asRecord(workflow)?.['states'];
      if (!Array.isArray(states)) continue;
      for (const state of states) {
        const name = normaliseRaw(asRecord(state)?.['name']);
        if (name !== null && !ZR_STATUSES.has(name) && /^[\p{L}\p{N} _.-]{1,80}$/u.test(name)) names.add(name);
      }
    }
    return { kind: 'valid', unlistedStatuses: [...names].slice(0, MAX_UNLISTED) };
  },

  async listWilayas(credentials, ctx) {
    const result = await territoriesOfLevel([equals('level', 'wilaya')], credentials, ctx);
    if (!result.ok) return result;
    const items: CourierWilaya[] = [];
    for (const row of result.items) {
      if (typeof row['code'] === 'number' && typeof row['name'] === 'string' && typeof row['id'] === 'string') {
        const offered = delivery(row);
        items.push({
          id: row['id'],
          code: row['code'],
          name: row['name'],
          deliverable: offered?.['hasHomeDelivery'] === true || offered?.['hasPickupPoint'] === true,
        });
      }
    }
    return { ok: true, items };
  },

  async listCommunes(wilayaCode, credentials, ctx) {
    const parent = await wilayaUuid(wilayaCode, credentials, ctx);
    if (!parent.ok) return parent;
    const result = await territoriesOfLevel([equals('level', 'commune'), equals('parentId', parent.id)], credentials, ctx);
    if (!result.ok) return result;
    const items: CourierCommune[] = [];
    for (const row of result.items) {
      if (typeof row['name'] === 'string' && typeof row['id'] === 'string' && row['parentId'] === parent.id) {
        const offered = delivery(row);
        items.push({
          id: row['id'],
          name: row['name'],
          wilayaCode: parent.code,
          hasStopDesk: offered?.['hasPickupPoint'] === true,
          deliverable: offered?.['hasHomeDelivery'] === true,
        });
      }
    }
    return { ok: true, items };
  },

  async listStopDesks(wilayaCode, credentials, ctx) {
    const parent = await wilayaUuid(wilayaCode, credentials, ctx);
    if (!parent.ok) return parent;
    const result = await collect(
      'hubs/search',
      {
        advancedFilter: {
          logic: 'and',
          filters: [equals('isPickupPoint', true), equals('address.cityTerritoryId', parent.id)],
        },
      },
      credentials,
      ctx,
    );
    if (!result.ok) return result;
    const items: CourierStopDesk[] = [];
    for (const row of result.items) {
      const address = asRecord(row['address']);
      if (typeof row['id'] !== 'string' || typeof row['name'] !== 'string' || row['isPickupPoint'] === false) continue;
      if (address?.['cityTerritoryId'] !== parent.id) continue;
      const district = address['district'];
      const districtId = address['districtTerritoryId'];
      items.push({
        id: row['id'],
        ...(typeof districtId === 'string' ? { communeId: districtId } : {}),
        name: row['name'],
        address: typeof address['street'] === 'string' ? address['street'] : row['name'],
        communeName: typeof district === 'string' ? district : '',
        wilayaCode: parent.code,
        wilayaName: typeof address['city'] === 'string' ? address['city'] : '',
      });
    }
    return { ok: true, items };
  },

  createParcel,
  // `askCollection` has no equivalent here: ready means the courier may collect it.
  validateParcel: (tracking, _options, credentials, ctx) => validateParcel(tracking, credentials, ctx),
  findByReference,
  fetchStatuses,

  async getLabel(tracking, credentials, ctx) {
    if (!isValidTracking(tracking)) return { kind: 'unavailable', cause: 'invalid_tracking' };
    const result = await post('parcels/labels/individual', { trackingNumbers: [tracking] }, credentials, ctx);
    if (result.kind !== 'response' || result.status !== 200) {
      const failure = unavailable(result);
      return { kind: 'unavailable', cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
    }
    const body = parseObject(result.text);
    const failed = body?.['failedTrackingNumbers'];
    if (Array.isArray(failed) && failed.length > 0) return { kind: 'unavailable', cause: 'label_failed' };
    const files = body?.['parcelLabelFiles'];
    const row = Array.isArray(files) ? asRecord(files[0]) : undefined;
    if (row?.['trackingNumber'] !== tracking) return { kind: 'unavailable', cause: 'no_label' };
    const url = safeLabelUrl(row['fileUrl'], LABEL_HOSTS, ctx);
    return url ? { kind: 'url', url } : { kind: 'unavailable', cause: 'no_label' };
  },

  webhookHandshake: () => null,
  verifyWebhook,
  parseWebhook,
};
