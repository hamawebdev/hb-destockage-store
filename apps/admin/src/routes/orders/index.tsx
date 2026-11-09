// Orders section (owner: admin-orders). Mounted at /orders by admin-core (app.ts).
// Plan: artifacts/AORD-0/plan.md. Rules: see the header of src/app.ts.
//
//   GET  /                    list, filters, search, keyset pagination        (AORD-1)
//   GET  /queue               call queue: my claimed order, or "take next"    (AORD-3)
//   POST /queue/next          claim the next order to call (AORD-2 claimOrder)
//   GET  /shipping            ready to ship + out for delivery                (AORD-5)
//   POST /shipping/ship       bulk "mark shipped" (≤ 50), one DB-4 change + audit row per order
//   POST /shipping/slips      printable bilingual slips (≤ 50, confirmed/shipped), one audit row (refs)
//   GET  /:ref                detail, timeline, action forms                  (AORD-2)
//   POST /:ref/call           log a call attempt + outcome                    (AORD-2)
//   POST /:ref/transition     manual transitions (cancel, ship, deliver, return)
//   POST /:ref/note           append a note
//   GET  /:ref/contact        contact/address edit form                       (AORD-6)
//   POST /:ref/contact        step=review|edit (no write) · step=save (DB-6 updateOrderContact)
//   POST /:ref/claim          take the call (10 min soft lock, no version bump)
//   POST /:ref/release        release my claim (owner: anyone's)
//
// Every POST: role (route) → order by ref (404) → Valibot form (422) → version pre-check (409) →
// workflow plan with @hb/shared canTransition per hop (403/409/422) → DB-4 guarded batch with the
// audit row (409 on a lost race) → 303 to the detail page.
import type { Context } from 'hono';
import { asc, eq, inArray } from 'drizzle-orm';
import { communes, settings, updateOrderContact, wilayas, type Db } from '@hb/db';
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { parseForm, readForm, type FormSchema } from '../../lib/forms.ts';
import { isOrderRef } from '@hb/shared';
import { canSeeSensitive } from '../../lib/projection.ts';
import { startOfAlgiersDay } from '../../lib/time.ts';
import { createRouter } from '../../lib/router.ts';
import { withFlash } from '../../ui/flash.tsx';
import { audit, noAudit, withAudit } from '../../audit/audit.ts';
import { claimOrder, releaseOrder } from './claims.ts';
import { myClaim, queueCandidates, queueCounts } from './queue.ts';
import { QueueCallPage, QueueEmptyPage } from './queue-page.tsx';
import { ContactForm, canEditContact, communesOf, contactAudit, feeProviderFor, previewContact, type ContactCurrent, type ContactErrKey } from './contact.ts';
import { ContactEditPage, ContactReviewPage } from './contact-page.tsx';
import { fetchOrderByRef, fetchOrderChildren, type OrderDetail } from './detail-data.ts';
import { fetchCustomerHistory, type CustomerHistory } from './history.ts';
import { fetchShipmentPanel } from '../delivery/panel.tsx';
import { OrderDetailPage, type DetailProps, type FormKind } from './detail-page.tsx';
import { fetchOrdersPage, ordersToday, statusCounts } from './list-data.ts';
import { OrdersListPage } from './list-page.tsx';
import { SEARCH_MAX_CHARS, parseOrdersFilter } from './list-query.ts';
import { m } from './messages.ts';
import {
  CallForm,
  NoteForm,
  SETTING_KEYS,
  TransitionForm,
  callSettingsFrom,
  planCall,
  planNote,
  planTransition,
  unansweredStreak,
  type CallSettings,
  type OrderState,
  type PlanErrors,
  type PlanResult,
} from './workflow.ts';
import { orderGuard, orderWriter } from './writer.ts';
import { MAX_BATCH, fetchSlips, shippingCounts, shippingQuery } from './shipping-data.ts';
import { ShippingPage, SlipsPage, type ShipResult } from './shipping-page.tsx';

const r = createRouter({ roles: rolesFor('orders.view') });

/** Public order ref in the URL. Anything else under /orders/ that is not a known path → 404. */
const REF = ':ref{HB-[0-9A-HJKMNP-TV-Z]{5}}';

