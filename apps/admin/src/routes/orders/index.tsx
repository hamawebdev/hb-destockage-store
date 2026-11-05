// Orders section (owner: admin-orders). Mounted at /orders by admin-core (app.ts).
// Plan: artifacts/AORD-0/plan.md. Rules: see the header of src/app.ts.
//
//   GET  /                    list, filters, search, keyset pagination        (AORD-1)
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
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { parseForm, type FormSchema } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { withFlash } from '../../ui/flash.tsx';
import { audit, noAudit } from '../../audit/audit.ts';
import { claimOrder, releaseOrder } from './claims.ts';
import { ContactForm, canEditContact, communesOf, contactAudit, feeProviderFor, previewContact, type ContactCurrent, type ContactErrKey } from './contact.ts';
import { ContactEditPage, ContactReviewPage } from './contact-page.tsx';
import { fetchOrderByRef, fetchOrderChildren, type OrderDetail } from './detail-data.ts';
import { OrderDetailPage, type DetailProps, type FormKind } from './detail-page.tsx';
import { fetchOrdersPage } from './list-data.ts';
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

const r = createRouter({ roles: rolesFor('orders.view') });

/** Public order ref in the URL. Anything else under /orders/ that is not a known path → 404. */
const REF = ':ref{HB-[0-9A-HJKMNP-TV-Z]{5}}';

r.get('/', requirePerm('orders.view'), async (c) => {
  const url = new URL(c.req.url);
  const parsed = parseOrdersFilter(url.searchParams, c.var.user.role);
  const page = await fetchOrdersPage(c.var.db, parsed.filter);
  const q = (url.searchParams.get('q') ?? '').slice(0, SEARCH_MAX_CHARS);
  return c.render(
    <OrdersListPage lang={c.var.lang} parsed={parsed} page={page} q={q} url={`${url.pathname}${url.search}`} />,
    { title: m(c.var.lang)('list.title') },
  );
});

// ---------------------------------------------------------------------------------------------
// Detail

async function renderDetail(
  c: Context<AppEnv>,
  order: OrderDetail,
  status: 200 | 403 | 409 | 422 = 200,
  extra: Pick<DetailProps, 'form' | 'conflict'> = {},
) {
  const children = await fetchOrderChildren(c.var.db, order.id, { withAudit: c.var.user.role === 'owner' });
  const tm = m(c.var.lang);
  c.status(status);
  return c.render(
    <OrderDetailPage lang={c.var.lang} user={c.var.user} now={Date.now()} order={order} {...children} {...extra} />,
    {
      // LRI … PDI: the ref stays left-to-right inside the Arabic title.
      title: tm('detail.title', { ref: `\u2066${order.ref}\u2069` }),
      breadcrumbs: [{ label: tm('list.title'), href: '/orders' }, { label: order.ref }],
    },
  );
}

r.get(`/${REF}`, requirePerm('orders.view'), async (c) => {
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref'));
  if (!order) return c.notFound();
  return renderDetail(c, order);
});

// ---------------------------------------------------------------------------------------------
// Mutations

const stateOf = (o: OrderDetail): OrderState => ({
  status: o.status,
  version: o.version,
  callAttempts: o.callAttempts,
  nextCallAt: o.nextCallAt,
  flags: o.flags,
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
  const fresh = await fetchOrderByRef(c.var.db, ref);
  if (!fresh) return c.notFound();
  const { events } = await fetchOrderChildren(c.var.db, fresh.id, { withAudit: false });
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
  const order = await fetchOrderByRef(c.var.db, ref);
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
  if (res.ok) return c.redirect(withFlash(`/orders/${order.ref}`, 'saved'), 303);
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
      fetchOrderChildren(c.var.db, order.id, { withAudit: false }),
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
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref'));
  if (!order) return c.notFound();
  if (await claimOrder(c, order.id)) return c.redirect(withFlash(`/orders/${order.ref}`, 'saved'), 303);
  const fresh = (await fetchOrderByRef(c.var.db, order.ref)) ?? order;
  return renderDetail(c, fresh, 409, { form: { kind: 'call', values: {}, errors: translate(c, { _form: 'err.claimTaken' }) } });
});

r.post(`/${REF}/release`, requirePerm('orders.call'), async (c) => {
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref'));
  if (!order) return c.notFound();
  if (await releaseOrder(c, order.id)) return c.redirect(withFlash(`/orders/${order.ref}`, 'saved'), 303);
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
  const order = await fetchOrderByRef(c.var.db, c.req.param('ref') ?? '');
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
    { name: input.name, phone: input.phone, address: input.address, wilayaCode: input.wilaya, communeId: input.commune },
    fees,
    { userId: c.var.user.id, role: c.var.user.role },
    input.version,
    { extra: [row] },
  );
  if (res.ok) return c.redirect(withFlash(`/orders/${order.ref}`, 'saved'), 303);
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
    case 'nothing_to_change':
      return renderContactEdit(c, order, f.values, 422, contactErrors(c, { _form: 'contact.err.nothing' }));
  }
});

export default r;
