/**
 * POST /api/order and GET /{lang}/order/confirmation/ (plan WEB-0 §2.2–2.4, §3, §4).
 *
 * JSON (enhanced form): OrderInput → 201 created | 200 replay/duplicate | ApiFailure.
 * urlencoded (no JS), two steps on the same endpoint, no cookies:
 *   step absent/"review": draft → 200 review page (server prices, fee, total, commune select,
 *     a fresh idempotency key and a signed review token); errors re-render it (422/409).
 *   step "confirm": OrderInput (fill time from the review token) → 303 to the confirmation page,
 *     or the review page again with the error and the fresh quote (same key: retries stay idempotent).
 * The notification is enqueued after the D1 write, in waitUntil; a queue failure never fails the order.
 */
import type { Context, Hono } from 'hono';
import { createDb, type Db } from '@hb/db';
import {
  ORDER_ERROR_HTTP_STATUS,
  failureCode,
  formFieldsToBody,
  isLang,
  makeOrderRef,
  parseOrderDraft,
  parseOrderInput,
  parseQuoteInput,
  type ApiFailure,
  type Lang,
  type OrderCreatedMessage,
  type OrderErrorCode,
  type OrderFieldError,
} from '@hb/shared';
import { communesOf, readPricing, resolveVariant } from '../catalog-reads.ts';
import { readConfig, type Config, type Env } from '../env.ts';
import { feeProvider } from '../fees.ts';
import { log } from '../http.ts';
import { ipHash, ipRateKey, reviewFillMs, signReviewToken, sinkRef } from '../order/crypto.ts';
import { createD1OrderStore, DB_WRITES, type OrderWrites } from '../order/d1-store.ts';
import { renderConfirmation, renderReview, type ReviewLine } from '../order/html.ts';
import { placeOrder, type PlaceDeps, type PlaceOutcome } from '../order/place.ts';
import type { OrderStore } from '../order/store.ts';
import { verifyTurnstile } from '../order/turnstile.ts';
import { quoteFromReads } from '../quote.ts';
import { failure, parseJsonObject, readBody } from '../request.ts';

type C = Context<{ Bindings: Env }>;

const REVIEW_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};

function placeDeps(c: C, db: Db, store: OrderStore, config: Config): PlaceDeps {
  return {
    store,
    readPricing: (ids, communeId) => readPricing(db, ids, communeId, { snapshots: true }),
    fees: feeProvider(db, c.env),
    rlPhone: c.env.ORDER_RL_PHONE,
    rlIp: c.env.ORDER_RL_IP,
    ipRateKey,
    turnstile: (token, ip, key) =>
      verifyTurnstile({ token, secret: c.env.TURNSTILE_SECRET, ip, idempotencyKey: key, hosts: config.siteHosts }),
    ipHash: (ip) => ipHash(c.env.IP_HASH_KEY, ip),
    newRef: () => makeOrderRef(crypto.getRandomValues(new Uint8Array(5))),
    sinkRef,
    log,
  };
}