r.get('/', requirePerm('orders.view'), async (c) => {
  const url = new URL(c.req.url);
  const parsed = parseOrdersFilter(url.searchParams, c.var.user.role);
  const sensitive = canSeeSensitive(c.var.user);
  const now = Date.now();
  const [page, counts, today] = await Promise.all([
    fetchOrdersPage(c.var.db, parsed.filter, sensitive),
    statusCounts(c.var.db),
    ordersToday(c.var.db, startOfAlgiersDay(now), now),
  ]);
  const q = (url.searchParams.get('q') ?? '').slice(0, SEARCH_MAX_CHARS);
  return c.render(
    <OrdersListPage
      lang={c.var.lang}
      role={c.var.user.role}
      parsed={parsed}
      page={page}
      counts={counts}
      today={today}
      q={q}
      url={`${url.pathname}${url.search}`}
      sensitive={sensitive}
      bulk={can(c.var.user, 'orders.shipping')}
      send={can(c.var.user, 'delivery.send')}
    />,
    { title: m(c.var.lang)('list.title') },
  );
});

/** The phone's other orders (UX-7). Order history is sensitive: nothing is read without `customers.sensitive`. */
function historyOf(c: Context<AppEnv>, order: OrderDetail): Promise<CustomerHistory | undefined> {
  return order.risk ? fetchCustomerHistory(c.var.db, order.customer.id, order.id) : Promise.resolve(undefined);
}

// ---------------------------------------------------------------------------------------------
// Call queue (AORD-3): reads, plus AORD-2's claimOrder.

/** `afterNext`: "take next" found nothing free; if work is waiting (held by colleagues) say so with a 409. */
async function renderQueue(c: Context<AppEnv>, opts: { afterNext?: boolean } = {}) {
  const now = Date.now();
  const tm = m(c.var.lang);
  const title = tm('queue.title');
  const ref = await myClaim(c.var.db, c.var.user.id, now);
  const order = ref ? await fetchOrderByRef(c.var.db, ref, canSeeSensitive(c.var.user)) : null;
  if (order) {
    const [{ items, events }, history] = await Promise.all([
      fetchOrderChildren(c.var.db, order.id, { withAudit: false, sensitive: canSeeSensitive(c.var.user) }),
      historyOf(c, order),
    ]);
    return c.render(<QueueCallPage lang={c.var.lang} user={c.var.user} now={now} order={order} items={items} events={events} {...(history ? { history } : {})} />, { title });
  }
  const counts = await queueCounts(c.var.db, now);
  const nothingFree = opts.afterNext === true && counts.due + counts.new + counts.unreachable > 0;
  if (nothingFree) c.status(409);
  return c.render(<QueueEmptyPage lang={c.var.lang} counts={counts} nothingFree={nothingFree} />, { title });
}

r.get('/queue', requirePerm('orders.queue'), (c) => renderQueue(c));

r.post('/queue/next', requirePerm('orders.queue'), async (c) => {
  const now = Date.now();
  if (await myClaim(c.var.db, c.var.user.id, now)) {
    noAudit(c, 'queue/next: the user already holds a claim, nothing written');
    return c.redirect('/orders/queue', 303);
  }
  for (const cand of await queueCandidates(c.var.db, c.var.user.id, now)) {
    if (await claimOrder(c, cand.id, now)) return c.redirect('/orders/queue', 303);
  }
  noAudit(c, 'queue/next: no free order to claim, nothing written');
  // Nothing due at all → the normal empty page (200); work waiting but held by colleagues → 409.
  return renderQueue(c, { afterNext: true });
});

// ---------------------------------------------------------------------------------------------
// Shipping hand-off (AORD-5). Plan: artifacts/AORD-5/plan.md (approved: slips only, no CSV).

async function renderShipping(c: Context<AppEnv>, status: 200 | 422 = 200, extra: { error?: string; results?: ShipResult[] } = {}) {
  const [ready, out, counts] = await Promise.all([shippingQuery(c.var.db, 'confirmed'), shippingQuery(c.var.db, 'shipped'), shippingCounts(c.var.db)]);
  c.status(status);
  return c.render(<ShippingPage lang={c.var.lang} ready={ready} out={out} counts={counts} send={can(c.var.user, 'delivery.send')} {...extra} />, { title: m(c.var.lang)('ship.title') });
}

r.get('/shipping', requirePerm('orders.shipping'), (c) => renderShipping(c));

/** The ticked refs (repeated `ref` fields): valid refs only, de-duplicated, in form order. */
async function pickedRefs(c: Context<AppEnv>) {
  const body = await c.req.parseBody({ all: true });
  const raw = body['ref'];
  const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((x): x is string => typeof x === 'string');
  const str = (k: string) => {
    const val = body[k];
    return typeof val === 'string' ? val : '';
  };
  return { refs: [...new Set(list.filter((x) => isOrderRef(x)))], str };
}

