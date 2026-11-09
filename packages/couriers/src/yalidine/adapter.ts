/**
 * The Yalidine platform: Yalidine and Guepex share one API (artifacts/delivery-research/yalidine.md,
 * third-party sourced, because the official docs need a merchant login).
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
  safeLabelUrl,
  send,
  startDeadline,
  unavailable,
  type Deadline,
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
  CourierConfidence,
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
  WebhookParseResult,
  WebhookVerification,
} from '../types.ts';
import { YALIDINE_GONE, YALIDINE_STATUSES } from './statuses.ts';

const MAX_PRICE = 150_000;
const MAX_PAGES = 10;
const MAX_WEBHOOK_EVENTS = 500;
const PAGE_SIZE = 1000;
const SIGNATURE_HEADER = 'x-yalidine-signature';

const CAPABILITIES: CourierCapabilities = {
  verifyByReference: true,
  verifyAfterSeconds: VERIFY_AFTER_SECONDS,
  verifyWithinSeconds: null,
  needsValidation: false,
  stopDesk: true,
  pollBatchSize: 100,
  minPollSeconds: 300,
  sendPerMinute: 50,
  webhook: 'hmac',
  needsOriginWilaya: true,
  credentialFields: [
    { key: 'apiId', secret: true, labelFr: 'API ID', labelAr: 'معرّف API' },
    { key: 'apiToken', secret: true, labelFr: 'Jeton API', labelAr: 'رمز API' },
  ],
};

interface FamilyConfig {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly labelHosts: readonly string[];
  readonly confidence: CourierConfidence;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isOn = (value: unknown): boolean => value === 1 || value === true;
const isNotOff = (value: unknown): boolean => value !== 0 && value !== false;

function errorMessage(body: string): unknown {
  const error = asRecord(parseObject(body)?.['error']);
  return error?.['message'];
}

function splitName(full: string): { firstname: string; familyname: string } | null {
  const parts = full.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0];
  if (first === undefined) return null;
  return { firstname: first, familyname: parts.length > 1 ? parts.slice(1).join(' ') : first };
}

function authHeaders(credentials: CourierCredentials): Record<string, string> {
  return {
    'X-API-ID': credentials['apiId'] ?? '',
    'X-API-TOKEN': credentials['apiToken'] ?? '',
    Accept: 'application/json',
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function createFamilyAdapter(config: FamilyConfig): CourierAdapter {
  const base = (ctx: CourierContext) => `${courierBase(config.baseUrl, config.id, ctx)}/v1`;

  async function collect<T>(
    path: string,
    params: URLSearchParams,
    parse: (row: Record<string, unknown>) => T | null,
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<ListResult<T>> {
    const deadline = startDeadline(ctx);
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      params.set('page', String(page));
      params.set('page_size', String(PAGE_SIZE));
      const result = await read(`${base(ctx)}/${path}?${params.toString()}`, authHeaders(credentials), ctx, deadline);
      if (result.kind !== 'response' || result.status !== 200) return listFailure(result);
      const body = parseObject(result.text);
      const rows = body?.['data'];
      if (!body || !Array.isArray(rows)) return { ok: false, cause: 'malformed_response' };
      for (const row of rows) {
        const record = asRecord(row);
        const parsed = record ? parse(record) : null;
        if (parsed !== null) items.push(parsed);
      }
      if (body['has_more'] !== true) return { ok: true, items };
    }
    return { ok: false, cause: 'too_many_pages' };
  }

  function prepare(input: ParcelInput, lists: CourierLists): PrepareResult {
    if (lists.wilayas.length === 0) {
      return { ok: false, code: 'lists_missing', detail: "The courier's wilaya list is not loaded" };
    }
    const destination = toWilaya58(input.wilayaCode);
    if (!destination.ok) return { ok: false, code: 'wilaya_unmapped', detail: destination.detail };
    const wilaya = lists.wilayas.find((w) => w.code === destination.code);
    if (!wilaya) {
      return { ok: false, code: 'wilaya_unmapped', detail: `The courier has no wilaya ${destination.code}` };
    }
    if (!wilaya.deliverable) {
      return { ok: false, code: 'wilaya_not_deliverable', detail: `The courier does not deliver to ${wilaya.name}` };
    }

    if (input.originWilayaCode === undefined) {
      return { ok: false, code: 'origin_missing', detail: 'The origin wilaya is not set for this courier' };
    }
    const origin = toWilaya58(input.originWilayaCode);
    const originWilaya = origin.ok ? lists.wilayas.find((w) => w.code === origin.code) : undefined;
    if (!originWilaya) {
      return { ok: false, code: 'origin_missing', detail: 'The origin wilaya is not on the courier list' };
    }

    const phone = normalizePhone(input.phone);
    if (!phone.ok) return { ok: false, code: 'phone_invalid', detail: phone.code };

    const name = splitName(input.recipientName);
    if (!name) return { ok: false, code: 'recipient_required', detail: 'The recipient has no name' };

    if (!Number.isInteger(input.codTotalDzd) || input.codTotalDzd < 0 || input.codTotalDzd > MAX_PRICE) {
      return { ok: false, code: 'amount_out_of_range', detail: `Amount must be 0 to ${MAX_PRICE} DZD` };
    }

    let toCommune: string;
    let address: string;
    let stopDesk: { stopdesk_id: number } | Record<string, never> = {};
    let wilayaName = wilaya.name;

    if (input.deliveryType === 'stop_desk') {
      if (!input.stopDeskId) {
        return { ok: false, code: 'stop_desk_required', detail: 'No stop desk was chosen' };
      }
      const desk = lists.stopDesks.find((d) => d.id === input.stopDeskId);
      if (!desk || desk.wilayaCode !== destination.code) {
        return { ok: false, code: 'stop_desk_mismatch', detail: 'This stop desk is not in the order wilaya' };
      }
      const deskId = Number(desk.id);
      if (!Number.isSafeInteger(deskId)) {
        return { ok: false, code: 'stop_desk_mismatch', detail: 'This stop desk id is not usable' };
      }
      // The courier rejects a mismatch, so the names are the centre's, not the order's.
      toCommune = desk.communeName;
      wilayaName = desk.wilayaName;
      address = desk.address;
      stopDesk = { stopdesk_id: deskId };
    } else {
      const trimmed = input.address?.trim() ?? '';
      if (trimmed === '') return { ok: false, code: 'address_required', detail: 'A home delivery needs an address' };
      const communes = lists.communes.filter((c) => c.wilayaCode === destination.code);
      if (communes.length === 0) {
        return { ok: false, code: 'lists_missing', detail: "The courier's commune list is not loaded" };
      }
      const match = matchCommune(input.commune, communes);
      if (!match.ok) return { ok: false, code: match.code, detail: match.detail };
      toCommune = match.commune.name;
      address = trimmed;
    }

    return {
      ok: true,
      parcel: {
        courier: config.id,
        reference: input.reference,
        payload: {
          order_id: input.reference,
          from_wilaya_name: originWilaya.name,
          firstname: name.firstname,
          familyname: name.familyname,
          contact_phone: phone.national,
          address,
          to_wilaya_name: wilayaName,
          to_commune_name: toCommune,
          product_list: input.productLabel.trim() || input.reference,
          // Our total already includes delivery. `freeshipping: true` stops the courier adding its
          // fee on top, so the customer pays the total once. Unconfirmed until a real parcel.
          price: input.codTotalDzd,
          freeshipping: true,
          do_insurance: false,
          declared_value: input.codTotalDzd,
          length: 0,
          width: 0,
          height: 0,
          weight: 0,
          is_stopdesk: input.deliveryType === 'stop_desk',
          has_exchange: false,
          ...stopDesk,
        },
      },
    };
  }

  function parseCreated(body: string, reference: string, credentials: CourierCredentials, ctx: CourierContext): CreateResult {
    const json = parseObject(body);
    if (!json) return { kind: 'uncertain', cause: 'malformed_response' };
    if (Object.keys(json).length !== 1 || !Object.hasOwn(json, reference)) {
      return { kind: 'uncertain', cause: 'malformed_response' };
    }
    const row = asRecord(json[reference]);
    if (!row || row['order_id'] !== reference) return { kind: 'uncertain', cause: 'malformed_response' };
    if (row['success'] === true && isValidTracking(row['tracking'])) {
      const labelUrl = safeLabelUrl(row['label'], config.labelHosts, ctx);
      return { kind: 'accepted', tracking: row['tracking'], draft: false, ...(labelUrl ? { labelUrl } : {}) };
    }
    if (row['success'] === false && (row['tracking'] === null || row['tracking'] === undefined)) {
      return { kind: 'rejected', code: 'courier_refused', detail: redact(row['message'], credentials) || 'refused' };
    }
    return { kind: 'uncertain', cause: 'malformed_response' };
  }

  async function createParcel(parcel: PreparedParcel, credentials: CourierCredentials, ctx: CourierContext): Promise<CreateResult> {
    if (parcel.courier !== config.id) {
      return { kind: 'rejected', code: 'wrong_courier', detail: 'Prepared for another courier' };
    }
    const result = await send(
      `${base(ctx)}/parcels/`,
      {
        method: 'POST',
        headers: { ...authHeaders(credentials), 'Content-Type': 'application/json' },
        body: JSON.stringify([parcel.payload]),
      },
      ctx,
    );
    const classified = classifyWrite(result, errorMessage, credentials);
    return 'done' in classified ? classified.done : parseCreated(classified.body, parcel.reference, credentials, ctx);
  }

  async function findByReference(
    reference: string,
    options: { readonly attemptedAt: number },
    credentials: CourierCredentials,
    ctx: CourierContext,
  ): Promise<LookupResult> {
    if (!Number.isFinite(options?.attemptedAt)) return { kind: 'unavailable', cause: 'attempted_at_missing' };
    const deadline = startDeadline(ctx);
    const params = new URLSearchParams({ order_id: reference, page_size: String(PAGE_SIZE) });
    const result = await read(`${base(ctx)}/parcels/?${params.toString()}`, authHeaders(credentials), ctx, deadline);
    if (result.kind !== 'response' || result.status !== 200) return unavailable(result);
    const body = parseObject(result.text);
    const rows = body?.['data'];
    const total = body?.['total_data'];
    if (!body || !Array.isArray(rows) || typeof total !== 'number') {
      return { kind: 'unavailable', cause: 'malformed_response' };
    }
    if (total === 0 && rows.length === 0) {
      return { kind: 'not_found', checkedAt: (ctx.now ?? Date.now)() };
    }
    if (body['has_more'] === true) return { kind: 'unavailable', cause: 'too_many_rows' };
    const exact = rows
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row?.['order_id'] === reference && isValidTracking(row['tracking']));
    const first = exact[0];
    if (first === undefined) return { kind: 'unavailable', cause: 'no_exact_match' };
    if (exact.length > 1) return { kind: 'multiple', trackings: exact.map((row) => row['tracking'] as string) };
    const rawStatus = typeof first['last_status'] === 'string' ? first['last_status'] : '';
    return {
      kind: 'found',
      tracking: first['tracking'] as string,
      rawStatus,
      status: mapStatus(YALIDINE_STATUSES, rawStatus),
      gone: YALIDINE_GONE.has(normaliseRaw(rawStatus) ?? ''),
    };
  }

  function eventFromParcel(row: Record<string, unknown>, tracking: string): ParcelEvent | null {
    const rawStatus = row['last_status'];
    if (normaliseRaw(rawStatus) === null) return null;
    const occurredAt = parseCourierDate(row['date_last_status']);
    return {
      tracking,
      rawStatus: rawStatus as string,
      status: mapStatus(YALIDINE_STATUSES, rawStatus),
      // The parcel list has no failure reason; only history rows and webhooks carry one.
      reason: null,
      occurredAt,
      eventKey: eventKey(tracking, rawStatus as string, { occurredAt }),
    };
  }

  async function fetchPage(
    trackings: readonly string[],
    page: number,
    credentials: CourierCredentials,
    ctx: CourierContext,
    deadline: Deadline,
  ) {
    // Trackings passed `isValidTracking`, so the literal commas the API expects are safe here.
    const url = `${base(ctx)}/parcels/?tracking=${trackings.join(',')}&page_size=${PAGE_SIZE}&page=${page}`;
    return read(url, authHeaders(credentials), ctx, deadline);
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

    const deadline = startDeadline(ctx);
    const wanted = new Set(valid);
    const seen = new Set<string>();
    const events: ParcelEvent[] = [];
    let badRows = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await fetchPage(valid, page, credentials, ctx, deadline);
      if (result.kind !== 'response' || result.status !== 200) {
        const failure = unavailable(result);
        return { ok: false, cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
      }
      const body = parseObject(result.text);
      const rows = body?.['data'];
      if (!body || !Array.isArray(rows)) return { ok: false, cause: 'malformed_response' };
      for (const raw of rows) {
        const row = asRecord(raw);
        const tracking = row?.['tracking'];
        const event = row && isValidTracking(tracking) && wanted.has(tracking) ? eventFromParcel(row, tracking) : null;
        if (event === null) {
          badRows += 1;
          continue;
        }
        seen.add(event.tracking);
        events.push(event);
      }
      if (body['has_more'] !== true) {
        return { ok: true, events, absent: valid.filter((t) => !seen.has(t)), invalid, badRows };
      }
    }
    return { ok: false, cause: 'too_many_pages' };
  }

  return {
    id: config.id,
    family: 'yalidine',
    displayName: config.displayName,
    capabilities: CAPABILITIES,
    confidence: config.confidence,
    mapWilaya: toWilaya58,
    prepare,

    async checkCredentials(credentials, ctx) {
      const url = `${base(ctx)}/wilayas/?page_size=1`;
      const result = await read(url, authHeaders(credentials), ctx, startDeadline(ctx));
      const http = classifyCredentialHttp(result);
      if (http) return http;
      const body = result.kind === 'response' ? parseObject(result.text) : undefined;
      return Array.isArray(body?.['data']) ? { kind: 'valid' } : { kind: 'unavailable', cause: 'malformed_response' };
    },

    listWilayas(credentials, ctx) {
      return collect<CourierWilaya>(
        'wilayas/',
        new URLSearchParams(),
        (row) =>
          typeof row['id'] === 'number' && typeof row['name'] === 'string'
            ? { code: row['id'], name: row['name'], deliverable: isNotOff(row['is_deliverable']) }
            : null,
        credentials,
        ctx,
      );
    },

    async listCommunes(wilayaCode, credentials, ctx) {
      const mapped = toWilaya58(wilayaCode);
      if (!mapped.ok) return { ok: false, cause: mapped.code };
      return collect<CourierCommune>(
        'communes/',
        new URLSearchParams({ wilaya_id: String(mapped.code) }),
        (row) =>
          typeof row['name'] === 'string'
            ? {
                name: row['name'],
                wilayaCode: mapped.code,
                hasStopDesk: isOn(row['has_stop_desk']),
                deliverable: isNotOff(row['is_deliverable']),
              }
            : null,
        credentials,
        ctx,
      );
    },

    async listStopDesks(wilayaCode, credentials, ctx) {
      const mapped = toWilaya58(wilayaCode);
      if (!mapped.ok) return { ok: false, cause: mapped.code };
      return collect<CourierStopDesk>(
        'centers/',
        new URLSearchParams({ wilaya_id: String(mapped.code) }),
        (row) =>
          typeof row['center_id'] === 'number' &&
          typeof row['name'] === 'string' &&
          typeof row['commune_name'] === 'string' &&
          typeof row['wilaya_name'] === 'string'
            ? {
                id: String(row['center_id']),
                name: row['name'],
                address: typeof row['address'] === 'string' ? row['address'] : row['name'],
                communeName: row['commune_name'],
                wilayaCode: mapped.code,
                wilayaName: row['wilaya_name'],
              }
            : null,
        credentials,
        ctx,
      );
    },

    createParcel,

    async validateParcel() {
      // No draft step on this platform: a created parcel is already live.
      return { kind: 'validated' };
    },

    findByReference,
    fetchStatuses,

    async getLabel(tracking, credentials, ctx) {
      if (!isValidTracking(tracking)) return { kind: 'unavailable', cause: 'invalid_tracking' };
      const result = await read(`${base(ctx)}/parcels/${tracking}`, authHeaders(credentials), ctx, startDeadline(ctx));
      if (result.kind !== 'response' || result.status !== 200) {
        const failure = unavailable(result);
        return { kind: 'unavailable', cause: failure.cause, ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }) };
      }
      const rows = parseObject(result.text)?.['data'];
      const row = Array.isArray(rows) ? asRecord(rows[0]) : undefined;
      const url = safeLabelUrl(row?.['label'], config.labelHosts, ctx);
      return url ? { kind: 'url', url } : { kind: 'unavailable', cause: 'no_label' };
    },

    webhookHandshake(query) {
      const token = query['crc_token'];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_.~-]{1,256}$/.test(token)) return null;
      return { body: token, contentType: 'text/plain' };
    },

    async verifyWebhook({ rawBody, headers, secret }): Promise<WebhookVerification> {
      if (typeof secret !== 'string' || secret === '') return { ok: false, reason: 'missing_secret' };
      let signature: string | undefined;
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === SIGNATURE_HEADER) signature = value;
      }
      if (signature === undefined || signature === '') return { ok: false, reason: 'missing_signature' };
      if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'bad_signature' };
      try {
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        // subtle.verify compares in constant time.
        const valid = await crypto.subtle.verify('HMAC', key, hexToBytes(signature) as BufferSource, rawBody as BufferSource);
        return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
      } catch {
        return { ok: false, reason: 'bad_signature' };
      }
    },

    parseWebhook(rawBody): WebhookParseResult {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      const body = parseObject(text);
      const rows = body?.['events'];
      if (!body || !Array.isArray(rows)) return { ok: false, reason: 'malformed' };
      if (rows.length > MAX_WEBHOOK_EVENTS) return { ok: false, reason: 'too_many_events' };
      if (body['type'] !== 'parcel_status_updated') return { ok: true, events: [], badRows: 0 };

      const events: ParcelEvent[] = [];
      let badRows = 0;
      for (const raw of rows) {
        const row = asRecord(raw);
        const data = asRecord(row?.['data']);
        const tracking = data?.['tracking'];
        const rawStatus = data?.['status'];
        if (!isValidTracking(tracking) || normaliseRaw(rawStatus) === null) {
          badRows += 1;
          continue;
        }
        const occurredAt = parseCourierDate(row?.['occurred_at']);
        const reason = data?.['reason'];
        events.push({
          tracking,
          rawStatus: rawStatus as string,
          status: mapStatus(YALIDINE_STATUSES, rawStatus),
          reason: typeof reason === 'string' && reason !== '' ? reason : null,
          occurredAt,
          eventKey: eventKey(tracking, rawStatus as string, {
            occurredAt,
            eventId: typeof row?.['event_id'] === 'string' ? row['event_id'] : null,
          }),
        });
      }
      return { ok: true, events, badRows };
    },
  };
}

const NOTES = ['status_list_unofficial', 'docs_login_gated', 'webhook_signature_unverified', 'freeshipping_unconfirmed'];

export const yalidine = createFamilyAdapter({
  id: 'yalidine',
  displayName: 'Yalidine',
  baseUrl: 'https://api.yalidine.app',
  labelHosts: ['yalidine.app'],
  confidence: { baseUrl: 'probed', statusList: 'unofficial', notes: NOTES },
});

export const guepex = createFamilyAdapter({
  id: 'guepex',
  displayName: 'Guepex',
  baseUrl: 'https://api.guepex.app',
  labelHosts: ['guepex.app'],
  confidence: {
    baseUrl: 'probed',
    statusList: 'unofficial',
    notes: [...NOTES, 'status_list_inherited_from_yalidine', 'label_host_unconfirmed'],
  },
});
