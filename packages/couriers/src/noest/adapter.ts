/**
 * NOEST Express (artifacts/delivery-research/noest.md; addendum artifacts/CARR-0/addendum-noest.md).
 * No public docs exist, so everything here is second-hand. There's no list endpoint, so an uncertain
 * create can't be resolved here: it goes to a person. Drafts until validated. No webhooks.
 */
import { normalizePhone } from '@hb/shared/phone';
import {
  classifyCredentialHttp,
  classifyWrite,
  courierBase,
  isValidTracking,
  listFailure,
  parseObject,
  read,
  redact,
  send,
  startDeadline,
  unavailable,
} from '../client.ts';
import { matchCommune } from '../commune.ts';
import { eventKey, parseCourierDate } from '../event.ts';
import { VERIFY_AFTER_SECONDS } from '../resend.ts';
import { mapStatus, normaliseRaw } from '../status.ts';
import { toWilaya58 } from '../wilaya.ts';
import type {
  CourierAdapter,
  CourierCapabilities,
  CourierCommune,
  CourierContext,
  CourierCredentials,
  CourierLists,
  CourierStatus,
  CourierStopDesk,
  CourierWilaya,
  CreateResult,
  ParcelEvent,
  ParcelInput,
  PreparedParcel,
  PrepareResult,
  StatusFetchResult,
  ValidateResult,
} from '../types.ts';
import { NOEST_KEYS, NOEST_LABELS, NOEST_NON_STATUS_EVENTS } from './statuses.ts';

const ID = 'noest';
const MAX_FIELD = 255;
const NOT_FOUND_MESSAGE = 'Trackings non trouvés';
const BAD_GUID_MESSAGE = 'Partenaire introuvable';
const CHECK_TRACKING = 'NST-CHECK-00000000';
const NAMED_REFUSALS: ReadonlySet<string> = new Set([
  'inactive_commune',
  'zip_code',
  'max_amount_exceeded',
  'stopdesk_disabled',
  'station_code',
  'out_of_stock',
  'account_suspended',
]);