r.post('/shipping/ship', requirePerm('orders.shipping'), async (c) => {
  const tm = m(c.var.lang);
  const { refs, str } = await pickedRefs(c);
  const courierName = str('courierName').trim();
  const refuse = (key: 'ship.err.none' | 'ship.err.tooMany' | 'err.courierRequired' | 'form.tooLong') => {
    noAudit(c, 'bulk ship refused before any write');
    return renderShipping(c, 422, { error: key === 'form.tooLong' ? c.var.t('form.tooLong', { max: 80 }) : tm(key) });
  };
  if (refs.length === 0) return refuse('ship.err.none');
  if (refs.length > MAX_BATCH) return refuse('ship.err.tooMany');
  if (courierName === '') return refuse('err.courierRequired');
  if ([...courierName].length > 80) return refuse('form.tooLong');

  const now = Date.now();
  const results: ShipResult[] = [];
  for (const ref of refs) {
    const order = await fetchOrderByRef(c.var.db, ref, canSeeSensitive(c.var.user));
    if (!order) {
      results.push({ ref, outcome: 'notFound' });
      continue;
    }
    if (order.status !== 'confirmed') {
      results.push({ ref, outcome: 'notConfirmed' });
      continue;
    }
    const tracking = str(`tracking_${ref}`).trim().slice(0, 80);
    const version = Number(str(`version_${ref}`));
    if (!Number.isSafeInteger(version) || version !== order.version) {
      results.push({ ref, outcome: 'conflict' });
      continue;
    }
    const p = planTransition(
      stateOf(order),
      { version, to: 'shipped', reason: '', courierName, courierTracking: tracking === '' ? null : tracking, note: null, return: 'shipping' },
      { role: c.var.user.role },
    );
    if (!p.ok) {
      results.push({ ref, outcome: p.status === 403 ? 'forbidden' : 'notConfirmed' });
      continue;
    }
    const res = await orderWriter.applyChange(c, order.id, p.plan, now);
    results.push({
      ref,
      outcome: res.ok ? 'shipped' : res.code === 'shipment_in_progress' ? 'shipmentBusy' : res.code === 'version_conflict' ? 'conflict' : res.code === 'forbidden' ? 'forbidden' : res.code === 'not_found' ? 'notFound' : 'notConfirmed',
    });
  }
  if (!results.some((r) => r.outcome === 'shipped')) noAudit(c, 'bulk ship: no order changed, nothing written');
  return renderShipping(c, 200, { results });
});

r.post('/shipping/slips', requirePerm('orders.shipping'), async (c) => {
  const tm = m(c.var.lang);
  const { refs, str } = await pickedRefs(c);
  if (refs.length === 0 || refs.length > MAX_BATCH) {
    noAudit(c, 'slips refused before any read');
    return renderShipping(c, 422, { error: tm(refs.length === 0 ? 'ship.err.none' : 'ship.err.tooMany') });
  }
  const size = str('size') === 'a5' ? 'a5' : 'a6';
  const { slips, refused } = await fetchSlips(c.var.db, refs);
  // One row per print request: which orders were printed, never what was printed.
  await withAudit(c, { action: 'order.slips', entity: 'orders', entityId: null, before: null, after: { refs: slips.map((s) => s.ref), count: slips.length, refused, size } });
  return c.render(<SlipsPage lang={c.var.lang} slips={slips} refused={refused} size={size} />, { title: tm('slip.title'), variant: 'print' });
});

// ---------------------------------------------------------------------------------------------
// Detail

async function renderDetail(
  c: Context<AppEnv>,
  order: OrderDetail,
  status: 200 | 403 | 409 | 422 = 200,
  extra: Pick<DetailProps, 'form' | 'conflict' | 'shipmentBusy'> = {},
) {
  const [children, history, shipment] = await Promise.all([
    fetchOrderChildren(c.var.db, order.id, { withAudit: c.var.user.role === 'owner', sensitive: canSeeSensitive(c.var.user) }),
    historyOf(c, order),
    can(c.var.user, 'delivery.view') ? fetchShipmentPanel(c.var.db, order.id) : Promise.resolve(undefined),
  ]);
  const tm = m(c.var.lang);
  c.status(status);
  return c.render(
    <OrderDetailPage lang={c.var.lang} user={c.var.user} now={Date.now()} order={order} {...children} {...extra} {...(history ? { history } : {})} {...(shipment !== undefined ? { shipment } : {})} />,
    {
      // LRI … PDI: the ref stays left-to-right inside the Arabic title.
      title: tm('detail.title', { ref: `\u2066${order.ref}\u2069` }),
      breadcrumbs: [{ label: tm('list.title'), href: '/orders' }, { label: order.ref }],
    },
  );
}

