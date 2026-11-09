/**
 * The EcoTrack family: one white-label API, one host per courier (artifacts/delivery-research/ecotrack.md,
 * from the official Postman docs). Parcels stay drafts until `validateParcel`. No webhooks: polling only.
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
  send,
  startDeadline,
  unavailable,
} from '../client.ts';
import { matchCommune } from '../commune.ts';
import { eventKey, parseCourierDate } from '../event.ts';
import { SCAN_VERIFY_WITHIN_SECONDS, VERIFY_AFTER_SECONDS } from '../resend.ts';
import { mapStatus, normaliseRaw } from '../status.ts';
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
} from '../types.ts';
import { ECOTRACK_GONE, ECOTRACK_SLUGS } from './statuses.ts';
import { ECOTRACK_TENANTS, type EcotrackTenant } from './tenants.ts';

const MAX_SCAN_PAGES = 30;
const MAX_FIELD = 255;
const DAY_MS = 86_400_000;
const ALGERIA_OFFSET_MS = 3_600_000;
const ERROR_LOCKED = 10001;

const CAPABILITIES: CourierCapabilities = {
  verifyByReference: true,
  verifyAfterSeconds: VERIFY_AFTER_SECONDS,
  verifyWithinSeconds: SCAN_VERIFY_WITHIN_SECONDS,
  needsValidation: true,
  stopDesk: true,
  pollBatchSize: 100,
  minPollSeconds: 300,
  sendPerMinute: 50,
  webhook: 'none',
  needsOriginWilaya: false,
  credentialFields: [{ key: 'apiToken', secret: true, labelFr: 'Jeton API', labelAr: 'رمز API' }],
};

const NOTES = ['merchant_must_confirm_url', 'stop_desk_selection_unconfirmed', 'draft_listing_unknown', 'status_meanings_inferred'];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const token = (credentials: CourierCredentials) => credentials['apiToken'] ?? '';

function authHeaders(credentials: CourierCredentials): Record<string, string> {
  return { Authorization: `Bearer ${token(credentials)}`, Accept: 'application/json' };
}

function errorMessage(body: string): unknown {
  const json = parseObject(body);
  if (!json) return undefined;
  const errors = asRecord(json['errors']);
  if (errors) {
    const first = Object.values(errors).flat()[0];
    if (typeof first === 'string') return first;
  }
  return json['message'];
}

/** The tracking from any documented nesting. More than one distinct value is a contradiction. */
function trackingFrom(json: Record<string, unknown>): { readonly tracking: unknown; readonly conflict: boolean } {
  const data = asRecord(json['data']);
  const candidates = [json['tracking'], data?.['tracking'], asRecord(json['order'])?.['tracking'], asRecord(data?.['order'])?.['tracking']].filter(
    (value) => value !== undefined && value !== null,
  );
  return { tracking: candidates[0], conflict: new Set(candidates).size > 1 };
}

function parseCommunes(body: unknown): Array<Record<string, unknown>> | null {
  const rows = Array.isArray(body) ? body : asRecord(body) ? Object.values(asRecord(body) as object) : null;
  return rows === null ? null : rows.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined);
}

const dateInAlgeria = (at: number): string => new Date(at + ALGERIA_OFFSET_MS).toISOString().slice(0, 10);

