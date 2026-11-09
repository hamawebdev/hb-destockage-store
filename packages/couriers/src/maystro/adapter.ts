/**
 * Maystro Delivery (artifacts/delivery-research/maystro.md; addendum artifacts/CARR-0/addendum-maystro.md).
 * Hosts conflict across the docs: this uses the pair that dz-delivery checked live together. Polling
 * only, because Maystro's webhooks are unsigned.
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
  ParcelEvent,
  ParcelInput,
  PreparedParcel,
  PrepareResult,
  StatusFetchResult,
} from '../types.ts';
import { maystroCode, maystroStatus } from './statuses.ts';

const ID = 'maystro';
const POSSIBLE_DUPLICATE = 55;
const REFUSED_CODES: ReadonlySet<number> = new Set([10, 20, 30, 40, 45, 50, 51, 70, 80, 90, 100, 101]);

const CAPABILITIES: CourierCapabilities = {
  verifyByReference: false,
  verifyAfterSeconds: VERIFY_AFTER_SECONDS,
  verifyWithinSeconds: null,
  needsValidation: false,
  stopDesk: true,
  pollBatchSize: 5,
  minPollSeconds: 600,
  sendPerMinute: 20,
  webhook: 'none',
  needsOriginWilaya: false,
  credentialFields: [{ key: 'storeToken', secret: true, labelFr: 'Jeton de la boutique', labelAr: 'رمز المتجر' }],
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function headers(credentials: CourierCredentials): Record<string, string> {
  return { Authorization: `Token ${credentials['storeToken'] ?? ''}`, Accept: 'application/json' };
}

const orders = (ctx: CourierContext) => courierBase('https://orders-management.maystro-delivery.com', `${ID}/orders-management`, ctx);
const backend = (ctx: CourierContext) => courierBase('https://backend.maystro-delivery.com', `${ID}/backend`, ctx);

function errorMessage(body: string): unknown {
  return parseObject(body)?.['detail'];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function prepare(input: ParcelInput, lists: CourierLists): PrepareResult {
  if (lists.wilayas.length === 0) {
    return { ok: false, code: 'lists_missing', detail: "The courier's wilaya list is not loaded" };
  }
  const destination = toWilaya58(input.wilayaCode);
  if (!destination.ok) return { ok: false, code: 'wilaya_unmapped', detail: destination.detail };
  const wilaya = lists.wilayas.find((w) => w.code === destination.code);
  // Maystro serves about 50 wilayas; the list holds only those.
  if (!wilaya) return { ok: false, code: 'wilaya_not_deliverable', detail: `Maystro does not deliver to wilaya ${destination.code}` };

  const phone = normalizePhone(input.phone);
  if (!phone.ok) return { ok: false, code: 'phone_invalid', detail: phone.code };

  const name = input.recipientName.trim().replace(/\s+/gu, ' ');
  if (name === '') return { ok: false, code: 'recipient_required', detail: 'The recipient has no name' };

  if (!Number.isInteger(input.codTotalDzd) || input.codTotalDzd < 0) {
    return { ok: false, code: 'amount_out_of_range', detail: 'The amount must be a whole number of DZD' };
  }

  let communeId: number;
  let address = input.address?.trim() ?? '';

  if (input.deliveryType === 'stop_desk') {
    if (!input.stopDeskId) return { ok: false, code: 'stop_desk_required', detail: 'No stop desk was chosen' };
    const desk = lists.stopDesks.find((d) => d.id === input.stopDeskId);
    if (!desk || desk.wilayaCode !== destination.code) {
      return { ok: false, code: 'stop_desk_mismatch', detail: 'This stop desk is not in the order wilaya' };
    }
    communeId = Number(desk.id);
    address ||= desk.address;
  } else {
    if (address === '') return { ok: false, code: 'address_required', detail: 'A home delivery needs an address' };
    const communes = lists.communes.filter((c) => c.wilayaCode === destination.code);
    if (communes.length === 0) return { ok: false, code: 'lists_missing', detail: "The courier's commune list is not loaded" };
    const match = matchCommune(input.commune, communes);
    if (!match.ok) return { ok: false, code: match.code, detail: match.detail };
    communeId = Number(match.commune.id);
  }
  if (!Number.isSafeInteger(communeId)) return { ok: false, code: 'commune_unmapped', detail: 'The courier gave this commune no id' };

  return {
    ok: true,
    parcel: {
      courier: ID,
      reference: input.reference,
      payload: {
        customer_name: name,
        customer_phone: phone.national,
        destination_text: address,
        // Sent as the name, the form checked live; the docs say integer code.
        wilaya: wilaya.name,
        commune: communeId,
        details: [{ product: '', description: input.productLabel.trim() || input.reference, quantity: 1 }],
        // Includes delivery, so the customer pays the total once.
        total_price: input.codTotalDzd,
        delivery_type: input.deliveryType === 'stop_desk' ? 2 : 1,
        external_id: input.reference,
      },
    },
  };
}

function codesOf(errors: unknown): number[] | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const codes: number[] = [];
  for (const entry of errors) {
    const code = typeof entry === 'number' ? entry : asRecord(entry)?.['code'];
    if (typeof code !== 'number' || !Number.isInteger(code)) return null;
    codes.push(code);
  }
  return codes;
}

function messageOf(errors: unknown): unknown {
  return Array.isArray(errors) ? asRecord(errors[0])?.['message'] : undefined;
}

function parseCreated(body: string, reference: string, credentials: CourierCredentials): CreateResult {
  const rows = parseJson(body);
  if (!Array.isArray(rows) || rows.length !== 1) return { kind: 'uncertain', cause: 'malformed_response' };
  const row = asRecord(rows[0]);
  if (!row) return { kind: 'uncertain', cause: 'malformed_response' };
  const external = row['external_id'];
  if (external !== null && external !== undefined && external !== reference) return { kind: 'uncertain', cause: 'malformed_response' };

  if (row['success'] === true && isValidTracking(row['tracking'])) {
    return { kind: 'accepted', tracking: row['tracking'], draft: false };
  }
  if (row['success'] !== false || (row['tracking'] !== null && row['tracking'] !== undefined)) {
    return { kind: 'uncertain', cause: 'malformed_response' };
  }
  const codes = codesOf(row['errors']);
  if (codes === null) return { kind: 'uncertain', cause: 'malformed_response' };
  // Same name and phone within a day: a retry after a timeout, or a real second order.
  if (codes.includes(POSSIBLE_DUPLICATE)) return { kind: 'uncertain', cause: 'possible_duplicate' };
  if (codes.every((code) => REFUSED_CODES.has(code))) {
    return { kind: 'rejected', code: 'courier_refused', detail: redact(messageOf(row['errors']), credentials) || `Maystro error ${codes[0]}` };
  }
  return { kind: 'uncertain', cause: 'malformed_response' };
}

async function createParcel(parcel: PreparedParcel, credentials: CourierCredentials, ctx: CourierContext): Promise<CreateResult> {
  if (parcel.courier !== ID) return { kind: 'rejected', code: 'wrong_courier', detail: 'Prepared for another courier' };
  const result = await send(
    `${orders(ctx)}/api/orders/`,
    { method: 'POST', headers: { ...headers(credentials), 'Content-Type': 'application/json' }, body: JSON.stringify([parcel.payload]) },
    ctx,
  );
  const classified = classifyWrite(result, errorMessage, credentials);
  return 'done' in classified ? classified.done : parseCreated(classified.body, parcel.reference, credentials);
}

function eventFromRow(row: Record<string, unknown>, tracking: string): ParcelEvent | null {
  const status = row['status'];
  if (status === undefined || status === null) return null;
  const rawStatus = maystroCode(status) ?? (typeof status === 'object' ? JSON.stringify(status) : String(status));
  const reason = row['alert_reason'] || row['abort_reason'];
  return {
    tracking,
    rawStatus,
    status: maystroStatus(status),
    reason: typeof reason === 'string' ? reason : null,
    occurredAt: parseCourierDate(row['updated_at']),
    // Not updated_at: it moves on any edit to the order, while the status stays the same.
    eventKey: eventKey(tracking, rawStatus, { occurredAt: null }),
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

  const deadline = startDeadline(ctx);
  const events: ParcelEvent[] = [];
  const absent: string[] = [];
  let badRows = 0;
  for (const tracking of valid) {
    const params = new URLSearchParams({ display_id: tracking });
    const result = await read(`${backend(ctx)}/api/stores/orders/?${params.toString()}`, headers(credentials), ctx, deadline);
    if (result.kind !== 'response' || result.status !== 200) {
      const failure = unavailable(result);
      return { ok: false, cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
    }
    const list = asRecord(parseObject(result.text)?.['list']);
    const rows = list?.['results'];
    if (!list || !Array.isArray(rows) || typeof list['count'] !== 'number') return { ok: false, cause: 'malformed_response' };
    if (list['count'] === 0 && rows.length === 0) {
      absent.push(tracking);
      continue;
    }
    const row = rows.length === 1 ? asRecord(rows[0]) : undefined;
    const event = row && String(row['display_id']) === tracking ? eventFromRow(row, tracking) : null;
    if (event === null) badRows += 1;
    else events.push(event);
  }
  return { ok: true, events, absent, invalid, badRows };
}

async function listCommunes(
  wilayaCode: number,
  credentials: CourierCredentials,
  ctx: CourierContext,
): Promise<ListResult<CourierCommune>> {
  const mapped = toWilaya58(wilayaCode);
  if (!mapped.ok) return { ok: false, cause: mapped.code };
  const result = await read(`${orders(ctx)}/api/base/communes/?wilaya=${mapped.code}`, headers(credentials), ctx, startDeadline(ctx));
  if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
  const rows = parseJson(result.text);
  if (!Array.isArray(rows)) return { ok: false, cause: 'malformed_response' };
  const items: CourierCommune[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (row && typeof row['name'] === 'string' && typeof row['id'] === 'number' && Number(row['wilaya']) === mapped.code) {
      items.push({ id: String(row['id']), name: row['name'], wilayaCode: mapped.code, hasStopDesk: true, deliverable: true });
    }
  }
  return { ok: true, items };
}

export const maystro: CourierAdapter = {
  id: ID,
  family: 'maystro',
  displayName: 'Maystro Delivery',
  capabilities: CAPABILITIES,
  confidence: {
    baseUrl: 'probed',
    statusList: 'official',
    notes: [
      'hosts_conflict_in_docs',
      'wilaya_field_conflict',
      'no_lookup_by_reference',
      'stop_desk_is_commune_level',
      'webhooks_not_used',
      'error_codes_partly_undocumented',
      'starter_store_flow_unconfirmed',
    ],
  },
  mapWilaya: toWilaya58,
  prepare,

  async checkCredentials(credentials, ctx) {
    const result = await read(`${backend(ctx)}/api/stores/orders/?page=1`, headers(credentials), ctx, startDeadline(ctx));
    const http = classifyCredentialHttp(result);
    if (http) return http;
    const body = result.kind === 'response' ? parseObject(result.text) : undefined;
    return asRecord(body?.['list']) ? { kind: 'valid' } : { kind: 'unavailable', cause: 'malformed_response' };
  },

  async listWilayas(credentials, ctx) {
    const result = await read(`${orders(ctx)}/api/base/wilayas/?language=fr&country=1`, headers(credentials), ctx, startDeadline(ctx));
    if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
    const rows = parseJson(result.text);
    if (!Array.isArray(rows)) return { ok: false, cause: 'malformed_response' };
    const items: CourierWilaya[] = [];
    for (const raw of rows) {
      // Two shapes are in use: [id, name] tuples and objects.
      const row = asRecord(raw);
      // The list spans countries (2 is Tunisia), and a code alone doesn't tell them apart.
      if (row && row['country'] !== undefined && row['country'] !== 1) continue;
      const code = Array.isArray(raw) ? raw[0] : row?.['code'];
      const name = Array.isArray(raw) ? raw[1] : row?.['name_lt'];
      if (typeof code === 'number' && typeof name === 'string') items.push({ code, name, deliverable: true });
    }
    return { ok: true, items };
  },

  listCommunes,

  async listStopDesks(wilayaCode, credentials, ctx): Promise<ListResult<CourierStopDesk>> {
    // A stop-desk delivery has no desk id here: it names the commune.
    const communes = await listCommunes(wilayaCode, credentials, ctx);
    if (!communes.ok) return communes;
    return {
      ok: true,
      items: communes.items.map((commune) => ({
        id: commune.id as string,
        name: commune.name,
        address: commune.name,
        communeName: commune.name,
        wilayaCode: commune.wilayaCode,
        wilayaName: '',
      })),
    };
  },

  createParcel,
  async validateParcel() {
    // No draft step: a created order is live.
    return { kind: 'validated' };
  },
  async findByReference() {
    return { kind: 'unavailable', cause: 'unsupported' };
  },
  fetchStatuses,

  async getLabel(tracking, credentials, ctx) {
    if (!isValidTracking(tracking)) return { kind: 'unavailable', cause: 'invalid_tracking' };
    const result = await send(
      `${backend(ctx)}/api/delivery/starter/starter_bordureau/`,
      {
        method: 'POST',
        // `application/pdf` gets a 406 from this endpoint.
        headers: { ...headers(credentials), Accept: '*/*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders_ids: [tracking] }),
      },
      ctx,
    );
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