r.get(`/${REF}`, requirePerm('orders.view'), async (c) => {
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref'), canSeeSensitive(c.var.user));
  if (!order) return c.notFound();
  return renderDetail(c, order);
});

// ---------------------------------------------------------------------------------------------
// Mutations

const stateOf = (o: OrderDetail): OrderState => ({
  status: o.status,
  version: o.version,
  // Logistics has no risk fields; its only plans (ship/deliver/return, note) do not read them.
  callAttempts: o.risk?.callAttempts ?? 0,
  nextCallAt: o.risk?.nextCallAt ?? null,
  flags: o.risk?.flags ?? [],
});

async function readCallSettings(db: Db): Promise<CallSettings> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, Object.values(SETTING_KEYS)));
  return callSettingsFrom(new Map(rows.map((r) => [r.key, r.value])));
}

/** 409 page with who changed the order last (latest admin event, else the order's update time). */
async function renderConflict(c: Context<AppEnv>, ref: string) {
  const fresh = await fetchOrderByRef(c.var.db, ref, canSeeSensitive(c.var.user));
  if (!fresh) return c.notFound();
  const { events } = await fetchOrderChildren(c.var.db, fresh.id, { withAudit: false, sensitive: canSeeSensitive(c.var.user) });
  const last = events[events.length - 1];
  return renderDetail(c, fresh, 409, { conflict: { name: last?.actorName ?? null, at: last?.at ?? fresh.updatedAt } });
}

function translate(c: Context<AppEnv>, errors: PlanErrors): Record<string, string> {
  const tm = m(c.var.lang);
  const out: Record<string, string> = {};
  for (const [k, key] of Object.entries(errors)) if (key) out[k] = tm(key);
  return out;
}

/** Shared POST pipeline for call / transition / note. */
async function mutate<S extends FormSchema>(
  c: Context<AppEnv>,
  kind: FormKind,
  schema: S,
  plan: (order: OrderState, data: import('valibot').InferOutput<S>, ctx: { order: OrderDetail; now: number }) => Promise<PlanResult> | PlanResult,
) {
  const ref = c.req.param('ref') ?? '';
  const order = await fetchOrderByRef(c.var.db, ref, canSeeSensitive(c.var.user));
  if (!order) return c.notFound();
  const f = await parseForm(c, schema);
  const to = kind === 'transition' ? (f.values['to'] ?? '') : undefined;
  const formOf = (errors: Record<string, string>) => ({ kind, values: f.values, errors, ...(to !== undefined ? { to } : {}) });
  if (!f.ok) return renderDetail(c, order, 422, { form: formOf(f.errors) });

  const data = f.data as { version: number };
  if (data.version !== order.version) return renderConflict(c, ref);

  const now = Date.now();
  const p = await plan(stateOf(order), f.data, { order, now });
  if (!p.ok) return renderDetail(c, order, p.status, { form: formOf(translate(c, p.errors)) });

  const res = await orderWriter.applyChange(c, order.id, p.plan, now);
  if (res.ok) {
    const ret = (f.data as { return?: string }).return;
    const back = ret === 'queue' ? '/orders/queue' : ret === 'shipping' ? '/orders/shipping' : `/orders/${order.ref}`;
    return c.redirect(withFlash(back, 'saved'), 303);
  }
  // A parcel is being sent for this order: the open-slot guard (SHIP-1) refuses the change.
  if (res.code === 'shipment_in_progress') return renderDetail(c, order, 409, { shipmentBusy: true });
  switch (res.code) {
    case 'not_found':
      return c.notFound();
    case 'version_conflict':
      return renderConflict(c, ref);
    case 'forbidden':
      return renderDetail(c, order, 403, { form: formOf(translate(c, { _form: 'err.forbidden' })) });
    case 'illegal_transition':
    case 'not_callable':
      // The order moved on between our read and the batch: show its current state.
      return renderConflict(c, ref);
  }
}