const CAPABILITIES: CourierCapabilities = {
  verifyByReference: false,
  verifyAfterSeconds: VERIFY_AFTER_SECONDS,
  verifyWithinSeconds: null,
  needsValidation: true,
  stopDesk: true,
  pollBatchSize: 50,
  minPollSeconds: 300,
  sendPerMinute: 30,
  webhook: 'none',
  needsOriginWilaya: false,
  credentialFields: [
    { key: 'apiToken', secret: true, labelFr: 'Jeton API', labelAr: 'رمز API' },
    { key: 'userGuid', secret: true, labelFr: 'Identifiant utilisateur (GUID)', labelAr: 'معرّف المستخدم (GUID)' },
  ],
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function isJsonArray(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

const api = (ctx: CourierContext) => `${courierBase('https://app.noest-dz.com', ID, ctx)}/api/public`;

function bearer(credentials: CourierCredentials): Record<string, string> {
  return { Authorization: `Bearer ${credentials['apiToken'] ?? ''}`, Accept: 'application/json' };
}

function post(path: string, body: Record<string, unknown>, credentials: CourierCredentials, ctx: CourierContext) {
  return send(
    `${api(ctx)}/${path}`,
    {
      method: 'POST',
      headers: { ...bearer(credentials), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_guid: credentials['userGuid'] ?? '', ...body }),
    },
    ctx,
  );
}

function errorMessage(body: string): unknown {
  const json = parseObject(body);
  return json?.['message'] ?? json?.['error'];
}

function has(errors: Record<string, unknown>, code: string): boolean {
  return Object.entries(errors).some(([key, value]) => key === code || value === code || (Array.isArray(value) && value.includes(code)));
}

function firstErrorText(errors: Record<string, unknown>): unknown {
  const first = Object.values(errors)[0];
  return Array.isArray(first) ? first[0] : first;
}

/** A 422 either names a refusal or lists field errors; anything else proves nothing. */
function classify422(text: string, credentials: CourierCredentials): CreateResult {
  const errors = asRecord(parseObject(text)?.['errors']);
  if (!errors || Object.keys(errors).length === 0) return { kind: 'uncertain', cause: 'malformed_response' };
  if (has(errors, 'duplicate_order')) return { kind: 'uncertain', cause: 'duplicate_reference' };
  const entries = Object.entries(errors);
  const named = entries.every(([key, value]) => NAMED_REFUSALS.has(key) && typeof value === 'string');
  const fields = entries.every(([, value]) => Array.isArray(value));
  if (!named && !fields) return { kind: 'uncertain', cause: 'malformed_response' };
  return { kind: 'rejected', code: 'bad_request', detail: redact(firstErrorText(errors), credentials) || 'refused' };
}

function prepare(input: ParcelInput, lists: CourierLists): PrepareResult {
  if (lists.wilayas.length === 0) {
    return { ok: false, code: 'lists_missing', detail: "The courier's wilaya list is not loaded" };
  }
  const destination = toWilaya58(input.wilayaCode);
  if (!destination.ok) return { ok: false, code: 'wilaya_unmapped', detail: destination.detail };
  const wilaya = lists.wilayas.find((w) => w.code === destination.code);
  if (!wilaya) return { ok: false, code: 'wilaya_unmapped', detail: `The courier has no wilaya ${destination.code}` };
  if (!wilaya.deliverable) return { ok: false, code: 'wilaya_not_deliverable', detail: `The courier does not deliver to ${wilaya.name}` };

  const phone = normalizePhone(input.phone);
  if (!phone.ok) return { ok: false, code: 'phone_invalid', detail: phone.code };
  const name = input.recipientName.trim().replace(/\s+/gu, ' ');
  if (name === '') return { ok: false, code: 'recipient_required', detail: 'The recipient has no name' };
  if (!Number.isInteger(input.codTotalDzd) || input.codTotalDzd < 0) {
    return { ok: false, code: 'amount_out_of_range', detail: 'The amount must be a whole number of DZD' };
  }

  let commune: string;
  let address = input.address?.trim() ?? '';
  let station: Record<string, unknown> = {};

  if (input.deliveryType === 'stop_desk') {
    if (!input.stopDeskId) return { ok: false, code: 'stop_desk_required', detail: 'No stop desk was chosen' };
    const desk = lists.stopDesks.find((d) => d.id === input.stopDeskId);
    if (!desk || desk.wilayaCode !== destination.code) {
      return { ok: false, code: 'stop_desk_mismatch', detail: 'This stop desk is not in the order wilaya' };
    }
    commune = desk.communeName;
    address ||= desk.address;
    station = { stop_desk: 1, station_code: desk.id };
  } else {
    if (address === '') return { ok: false, code: 'address_required', detail: 'A home delivery needs an address' };
    const communes = lists.communes.filter((c) => c.wilayaCode === destination.code);
    if (communes.length === 0) return { ok: false, code: 'lists_missing', detail: "The courier's commune list is not loaded" };
    const match = matchCommune(input.commune, communes);
    if (!match.ok) return { ok: false, code: match.code, detail: match.detail };
    commune = match.commune.name;
  }
  if (address.length > MAX_FIELD) return { ok: false, code: 'address_required', detail: `The address is over ${MAX_FIELD} characters` };

  return {
    ok: true,
    parcel: {
      courier: ID,
      reference: input.reference,
      payload: {
        client: name.slice(0, MAX_FIELD),
        phone: phone.national,
        adresse: address,
        wilaya_id: destination.code,
        commune,
        // The amount collected, delivery included.
        montant: input.codTotalDzd,
        produit: (input.productLabel.trim() || input.reference).slice(0, MAX_FIELD),
        type_id: 1,
        reference: input.reference,
        ...station,
      },
    },
  };
}

async function createParcel(parcel: PreparedParcel, credentials: CourierCredentials, ctx: CourierContext): Promise<CreateResult> {
  if (parcel.courier !== ID) return { kind: 'rejected', code: 'wrong_courier', detail: 'Prepared for another courier' };
  const result = await post('create/order', { ...parcel.payload }, credentials, ctx);
  if (result.kind === 'response' && result.status === 422) return classify422(result.text, credentials);
  const classified = classifyWrite(result, errorMessage, credentials);
  if ('done' in classified) return classified.done;

  const json = parseObject(classified.body);
  if (!json) return { kind: 'uncertain', cause: 'malformed_response' };
  // The only sampled refusal says the parcel already exists, with no code to tell it apart.
  if (json['success'] === false) return { kind: 'uncertain', cause: 'refused_no_code' };
  const reference = json['reference'];
  const ours = reference === undefined || reference === null || reference === parcel.reference;
  if (json['success'] === true && ours && isValidTracking(json['tracking'])) {
    return { kind: 'accepted', tracking: json['tracking'], draft: true };
  }
  return { kind: 'uncertain', cause: 'malformed_response' };
}

async function validateParcel(tracking: string, credentials: CourierCredentials, ctx: CourierContext): Promise<ValidateResult> {
  if (!isValidTracking(tracking)) return { kind: 'rejected', code: 'bad_request', detail: 'Invalid tracking' };
  const result = await post('valid/order', { tracking }, credentials, ctx);
  if (result.kind === 'response' && result.status === 422) {
    const errors = asRecord(parseObject(result.text)?.['errors']);
    if (errors && has(errors, 'already_validated')) {
      return { kind: 'rejected', code: 'locked', detail: 'NOEST says this parcel is already validated' };
    }
  }
  const classified = classifyWrite(result, errorMessage, credentials);
  if ('done' in classified) return classified.done;
  const json = parseObject(classified.body);
  if (json?.['success'] === true) return { kind: 'validated' };
  if (json?.['success'] === false) {
    return { kind: 'rejected', code: 'courier_refused', detail: redact(json['message'], credentials) || 'refused' };
  }
  return { kind: 'uncertain', cause: 'malformed_response' };
}

interface Latest {
  readonly raw: string;
  readonly status: CourierStatus;
  readonly at: number;
}

/** Latest status row by date; the later row wins a tie. Remarks are skipped entirely. */
function latestStatus(activity: readonly unknown[]): { latest: Latest | null; badRows: number } {
  let latest: Latest | null = null;
  let badRows = 0;
  for (const raw of activity) {
    const row = asRecord(raw);
    const key = normaliseRaw(row?.['event_key']);
    const label = normaliseRaw(row?.['event']);
    if ((key !== null && NOEST_NON_STATUS_EVENTS.has(key)) || (key === null && label === null)) continue;
    const at = parseCourierDate(row?.['date']);
    if (at === null) {
      badRows += 1;
      continue;
    }
    if (latest === null || at >= latest.at) {
      latest = key !== null ? { raw: key, status: mapStatus(NOEST_KEYS, key), at } : { raw: label as string, status: mapStatus(NOEST_LABELS, label), at };
    }
  }
  return { latest, badRows };
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

  const result = await post('get/trackings/info', { trackings: valid }, credentials, ctx);
  if (result.kind === 'response' && result.status === 404 && parseObject(result.text)?.['message'] === NOT_FOUND_MESSAGE) {
    // A batch answer may mean any one of them is unknown, so only a single tracking is conclusive.
    return valid.length === 1 ? { ok: true, events: [], absent: valid, invalid, badRows: 0 } : { ok: false, cause: 'batch_not_found' };
  }
  if (result.kind !== 'response' || result.status !== 200) {
    const failure = unavailable(result);
    return { ok: false, cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
  }
  const body = parseObject(result.text);
  if (!body) return { ok: false, cause: 'malformed_response' };

  const wanted = new Set(valid);
  const seen = new Set<string>();
  const events: ParcelEvent[] = [];
  let badRows = 0;
  for (const [tracking, raw] of Object.entries(body)) {
    const row = asRecord(raw);
    if (!row || !wanted.has(tracking) || !Array.isArray(row['activity'])) {
      badRows += 1;
      continue;
    }
    seen.add(tracking);
    const { latest, badRows: bad } = latestStatus(row['activity']);
    badRows += bad;
    // No rows yet (a draft has none): the courier knows the parcel, there's just nothing to report.
    if (latest !== null) {
      events.push({
        tracking,
        rawStatus: latest.raw,
        status: latest.status,
        reason: null,
        occurredAt: latest.at,
        eventKey: eventKey(tracking, latest.raw, { occurredAt: latest.at }),
      });
    }
  }
  return { ok: true, events, absent: valid.filter((t) => !seen.has(t)), invalid, badRows };
}

export const noest: CourierAdapter = {
  id: ID,
  family: 'noest',
  displayName: 'NOEST Express',
  capabilities: CAPABILITIES,
  confidence: {
    baseUrl: 'probed',
    statusList: 'unofficial',
    notes: ['docs_private_pdf', 'status_meanings_inferred', 'status_french_labels_unmapped', 'no_lookup_by_reference', 'return_received_inferred', 'label_call_unconfirmed'],
  },
  mapWilaya: toWilaya58,
  prepare,

  async checkCredentials(credentials, ctx) {
    const wilayas = await read(`${api(ctx)}/get/wilayas`, bearer(credentials), ctx, startDeadline(ctx));
    const http = classifyCredentialHttp(wilayas);
    if (http) return http;
    if (wilayas.kind !== 'response' || !isJsonArray(wilayas.text)) {
      return { kind: 'unavailable', cause: 'malformed_response' };
    }
    // The wilaya list ignores the GUID, and a swapped GUID is a common mistake.
    const probe = await post('get/trackings/info', { trackings: [CHECK_TRACKING] }, credentials, ctx);
    if (probe.kind === 'response' && probe.status === 404) {
      const message = parseObject(probe.text)?.['message'];
      if (message === BAD_GUID_MESSAGE) return { kind: 'invalid', detail: BAD_GUID_MESSAGE };
      if (message === NOT_FOUND_MESSAGE) return { kind: 'valid' };
    }
    if (probe.kind === 'response' && probe.status === 429) return classifyCredentialHttp(probe) ?? { kind: 'rate_limited' };
    return { kind: 'unavailable', cause: 'credential_check_inconclusive' };
  },

  async listWilayas(credentials, ctx) {
    const result = await read(`${api(ctx)}/get/wilayas`, bearer(credentials), ctx, startDeadline(ctx));
    if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
    let rows: unknown;
    try {
      rows = JSON.parse(result.text);
    } catch {
      return { ok: false, cause: 'malformed_response' };
    }
    if (!Array.isArray(rows)) return { ok: false, cause: 'malformed_response' };
    const items: CourierWilaya[] = [];
    for (const raw of rows) {
      const row = asRecord(raw);
      if (typeof row?.['code'] === 'number' && typeof row['nom'] === 'string') {
        items.push({ code: row['code'], name: row['nom'], deliverable: row['is_active'] === 1 || row['is_active'] === true });
      }
    }
    return { ok: true, items };
  },

  async listCommunes(wilayaCode, credentials, ctx) {
    const mapped = toWilaya58(wilayaCode);
    if (!mapped.ok) return { ok: false, cause: mapped.code };
    const result = await read(`${api(ctx)}/get/communes/${mapped.code}`, bearer(credentials), ctx, startDeadline(ctx));
    if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
    let rows: unknown;
    try {
      rows = JSON.parse(result.text);
    } catch {
      return { ok: false, cause: 'malformed_response' };
    }
    if (!Array.isArray(rows)) return { ok: false, cause: 'malformed_response' };
    const items: CourierCommune[] = [];
    for (const raw of rows) {
      const row = asRecord(raw);
      if (typeof row?.['nom'] === 'string' && Number(row['wilaya_id']) === mapped.code) {
        items.push({ name: row['nom'], wilayaCode: mapped.code, hasStopDesk: false, deliverable: row['is_active'] === 1 || row['is_active'] === true });
      }
    }
    return { ok: true, items };
  },

  async listStopDesks(wilayaCode, credentials, ctx) {
    const mapped = toWilaya58(wilayaCode);
    if (!mapped.ok) return { ok: false, cause: mapped.code };
    const result = await read(`${api(ctx)}/desks`, bearer(credentials), ctx, startDeadline(ctx));
    if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
    const body = parseObject(result.text);
    if (!body) return { ok: false, cause: 'malformed_response' };
    const items: CourierStopDesk[] = [];
    for (const raw of Object.values(body)) {
      const row = asRecord(raw);
      const code = row?.['code'];
      if (!row || typeof code !== 'string' || typeof row['name'] !== 'string') continue;
      // The code starts with the wilaya number, with no leading zero: 16A, 1A.
      const digits = /^(\d{1,2})[A-Za-z]/.exec(code)?.[1];
      if (digits === undefined || Number(digits) !== mapped.code) continue;
      items.push({
        id: code,
        name: row['name'],
        address: typeof row['address'] === 'string' ? row['address'] : row['name'],
        communeName: typeof row['commune'] === 'string' ? row['commune'] : row['name'],
        wilayaCode: mapped.code,
        wilayaName: '',
      });
    }
    return { ok: true, items };
  },

  createParcel,
  validateParcel: (tracking, _options, credentials, ctx) => validateParcel(tracking, credentials, ctx),
  async findByReference() {
    return { kind: 'unavailable', cause: 'unsupported' };
  },
  fetchStatuses,

  async getLabel(tracking, credentials, ctx) {
    if (!isValidTracking(tracking)) return { kind: 'unavailable', cause: 'invalid_tracking' };
    const params = new URLSearchParams({ tracking });
    const result = await read(`${api(ctx)}/get/order/label?${params.toString()}`, bearer(credentials), ctx, startDeadline(ctx));
    if (result.kind !== 'response' || result.status !== 200) {
      const failure = unavailable(result);
      return { kind: 'unavailable', cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
    }
    const pdf = new TextDecoder().decode(result.bytes.slice(0, 5)) === '%PDF-';
    return pdf ? { kind: 'pdf', bytes: result.bytes, contentType: 'application/pdf' } : { kind: 'unavailable', cause: 'not_pdf' };
  },

  webhookHandshake: () => null,
  async verifyWebhook() {
    return { ok: false, reason: 'missing_signature' };
  },
  parseWebhook: () => ({ ok: false, reason: 'malformed' }),
};