/** Enqueue after the write; one retry; on failure leave an order_events note. Never throws. */
export async function notify(env: Pick<Env, 'ORDERS'>, store: Pick<OrderStore, 'noteEnqueueFailed'>, orderId: number, message: OrderCreatedMessage): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await env.ORDERS.send(message, { contentType: 'json' });
      return;
    } catch (err) {
      log('enqueue_failed', { ref: message.ref, attempt, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
  try {
    await store.noteEnqueueFailed(orderId, Date.now());
  } catch (err) {
    log('enqueue_note_failed', { ref: message.ref, error: err instanceof Error ? err.name : 'unknown' });
  }
}

function afterWrite(c: C, store: OrderStore, outcome: PlaceOutcome): void {
  if (outcome.kind === 'created') c.executionCtx.waitUntil(notify(c.env, store, outcome.orderId, outcome.message));
}

export function registerOrder(app: Hono<{ Bindings: Env }>, writes: OrderWrites = DB_WRITES): void {
  app.post('/api/order', async (c) => {
    const body = await readBody(c.req.raw, ['json', 'form']);
    if (!body.ok) return failure(c, { code: body.code });
    const config = readConfig(c.env);
    const now = Date.now();
    const ip = c.req.header('CF-Connecting-IP') ?? null;
    const db = createDb(c.env.DB);
    const store = createD1OrderStore(db, writes);

    try {
      if (body.kind === 'json') {
        const parsed = parseOrderInput(parseJsonObject(body.text));
        if (!parsed.ok) return failure(c, { code: failureCode(parsed.errors), errors: parsed.errors });
        const outcome = await placeOrder(
          { input: parsed.value, path: 'json', ip, now, minFillMs: config.minFillMs },
          placeDeps(c, db, store, config),
        );
        afterWrite(c, store, outcome);
        if (outcome.kind === 'failure') return failure(c, outcome.failure);
        return c.json(outcome.body, outcome.status);
      }

      const raw = formFieldsToBody(new URLSearchParams(body.text));
      if (raw['step'] !== 'confirm') return await reviewPage(c, db, raw, {});

      // No-JS confirm: the fill time comes only from our signed review token.
      delete raw['fillMs'];
      const parsed = parseOrderInput(raw);
      if (!parsed.ok) {
        return await reviewPage(c, db, raw, { errors: parsed.errors, key: keyOf(raw) });
      }
      const input = {
        ...parsed.value,
        fillMs: await reviewFillMs(c.env.ORDER_SIGNING_KEY, raw['reviewToken'], parsed.value.idempotencyKey, parsed.value.lang, now),
      };
      const outcome = await placeOrder({ input, path: 'form', ip, now, minFillMs: config.minReviewMs }, placeDeps(c, db, store, config));
      afterWrite(c, store, outcome);
      if (outcome.kind === 'failure') {
        return await reviewPage(c, db, raw, { failure: outcome.failure, key: input.idempotencyKey });
      }
      return c.redirect(outcome.body.confirmationUrl, 303);
    } catch (err) {
      log('order_error', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      return failure(c, { code: 'server_error' });
    }
  });
  app.all('/api/order', (c) => c.json({ ok: false, code: 'method_not_allowed' }, 405, { Allow: 'POST' }));

  app.get('/:lang{ar|fr}/order/confirmation/*', async (c) => {
    const page = await c.env.ASSETS.fetch(c.req.raw);
    const out = renderConfirmation(page, c.req.query('ref'));
    const res = new Response(out.body, out);
    res.headers.set('Cache-Control', 'no-store');
    res.headers.delete('Set-Cookie');
    return res;
  });
}

function keyOf(raw: Record<string, unknown>): string | undefined {
  const k = raw['idempotencyKey'];
  return typeof k === 'string' && /^[0-9a-f-]{36}$/i.test(k.trim()) ? k.trim().toLowerCase() : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Renders the review step from whatever was submitted: server prices and fee for the selection,
 * the commune list for the wilaya, field/business errors, and the hidden confirm fields.
 * Reads D1 (on an order POST, allowed); writes nothing.
 */
async function reviewPage(
  c: C,
  db: Db,
  raw: Record<string, unknown>,
  opts: { readonly errors?: readonly OrderFieldError[]; readonly failure?: Omit<ApiFailure, 'ok'>; readonly key?: string | undefined },
): Promise<Response> {
  const lang: Lang = isLang(raw['lang']) ? raw['lang'] : 'ar';
  const errors: OrderFieldError[] = [...(opts.errors ?? [])];
  const draft = parseOrderDraft(raw);
  if (opts.errors === undefined && !draft.ok) errors.push(...draft.errors);

  // Selection: a variant, or (size × colour radios) a product + option values resolved in D1.
  let items: { variantId: unknown; qty: unknown }[] | undefined;
  if (draft.ok && draft.value.selection.kind === 'options') {
    const sel = draft.value.selection;
    const variantId = await resolveVariant(db, sel.productId, Object.values(sel.options));
    if (variantId === null) errors.push({ field: 'items', code: 'variant_unavailable' });
    else items = [{ variantId, qty: sel.qty }];
  } else if (Array.isArray(raw['items'])) {
    items = raw['items'] as { variantId: unknown; qty: unknown }[];
  }

  const q = items === undefined ? null : parseQuoteInput({ items, wilayaCode: raw['wilayaCode'], ...(raw['communeId'] === undefined || raw['communeId'] === '' ? {} : { communeId: raw['communeId'] }) });
  let lines: ReviewLine[] = [];
  let subtotal: number | null = null;
  let fee: number | null = null;
  let total: number | null = null;
  let backHref: string | null = null;
  let quoteOk = false;
  let hiddenItem: { variantId: number; qty: number; wilayaCode: number } | null = null;
  let communes: { id: number; name: string }[] = [];

  if (q !== null && q.ok) {
    const input = q.value;
    const reads = await readPricing(db, input.items.map((i) => i.variantId), input.communeId, { snapshots: true });
    const quote = await quoteFromReads(input, reads, feeProvider(db, c.env));
    const first = input.items[0]!;
    hiddenItem = { variantId: first.variantId, qty: first.qty, wilayaCode: input.wilayaCode };
    // Only sellable variants are shown: a draft/archived/inactive variant id must not reveal its
    // product's name or slug (rev-d WEB-3 r2); the variant_unavailable message explains instead.
    const sellable = (id: number) => reads.variants.get(id)?.sellable === true;
    const snap = sellable(first.variantId) ? reads.snapshots?.get(first.variantId) : undefined;
    if (snap !== undefined) backHref = `/${lang}/p/${lang === 'ar' ? snap.slugAr : snap.slugFr}/`;
    const qLines = (quote.ok ? quote.lines : (quote.lines ?? [])).filter((l) => sellable(l.variantId));
    lines = qLines.map((l) => {
      const s = reads.snapshots?.get(l.variantId);
      return {
        name: s === undefined ? '' : lang === 'ar' ? s.nameAr : s.nameFr,
        label: s === undefined ? null : lang === 'ar' ? s.variantLabelAr : s.variantLabelFr,
        qty: l.qty,
        unitPriceDzd: l.unitPriceDzd,
        lineTotalDzd: l.lineTotalDzd,
      };
    });
    if (quote.ok) {
      subtotal = quote.subtotalDzd;
      fee = quote.feeDzd;
      total = quote.totalDzd;
      if (quote.available) quoteOk = true;
      else errors.push({ field: 'wilayaCode', code: 'delivery_unavailable' });
    } else if (quote.code === 'validation') {
      errors.push(...(quote.errors ?? []));
    } else {
      errors.push({ field: 'items', code: quote.code });
    }
    communes = (await communesOf(db, input.wilayaCode)).map((cm) => ({ id: cm.id, name: lang === 'ar' ? cm.nameAr : cm.nameFr }));
  } else if (q !== null && !q.ok) {
    for (const e of q.errors) if (!errors.some((x) => x.field === e.field)) errors.push(e);
  }

  // A failure from the confirm step (total_changed, out_of_stock, rate_limited, server_error…).
  if (opts.failure !== undefined && opts.failure.code !== 'validation') {
    errors.push({ field: 'form', code: opts.failure.code });
  }

  const key = opts.key ?? crypto.randomUUID();
  const signing = c.env.ORDER_SIGNING_KEY;
  const hidden: [string, string][] = [
    ['step', 'confirm'],
    ['lang', lang],
    ['idempotencyKey', key],
  ];
  if (signing !== undefined && signing !== '') hidden.push(['reviewToken', await signReviewToken(signing, Date.now(), key, lang)]);
  if (hiddenItem !== null) {
    hidden.push(['variantId', String(hiddenItem.variantId)], ['qty', String(hiddenItem.qty)], ['wilayaCode', String(hiddenItem.wilayaCode)]);
  }
  if (total !== null) hidden.push(['expectedTotalDzd', String(total)]);
  hidden.push(['website', str(raw['website'])]);

  const canConfirm = quoteOk && errors.length === 0;
  const status = statusFor(errors, opts.failure);
  const headers: Record<string, string> = { ...REVIEW_HEADERS };
  if (opts.failure?.retryAfterS !== undefined) headers['Retry-After'] = String(opts.failure.retryAfterS);

  const template = await c.env.ASSETS.fetch(new Request(new URL(`/${lang}/order/review/`, c.req.url)));
  if (!template.ok) {
    log('review_template_missing', { lang, status: template.status });
    return failure(c, { code: 'server_error' });
  }
  const communeRaw = Number(raw['communeId']);
  return renderReview(
    template,
    {
      lang,
      lines,
      subtotalDzd: subtotal,
      feeDzd: fee,
      totalDzd: total,
      hidden,
      name: str(raw['name']),
      phone: str(raw['phone']),
      communes,
      selectedCommune: Number.isSafeInteger(communeRaw) && communeRaw > 0 ? communeRaw : undefined,
      errors,
      canConfirm,
      backHref,
    },
    status,
    headers,
  );
}

function statusFor(errors: readonly OrderFieldError[], fail: Omit<ApiFailure, 'ok'> | undefined): number {
  if (fail !== undefined) return ORDER_ERROR_HTTP_STATUS[fail.code];
  if (errors.length === 0) return 200;
  const business = errors.find((e) => ORDER_ERROR_HTTP_STATUS[e.code as OrderErrorCode] === 409);
  return business !== undefined ? 409 : 422;
}