r.post(`/${REF}/call`, requirePerm('orders.call'), (c) =>
  mutate(c, 'call', CallForm, async (state, data, { order, now }) => {
    const [{ events }, s] = await Promise.all([
      fetchOrderChildren(c.var.db, order.id, { withAudit: false, sensitive: canSeeSensitive(c.var.user) }),
      readCallSettings(c.var.db),
    ]);
    return planCall(state, data, { role: c.var.user.role, now, streak: unansweredStreak(events), settings: s });
  }),
);

r.post(`/${REF}/transition`, requirePerm('orders.transition'), (c) =>
  mutate(c, 'transition', TransitionForm, (state, data) => planTransition(state, data, { role: c.var.user.role })),
);

r.post(`/${REF}/note`, requirePerm('orders.note'), (c) =>
  mutate(c, 'note', NoteForm, (state, data) => planNote(state, data, { role: c.var.user.role })),
);

// ---------------------------------------------------------------------------------------------
// Claims (claims.ts). Not version-guarded on purpose: a claim is not business data.

r.post(`/${REF}/claim`, requirePerm('orders.call'), async (c) => {
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref'), canSeeSensitive(c.var.user));
  if (!order) return c.notFound();
  if (await claimOrder(c, order.id)) return c.redirect(withFlash(`/orders/${order.ref}`, 'saved'), 303);
  const fresh = (await fetchOrderByRef(c.var.db, order.ref, canSeeSensitive(c.var.user))) ?? order;
  return renderDetail(c, fresh, 409, { form: { kind: 'call', values: {}, errors: translate(c, { _form: 'err.claimTaken' }) } });
});

r.post(`/${REF}/release`, requirePerm('orders.call'), async (c) => {
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref'), canSeeSensitive(c.var.user));
  if (!order) return c.notFound();
  const back = (await readForm(c))['return'] === 'queue' ? '/orders/queue' : `/orders/${order.ref}`;
  if (await releaseOrder(c, order.id)) return c.redirect(withFlash(back, 'saved'), 303);
  return renderDetail(c, order, 409, { form: { kind: 'call', values: {}, errors: translate(c, { _form: 'err.nothingToRelease' }) } });
});

// ---------------------------------------------------------------------------------------------
// Contact/address edit (AORD-6). Confirmer before `confirmed`, owner until `shipped` (§0.4).

const currentOf = (o: OrderDetail): ContactCurrent => ({
  name: o.name,
  phoneE164: o.phoneE164,
  address: o.address,
  wilayaCode: o.wilayaCode,
  communeId: o.communeId,
  subtotalDzd: o.subtotalDzd,
  feeDzd: o.feeDzd,
  totalDzd: o.totalDzd,
  feeSource: o.feeSource,
});

async function renderContactEdit(
  c: Context<AppEnv>,
  order: OrderDetail,
  values: Record<string, string | undefined>,
  status: 200 | 409 | 422 = 200,
  errors?: Record<string, string>,
) {
  const w = Number(values['wilaya']);
  const wilaya = Number.isInteger(w) && w >= 1 && w <= 69 ? w : order.wilayaCode;
  const [wl, cl] = await Promise.all([
    c.var.db.select({ code: wilayas.code, nameFr: wilayas.nameFr, nameAr: wilayas.nameAr }).from(wilayas).orderBy(asc(wilayas.code)),
    communesOf(c.var.db, wilaya, c.var.lang),
  ]);
  const tm = m(c.var.lang);
  c.status(status);
  return c.render(
    <ContactEditPage lang={c.var.lang} order={order} wilayas={wl} communes={cl} values={values} {...(errors ? { errors } : {})} />,
    {
      title: tm('contact.title', { ref: `\u2066${order.ref}\u2069` }),
      breadcrumbs: [{ label: tm('list.title'), href: '/orders' }, { label: order.ref, href: `/orders/${order.ref}` }, { label: tm('contact.link') }],
    },
  );
}

function contactErrors(c: Context<AppEnv>, errors: Partial<Record<string, ContactErrKey>>): Record<string, string> {
  const tm = m(c.var.lang);
  const out: Record<string, string> = {};
  for (const [k, key] of Object.entries(errors)) if (key) out[k] = tm(key);
  return out;
}

/** Loads the order and applies the role × status rule; a Response when the user may not edit. */
async function editableOrder(c: Context<AppEnv>): Promise<OrderDetail | Response> {
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref') ?? '', canSeeSensitive(c.var.user));
  if (!order) return c.notFound();
  if (!canEditContact(c.var.user.role, order.status)) {
    return renderDetail(c, order, 403, { form: { kind: 'call', values: {}, errors: contactErrors(c, { _form: 'contact.err.notEditable' }) } });
  }
  return order;
}