function createTenantAdapter(tenant: EcotrackTenant): CourierAdapter {
  const id = `ecotrack-${tenant.slug}`;
  const api = (ctx: CourierContext) => `${courierBase(`https://${tenant.host}`, id, ctx)}/api/v1`;

  function prepare(input: ParcelInput, lists: CourierLists): PrepareResult {
    if (lists.wilayas.length === 0) {
      return { ok: false, code: 'lists_missing', detail: "The courier's wilaya list is not loaded" };
    }
    const destination = toWilaya58(input.wilayaCode);
    if (!destination.ok) return { ok: false, code: 'wilaya_unmapped', detail: destination.detail };
    // This list holds only what the tenant delivers to, so absence means no delivery there.
    const wilaya = lists.wilayas.find((w) => w.code === destination.code);
    if (!wilaya || !wilaya.deliverable) {
      return { ok: false, code: 'wilaya_not_deliverable', detail: `This courier does not deliver to wilaya ${destination.code}` };
    }

    const phone = normalizePhone(input.phone);
    if (!phone.ok) return { ok: false, code: 'phone_invalid', detail: phone.code };

    const name = input.recipientName.trim().replace(/\s+/gu, ' ');
    if (name === '') return { ok: false, code: 'recipient_required', detail: 'The recipient has no name' };

    if (!Number.isInteger(input.codTotalDzd) || input.codTotalDzd < 0) {
      return { ok: false, code: 'amount_out_of_range', detail: 'The amount must be a whole number of DZD' };
    }

    let commune: string;
    let address: string;
    let postal: Record<string, string> = {};

    if (input.deliveryType === 'stop_desk') {
      if (!input.stopDeskId) return { ok: false, code: 'stop_desk_required', detail: 'No stop desk was chosen' };
      const desk = lists.stopDesks.find((d) => d.id === input.stopDeskId);
      if (!desk || desk.wilayaCode !== destination.code) {
        return { ok: false, code: 'stop_desk_mismatch', detail: 'This stop desk is not in the order wilaya' };
      }
      commune = desk.communeName;
      address = input.address?.trim() || desk.address;
      // Probable, not documented: dz-delivery sends the commune's postal code as the desk code.
      postal = { code_postal: desk.id };
    } else {
      address = input.address?.trim() ?? '';
      if (address === '') return { ok: false, code: 'address_required', detail: 'A home delivery needs an address' };
      const communes = lists.communes.filter((c) => c.wilayaCode === destination.code);
      if (communes.length === 0) {
        return { ok: false, code: 'lists_missing', detail: "The courier's commune list is not loaded" };
      }
      const match = matchCommune(input.commune, communes);
      if (!match.ok) return { ok: false, code: match.code, detail: match.detail };
      commune = match.commune.name;
    }
    if (address.length > MAX_FIELD) {
      return { ok: false, code: 'address_required', detail: `The address is over ${MAX_FIELD} characters` };
    }

    return {
      ok: true,
      parcel: {
        courier: id,
        reference: input.reference,
        payload: {
          reference: input.reference,
          nom_client: name.slice(0, MAX_FIELD),
          telephone: phone.national,
          adresse: address,
          commune,
          code_wilaya: String(destination.code),
          // Documented as including the delivery fee, so the customer pays the total once.
          montant: String(input.codTotalDzd),
          produit: (input.productLabel.trim() || input.reference).slice(0, MAX_FIELD),
          // We hold our own stock.
          stock: '0',
          type: '1',
          stop_desk: input.deliveryType === 'stop_desk' ? '1' : '0',
          ...postal,
        },
      },
    };
  }

  async function createParcel(parcel: PreparedParcel, credentials: CourierCredentials, ctx: CourierContext): Promise<CreateResult> {
    if (parcel.courier !== id) return { kind: 'rejected', code: 'wrong_courier', detail: 'Prepared for another courier' };
    const query = new URLSearchParams(parcel.payload as Record<string, string>);
    const result = await send(`${api(ctx)}/create/order?${query.toString()}`, { method: 'POST', headers: authHeaders(credentials) }, ctx);
    const classified = classifyWrite(result, errorMessage, credentials);
    if ('done' in classified) return classified.done;

    const json = parseObject(classified.body);
    if (!json) return { kind: 'uncertain', cause: 'malformed_response' };
    const { tracking, conflict } = trackingFrom(json);
    if (conflict) return { kind: 'uncertain', cause: 'malformed_response' };
    if (json['success'] === true && isValidTracking(tracking)) return { kind: 'accepted', tracking, draft: true };
    if (json['success'] === false && tracking === undefined) {
      return { kind: 'rejected', code: 'courier_refused', detail: refusal(classified.body, credentials) };
    }
    return { kind: 'uncertain', cause: 'malformed_response' };
  }

  function refusal(body: string, credentials: CourierCredentials): string {
    const classified = classifyWrite(
      { kind: 'response', status: 400, text: body, bytes: new Uint8Array(0), headers: new Headers(), retryAfterMs: null },
      errorMessage,
      credentials,
    );
    return 'done' in classified && classified.done.kind === 'rejected' ? classified.done.detail : 'refused';
  }

  async function validateParcel(
    tracking: string,
    options: { readonly askCollection: boolean },
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<ValidateResult> {
    if (!isValidTracking(tracking)) return { kind: 'rejected', code: 'bad_request', detail: 'Invalid tracking' };
    const query = new URLSearchParams({ tracking, ask_collection: options.askCollection ? '1' : '0' });
    const result = await send(`${api(ctx)}/valid/order?${query.toString()}`, { method: 'POST', headers: authHeaders(credentials) }, ctx);

    // Whatever the status: on this tracking, 10001 means it can no longer be changed.
    if (result.kind === 'response' && parseObject(result.text)?.['error'] === ERROR_LOCKED) {
      return { kind: 'rejected', code: 'locked', detail: 'The courier says this parcel can no longer be changed' };
    }
    const classified = classifyWrite(result, errorMessage, credentials);
    if ('done' in classified) return classified.done;
    const json = parseObject(classified.body);
    if (json?.['success'] === true) return { kind: 'validated' };
    if (json?.['success'] === false) {
      return { kind: 'rejected', code: 'courier_refused', detail: refusal(classified.body, credentials) };
    }
    return { kind: 'uncertain', cause: 'malformed_response' };
  }

  async function findByReference(
    reference: string,
    options: { readonly attemptedAt: number },
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<LookupResult> {
    if (!Number.isFinite(options?.attemptedAt)) return { kind: 'unavailable', cause: 'attempted_at_missing' };
    // `created_at` is a bare date with no documented time zone, hence a day either side.
    const start = dateInAlgeria(options.attemptedAt - DAY_MS);
    const end = dateInAlgeria(options.attemptedAt + DAY_MS);
    const deadline = startDeadline(ctx);

    const exact: Array<Record<string, unknown>> = [];
    let lastPage: number | undefined;
    for (let page = 1; ; page += 1) {
      if (page > MAX_SCAN_PAGES) return { kind: 'unavailable', cause: 'too_many_pages' };
      const params = new URLSearchParams({ page: String(page), start_date: start, end_date: end });
      const result = await read(`${api(ctx)}/get/orders?${params.toString()}`, authHeaders(credentials), ctx, deadline);
      if (result.kind !== 'response' || result.status !== 200) return unavailable(result);
      const body = parseObject(result.text);
      const rows = body?.['data'];
      const reportedLast = body?.['last_page'];
      if (!body || !Array.isArray(rows) || body['current_page'] !== page || !Number.isInteger(reportedLast) || (reportedLast as number) < 1) {
        return { kind: 'unavailable', cause: 'malformed_response' };
      }
      if (lastPage !== undefined && reportedLast !== lastPage) return { kind: 'unavailable', cause: 'inconsistent_pages' };
      lastPage = reportedLast as number;

      for (const raw of rows) {
        const row = asRecord(raw);
        if (!row || !Object.hasOwn(row, 'reference')) return { kind: 'unavailable', cause: 'malformed_response' };
        if (row['reference'] === reference) exact.push(row);
      }
      if (page >= lastPage) break;
    }

    const first = exact[0];
    if (first === undefined) return { kind: 'not_found', checkedAt: (ctx.now ?? Date.now)() };
    if (exact.length > 1) {
      return { kind: 'multiple', trackings: exact.map((row) => String(row['tracking'])) };
    }
    if (!isValidTracking(first['tracking'])) return { kind: 'unavailable', cause: 'malformed_response' };
    const rawStatus = typeof first['status'] === 'string' ? first['status'] : '';
    return {
      kind: 'found',
      tracking: first['tracking'],
      rawStatus,
      status: mapStatus(ECOTRACK_SLUGS, rawStatus),
      gone: ECOTRACK_GONE.has(normaliseRaw(rawStatus) ?? ''),
    };
  }

  /** Latest activity by date and time, never array position. For display only. */
  function latestActivity(activity: unknown): { occurredAt: number | null; reason: string | null } {
    let occurredAt: number | null = null;
    let reason: string | null = null;
    if (!Array.isArray(activity)) return { occurredAt, reason };
    for (const raw of activity) {
      const row = asRecord(raw);
      const at = parseCourierDate(`${String(row?.['date'])} ${String(row?.['time'])}`);
      if (at !== null && (occurredAt === null || at >= occurredAt)) {
        occurredAt = at;
        reason = typeof row?.['reason'] === 'string' && row['reason'] !== '' ? row['reason'] : null;
      }
    }
    return { occurredAt, reason };
  }

  function eventFromRow(tracking: string, row: Record<string, unknown>): ParcelEvent | null {
    const rawStatus = row['status'];
    if (normaliseRaw(rawStatus) === null) return null;
    const { occurredAt, reason } = latestActivity(row['activity']);
    return {
      tracking,
      rawStatus: rawStatus as string,
      status: mapStatus(ECOTRACK_SLUGS, rawStatus),
      reason,
      occurredAt,
      // Not the activity time: activity rows include remarks, so it changes while the status doesn't.
      eventKey: eventKey(tracking, rawStatus as string, { occurredAt: null }),
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

    // The docs mark api_token as required in the query here; the header goes as well.
    const url = `${api(ctx)}/get/orders/status?api_token=${encodeURIComponent(token(credentials))}&trackings=${valid.join(',')}&status=all`;
    const result = await read(url, authHeaders(credentials), ctx, startDeadline(ctx));
    if (result.kind !== 'response' || result.status !== 200) {
      const failure = unavailable(result);
      return { ok: false, cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
    }
    const body = parseObject(result.text);
    const data = body?.['data'];
    // An empty PHP associative array encodes as [].
    const rows = Array.isArray(data) && data.length === 0 ? {} : asRecord(data);
    if (!rows) return { ok: false, cause: 'malformed_response' };

    const wanted = new Set(valid);
    const events: ParcelEvent[] = [];
    const seen = new Set<string>();
    let badRows = 0;
    for (const [tracking, raw] of Object.entries(rows)) {
      const row = asRecord(raw);
      const event = row && wanted.has(tracking) ? eventFromRow(tracking, row) : null;
      if (event === null) {
        badRows += 1;
        continue;
      }
      seen.add(tracking);
      events.push(event);
    }
    return { ok: true, events, absent: valid.filter((t) => !seen.has(t)), invalid, badRows };
  }

  async function communesOf(
    wilayaCode: number,
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<ListResult<Record<string, unknown>> & { code?: number }> {
    const mapped = toWilaya58(wilayaCode);
    if (!mapped.ok) return { ok: false, cause: mapped.code };
    const result = await read(`${api(ctx)}/get/communes?wilaya_id=${mapped.code}`, authHeaders(credentials), ctx, startDeadline(ctx));
    if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
    let body: unknown;
    try {
      body = JSON.parse(result.text);
    } catch {
      return { ok: false, cause: 'malformed_response' };
    }
    const rows = parseCommunes(body);
    return rows === null ? { ok: false, cause: 'malformed_response' } : { ok: true, items: rows, code: mapped.code };
  }

  return {
    id,
    family: 'ecotrack',
    displayName: tenant.name,
    capabilities: CAPABILITIES,
    confidence: {
      baseUrl: tenant.baseUrl,
      statusList: 'official',
      notes: tenant.baseUrl === 'unconfirmed' ? [...NOTES, 'tenant_url_unconfirmed'] : NOTES,
    },
    mapWilaya: toWilaya58,
    prepare,

    async checkCredentials(credentials, ctx) {
      const url = `${api(ctx)}/validate/token?api_token=${encodeURIComponent(token(credentials))}`;
      const result = await read(url, { Accept: 'application/json' }, ctx, startDeadline(ctx));
      // An invented tenant answers 404, which must not read as a bad key.
      if (result.kind === 'response' && result.status === 404) return { kind: 'unavailable', cause: 'tenant_not_found' };
      const http = classifyCredentialHttp(result);
      if (http) return http;
      if (result.kind !== 'response') return { kind: 'unavailable', cause: 'malformed_response' };
      // The docs print this body with single quotes.
      const body = parseObject(result.text) ?? parseObject(result.text.replaceAll("'", '"'));
      const message = body?.['message'];
      if (body?.['success'] === true && message === 'VALID_TOKEN') return { kind: 'valid' };
      if (body?.['success'] === false && (message === 'INVALID_TOKEN' || message === 'TOKEN_NOT_ALLOWED')) {
        return { kind: 'invalid', detail: message };
      }
      return { kind: 'unavailable', cause: 'malformed_response' };
    },

    async listWilayas(credentials, ctx) {
      const result = await read(`${api(ctx)}/get/wilayas`, authHeaders(credentials), ctx, startDeadline(ctx));
      if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
      let body: unknown;
      try {
        body = JSON.parse(result.text);
      } catch {
        return { ok: false, cause: 'malformed_response' };
      }
      if (!Array.isArray(body)) return { ok: false, cause: 'malformed_response' };
      const items: CourierWilaya[] = [];
      for (const raw of body) {
        const row = asRecord(raw);
        if (typeof row?.['wilaya_id'] === 'number' && typeof row['wilaya_name'] === 'string') {
          items.push({ code: row['wilaya_id'], name: row['wilaya_name'], deliverable: true });
        }
      }
      return { ok: true, items };
    },

    async listCommunes(wilayaCode, credentials, ctx) {
      const result = await communesOf(wilayaCode, credentials, ctx);
      if (!result.ok) return result;
      const items: CourierCommune[] = [];
      for (const row of result.items) {
        if (typeof row['nom'] === 'string') {
          items.push({
            name: row['nom'],
            wilayaCode: result.code as number,
            hasStopDesk: row['has_stop_desk'] === 1 || row['has_stop_desk'] === true,
            deliverable: true,
          });
        }
      }
      return { ok: true, items };
    },

    async listStopDesks(wilayaCode, credentials, ctx) {
      const result = await communesOf(wilayaCode, credentials, ctx);
      if (!result.ok) return result;
      const items: CourierStopDesk[] = [];
      for (const row of result.items) {
        const postal = row['code_postal'];
        if ((row['has_stop_desk'] === 1 || row['has_stop_desk'] === true) && typeof row['nom'] === 'string' && (typeof postal === 'string' || typeof postal === 'number')) {
          items.push({
            id: String(postal),
            name: row['nom'],
            address: row['nom'],
            communeName: row['nom'],
            wilayaCode: result.code as number,
            // This list has no wilaya name, and the create call takes only the code.
            wilayaName: '',
          });
        }
      }
      return { ok: true, items };
    },

    createParcel,
    validateParcel,
    findByReference,
    fetchStatuses,

    async getLabel(tracking, credentials, ctx) {
      if (!isValidTracking(tracking)) return { kind: 'unavailable', cause: 'invalid_tracking' };
      const params = new URLSearchParams({ tracking });
      const result = await read(`${api(ctx)}/get/order/label?${params.toString()}`, authHeaders(credentials), ctx, startDeadline(ctx));
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
}

export const ecotrackAdapters: readonly CourierAdapter[] = ECOTRACK_TENANTS.map(createTenantAdapter);