r.get(`/${REF}/contact`, requirePerm('orders.edit'), async (c) => {
  const order = await editableOrder(c);
  if (order instanceof Response) return order;
  return renderContactEdit(c, order, {
    version: String(order.version),
    name: order.name,
    phone: order.phoneE164.replace(/^\+213/, '0'),
    wilaya: String(order.wilayaCode),
    commune: String(order.communeId),
    address: order.address ?? '',
  });
});

r.post(`/${REF}/contact`, requirePerm('orders.edit'), async (c) => {
  const order = await editableOrder(c);
  if (order instanceof Response) return order;
  const f = await parseForm(c, ContactForm);
  if (!f.ok) {
    // A wilaya change without JS lands here (commune of the old wilaya): show the new wilaya's communes.
    return renderContactEdit(c, order, f.values, 422, f.errors);
  }
  const input = f.data;
  if (input.version !== order.version) return renderConflict(c, order.ref);

  if (input.step === 'edit') {
    noAudit(c, 'contact edit: back to the form, nothing written');
    return renderContactEdit(c, order, f.values);
  }

  const cur = currentOf(order);
  const fees = feeProviderFor(c.var.db, c.env.ENV);
  const preview = await previewContact(c.var.db, order.id, cur, input, fees);
  if (!preview.ok) return renderContactEdit(c, order, f.values, 422, contactErrors(c, preview.errors));

  const [place] = await c.var.db
    .select({ wilayaFr: wilayas.nameFr, wilayaAr: wilayas.nameAr, communeFr: communes.nameFr, communeAr: communes.nameAr })
    .from(communes)
    .innerJoin(wilayas, eq(wilayas.code, communes.wilayaCode))
    .where(eq(communes.id, input.commune));
  const review = (priceChanged: boolean, status: 200 | 409) => {
    noAudit(c, 'contact edit review: nothing written');
    c.status(status);
    return c.render(
      <ContactReviewPage lang={c.var.lang} order={order} input={input} preview={preview} newPlace={place!} priceChanged={priceChanged} />,
      { title: m(c.var.lang)('contact.title', { ref: `\u2066${order.ref}\u2069` }) },
    );
  };
  if (input.step === 'review') return review(false, 200);
  // Save: the fee is recomputed server-side; if it moved since the review, show the new numbers first.
  if (input.previewTotal !== String(preview.totalDzd)) return review(true, 409);

  const { before, after } = contactAudit(cur, input, preview);
  const row = audit(c, { action: 'order.contact', entity: 'orders', entityId: order.id, before, after }, { when: orderGuard(order.id, input.version) });
  const res = await updateOrderContact(
    c.var.db,
    order.id,
    { name: preview.name, phone: input.phone, address: input.address, wilayaCode: input.wilaya, communeId: input.commune },
    fees,
    { userId: c.var.user.id, role: c.var.user.role },
    input.version,
    { extra: [row] },
  );
  if (res.ok) return c.redirect(withFlash(`/orders/${order.ref}`, 'saved'), 303);
  if (res.code === 'shipment_in_progress') return renderDetail(c, order, 409, { shipmentBusy: true });
  switch (res.code) {
    case 'not_found':
      return c.notFound();
    case 'version_conflict':
      return renderConflict(c, order.ref);
    case 'forbidden':
    case 'not_editable':
      return renderDetail(c, order, 403, { form: { kind: 'call', values: {}, errors: contactErrors(c, { _form: 'contact.err.notEditable' }) } });
    case 'phone_invalid':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { phone: 'contact.err.phone' }));
    case 'commune_invalid':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { commune: 'contact.err.commune' }));
    case 'area_unavailable':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { wilaya: 'contact.err.unavailable' }));
    case 'order_total_out_of_range':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { _form: 'contact.err.totalTooHigh' }));
    case 'nothing_to_change':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { _form: 'contact.err.nothing' }));
    case 'name_required':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { name: 'contact.err.nameRequired' }));
    case 'name_invalid':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { name: 'contact.err.nameInvalid' }));
    default: {
      // Exhaustive: a new DB-6 result code fails typecheck here instead of falling through.
      const unhandled: never = res.code;
      throw new Error(`updateOrderContact: unhandled result code ${String(unhandled)}`);
    }
  }
});

export default r;
