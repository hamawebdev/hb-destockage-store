// Stock screen (ACAT-7, H). Plan: artifacts/ACAT-7/plan.md (approved with the §7 changes).
// Roles: `stock.edit` (owner, content, logistics). Only `variants.stock` (and the version bump) is writable here.
//
// GET  /products/stock               list + filters (q, category, state, archived)
// POST /products/stock/set           { variant_id, stock, was }            conditional on stock == was
// POST /products/stock/adjust        { variant_id, delta, reason, note }   relative, never below 0
// GET  /products/stock/track?variant=ID   confirm page (track with a count / untrack)
// POST /products/stock/track         { variant_id, track, stock?, was?, confirm }
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { categories, products, variants } from '@hb/db';
import { audit, noAudit } from '../../audit/audit.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { parseForm, vCheckbox, vOptionalInt, vOptionalText, vPicklist } from '../../lib/forms.ts';
import { DEFAULT_PAGE_SIZE, offsetOf, pageCount, parsePage } from '../../lib/pagination.ts';
import { useUi } from '../../ui/context.ts';
import { Bdi, Num } from '../../ui/format.tsx';
import { ErrorSummary, Form, FormActions, NumberInput, Select, Submit, TextInput, type FieldErrors } from '../../ui/form.tsx';
import { withFlash } from '../../ui/flash.tsx';
import { Pagination } from '../../ui/pagination.tsx';
import { loadCategories } from '../categories/data.ts';
import { descendantIds } from '../categories/tree.ts';
import { bumpUpdatedAt } from './lib/diff.ts';
import { fieldMessages } from './lib/field-messages.ts';
import { guard, isGuardAbort } from './lib/guard.ts';
import { cleanText } from './lib/text.ts';
import { m } from './messages.ts';

type Ctx = Context<AppEnv>;

/** = pagedata's default `lowStockThreshold` (packages/catalog build.ts): "low stock" on the storefront. */
export const LOW_STOCK = 3;
export const STOCK_MAX = 9_999_999;
export const DELTA_MAX = 999_999;
export const ADJUST_REASONS = ['received', 'count', 'damaged', 'returned_to_supplier', 'other'] as const;
const STATES = ['tracked', 'out', 'low', 'untracked', 'all'] as const;
type State = (typeof STATES)[number];

const optionalInt = (min: number, max: number) => v.optional(vOptionalInt(min, max), '');
const SetSchema = v.strictObject({ variant_id: optionalInt(1, Number.MAX_SAFE_INTEGER), stock: optionalInt(0, STOCK_MAX), was: optionalInt(0, STOCK_MAX), back: v.optional(v.string(), '') });
const AdjustSchema = v.strictObject({
  variant_id: optionalInt(1, Number.MAX_SAFE_INTEGER),
  delta: optionalInt(-DELTA_MAX, DELTA_MAX),
  reason: vPicklist(ADJUST_REASONS),
  note: v.optional(vOptionalText(200), ''),
  back: v.optional(v.string(), ''),
});
const TrackSchema = v.strictObject({
  variant_id: optionalInt(1, Number.MAX_SAFE_INTEGER),
  track: vPicklist(['1', '0'] as const),
  stock: optionalInt(0, STOCK_MAX),
  was: optionalInt(0, STOCK_MAX),
  confirm: vCheckbox(),
  back: v.optional(v.string(), ''),
});

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

export interface StockRow {
  variantId: number;
  productId: number;
  productNameFr: string;
  productNameAr: string;
  status: string;
  sku: string;
  stock: number | null;
  labelFr: string | null;
  labelAr: string | null;
}

const labelSql = (col: 'fr' | 'ar') =>
  col === 'fr'
    ? sql<string | null>`(select group_concat(ov.value_fr, ' / ') from variant_option_values vov join option_values ov on ov.id = vov.option_value_id where vov.variant_id = ${variants.id})`
    : sql<string | null>`(select group_concat(ov.value_ar, ' / ') from variant_option_values vov join option_values ov on ov.id = vov.option_value_id where vov.variant_id = ${variants.id})`;

const rowColumns = {
  variantId: variants.id,
  productId: products.id,
  productNameFr: products.nameFr,
  productNameAr: products.nameAr,
  status: products.status,
  sku: variants.sku,
  stock: variants.stock,
  labelFr: labelSql('fr'),
  labelAr: labelSql('ar'),
};

export interface StockFilters {
  q: string | null;
  categoryIds: number[] | null;
  state: State;
  archived: boolean;
}

async function listStock(c: Ctx, f: StockFilters, page: number): Promise<{ rows: StockRow[]; total: number }> {
  const where: SQL[] = [];
  if (f.q !== null) {
    // instr(), not LIKE (D1 rejects LIKE patterns over ~50 bytes).
    where.push(sql`(instr(lower(${products.nameFr}), lower(${f.q})) > 0 or instr(${products.nameAr}, ${f.q}) > 0 or instr(lower(${variants.sku}), lower(${f.q})) > 0)`);
  }
  if (f.categoryIds !== null) where.push(f.categoryIds.length === 0 ? sql`0` : inArray(products.categoryId, f.categoryIds));
  if (!f.archived) where.push(sql`${products.status} <> 'archived'`);
  if (f.state === 'tracked') where.push(sql`${variants.stock} is not null`);
  if (f.state === 'out') where.push(sql`${variants.stock} = 0`);
  if (f.state === 'low') where.push(sql`${variants.stock} between 1 and ${LOW_STOCK}`);
  if (f.state === 'untracked') where.push(sql`${variants.stock} is null`);
  const cond = where.length > 0 ? and(...where) : undefined;
  const db = c.var.db;
  const [rows, totals] = await Promise.all([
    db
      .select(rowColumns)
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(categories, eq(categories.id, products.categoryId))
      .where(cond)
      .orderBy(sql`${variants.stock} is null`, asc(variants.stock), asc(products.nameFr), asc(variants.position), asc(variants.id))
      .limit(DEFAULT_PAGE_SIZE)
      .offset(offsetOf(page)),
    db.select({ n: sql<number>`count(*)` }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(cond),
  ]);
  return { rows, total: totals[0]?.n ?? 0 };
}

async function loadRow(c: Ctx, variantId: number): Promise<StockRow | undefined> {
  const [row] = await c.var.db.select(rowColumns).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, variantId)).limit(1);
  return row;
}

const run = (c: Ctx, items: BatchItem<'sqlite'>[]) => c.var.db.batch(items as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
const stockWrite = (c: Ctx, id: number, stock: number | null) =>
  c.var.db.update(variants).set({ stock, updatedAt: bumpUpdatedAt() }).where(eq(variants.id, id));
const stockIs = (c: Ctx, id: number, expected: number | null) =>
  guard(c.var.db, sql`exists (select 1 from ${variants} where ${variants.id} = ${id} and ${variants.stock} is ${expected})`);

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

const label = (r: StockRow, lang: 'fr' | 'ar') => {
  const name = lang === 'ar' ? r.productNameAr : r.productNameFr;
  const values = lang === 'ar' ? r.labelAr : r.labelFr;
  return values ? `${name} — ${values}` : name;
};

function StockPage(props: {
  rows: readonly StockRow[];
  filters: Record<string, string>;
  categoryOptions: { value: string; label: string }[];
  page: number;
  pages: number;
  baseUrl: string;
  back: string;
  errors?: FieldErrors | undefined;
}) {
  const { lang, t } = useUi();
  const tm = m(lang);
  return (
    <>
      <Form action="/products/stock" method="get" class="form">
        <TextInput name="q" type="search" label={tm('filter.q')} value={props.filters['q']} maxlength={100} />
        <Select name="category" label={tm('filter.category')} value={props.filters['category']} options={[{ value: '', label: tm('filter.all') }, ...props.categoryOptions]} />
        <Select name="state" label={tm('stock.filter.state')} value={props.filters['state']} options={STATES.map((s) => ({ value: s, label: tm(`stock.state.${s}`) }))} />
        <FormActions>
          <Submit variant="secondary">{t('common.filter')}</Submit>
          <a class="btn btn--quiet" href="/products/stock">{t('common.reset')}</a>
        </FormActions>
      </Form>
      <ErrorSummary errors={props.errors} />
      {props.rows.length === 0 ? (
        <p class="empty">{tm('empty')}</p>
      ) : (
        // One card per variant (not a table): at 360 px every control stays on screen.
        <ol class="stock-list" aria-label={tm('stock.caption')}>
          {props.rows.map((r) => (
            <li class="panel" role="group" aria-labelledby={`card-${r.variantId}`}>
              <h3 id={`card-${r.variantId}`}>
                <a href={`/products/${r.productId}`}>{label(r, lang)}</a>
                {r.status !== 'active' ? <> ({tm(`status.${r.status}` as 'status.draft')})</> : null}
              </h3>
              <p>
                <Bdi ltr>{r.sku}</Bdi> · {tm('col.stock')}{lang === 'ar' ? ': ' : ' : '}
                <strong>{r.stock === null ? tm('stock.untracked') : <Num value={r.stock} />}</strong>
              </p>
              {r.stock !== null ? (
                <>
                  <Form action="/products/stock/set">
                    <input type="hidden" name="variant_id" value={String(r.variantId)} />
                    <input type="hidden" name="was" value={String(r.stock)} />
                    <input type="hidden" name="back" value={props.back} />
                    <NumberInput name="stock" idSuffix={r.variantId} label={tm('stock.set')} value={String(r.stock)} />
                    <FormActions>
                      <Submit variant="secondary">{tm('stock.setButton')}</Submit>
                    </FormActions>
                  </Form>
                  <Form action="/products/stock/adjust">
                    <input type="hidden" name="variant_id" value={String(r.variantId)} />
                    <input type="hidden" name="back" value={props.back} />
                    <NumberInput name="delta" idSuffix={r.variantId} label={tm('stock.delta')} hint={tm('stock.deltaHint')} />
                    <Select name="reason" idSuffix={r.variantId} label={tm('stock.reason')} options={ADJUST_REASONS.map((x) => ({ value: x, label: tm(`stock.reason.${x}`) }))} />
                    <TextInput name="note" idSuffix={r.variantId} label={tm('stock.note')} maxlength={200} />
                    <FormActions>
                      <Submit variant="secondary">{tm('stock.adjustButton')}</Submit>
                    </FormActions>
                  </Form>
                </>
              ) : null}
              <p>
                <a class="btn btn--quiet" href={`/products/stock/track?variant=${r.variantId}&back=${encodeURIComponent(props.back)}`}>
                  {r.stock === null ? tm('stock.track') : tm('stock.untrack')}
                </a>
              </p>
            </li>
          ))}
        </ol>
      )}
      <Pagination page={props.page} pages={props.pages} baseUrl={props.baseUrl} />
    </>
  );
}

function TrackPage(props: { row: StockRow; back: string; errors?: FieldErrors | undefined }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const r = props.row;
  const tracking = r.stock === null; // the action offered: start tracking
  return (
    <Form action="/products/stock/track">
      <ErrorSummary errors={props.errors} />
      <p>
        <strong>{label(r, lang)}</strong> <Bdi ltr>({r.sku})</Bdi>
      </p>
      <div class="callout callout--warning">
        <p><strong>{tracking ? tm('stock.track.title') : tm('stock.untrack.title')}</strong></p>
        <p>{tracking ? tm('stock.track.warning') : tm('stock.untrack.warning')}</p>
      </div>
      <input type="hidden" name="variant_id" value={String(r.variantId)} />
      <input type="hidden" name="track" value={tracking ? '1' : '0'} />
      <input type="hidden" name="back" value={props.back} />
      {tracking ? (
        <NumberInput name="stock" label={tm('stock.track.count')} required error={props.errors?.['stock']} />
      ) : (
        <input type="hidden" name="was" value={String(r.stock)} />
      )}
      <div class="field field--check">
        <input type="checkbox" class="check" id="f-confirm" name="confirm" value="1" />
        <label for="f-confirm">{tm('stock.confirm')}</label>
        {props.errors?.['confirm'] ? <p class="field__error">{props.errors['confirm']}</p> : null}
      </div>
      <FormActions>
        <Submit variant={tracking ? 'primary' : 'danger'}>{tracking ? tm('stock.track') : tm('stock.untrack')}</Submit>
        <a class="btn btn--secondary" href={props.back}>{t('common.cancel')}</a>
      </FormActions>
    </Form>
  );
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** Only `/products/stock` with known filter params: never an open redirect. */
export function safeBack(raw: string | undefined): string {
  const fallback = '/products/stock';
  if (raw === undefined || raw === '') return fallback;
  let u: URL;
  try {
    u = new URL(raw, 'http://x');
  } catch {
    return fallback;
  }
  if (u.origin !== 'http://x' || u.pathname !== '/products/stock') return fallback;
  const out = new URLSearchParams();
  for (const k of ['q', 'category', 'state', 'archived', 'page']) {
    const val = u.searchParams.get(k);
    if (val !== null && val.length <= 100) out.set(k, val);
  }
  return out.size > 0 ? `${fallback}?${out}` : fallback;
}

function filtersOf(c: Ctx, cats: Awaited<ReturnType<typeof loadCategories>>): { filters: StockFilters; raw: Record<string, string> } {
  const q = cleanText((c.req.query('q') ?? '').slice(0, 100));
  const cat = c.req.query('category') ?? '';
  const catId = /^\d{1,9}$/.test(cat) ? Number(cat) : null;
  const stateRaw = c.req.query('state') ?? 'tracked';
  const state = (STATES as readonly string[]).includes(stateRaw) ? (stateRaw as State) : 'tracked';
  const filters: StockFilters = {
    q: q.ok && q.value !== '' ? q.value : null,
    categoryIds: catId === null ? null : [...descendantIds(cats, catId)],
    state,
    archived: c.req.query('archived') === '1',
  };
  return { filters, raw: { q: filters.q ?? '', category: catId === null ? '' : String(catId), state } };
}

export function mountStockRoutes(r: Hono<AppEnv>): void {
  const title = (c: Ctx) => m(c.var.lang)('stock.title');
  const crumbs = (c: Ctx) => [{ label: m(c.var.lang)('title'), href: '/products' }];

  const renderList = async (c: Ctx, errors?: Record<string, string>) => {
    const cats = await loadCategories(c);
    const { filters, raw } = filtersOf(c, cats);
    const page = parsePage(c);
    const { rows, total } = await listStock(c, filters, page);
    const qs = new URLSearchParams(Object.entries(raw).filter(([, val]) => val !== ''));
    const baseUrl = `/products/stock${qs.size > 0 ? `?${qs}` : ''}`;
    return c.render(
      <StockPage
        rows={rows}
        filters={raw}
        categoryOptions={cats.map((k) => ({ value: String(k.id), label: c.var.lang === 'ar' ? k.nameAr : k.nameFr }))}
        page={page}
        pages={pageCount(total)}
        baseUrl={baseUrl}
        back={page > 1 ? `${baseUrl}${qs.size > 0 ? '&' : '?'}page=${page}` : baseUrl}
        errors={errors}
      />,
      { title: title(c), breadcrumbs: crumbs(c) },
    );
  };

  r.get('/stock', requirePerm('stock.edit'), (c) => renderList(c));

  /** Re-renders the stock list with the error at the top (the POST has no filters: default view). */
  const fail = async (c: Ctx, status: 409 | 422, _back: string, errors: Record<string, string>) => {
    c.status(status);
    return renderList(c, errors);
  };

  r.post('/stock/set', requirePerm('stock.edit'), async (c) => {
    const tm = m(c.var.lang);
    const f = await parseForm(c, SetSchema);
    const back = safeBack(f.values['back']);
    if (!f.ok) return fail(c, 422, back, f.errors);
    const { variant_id: id, stock, was } = f.data;
    if (id === null || stock === null || was === null) return fail(c, 422, back, { stock: c.var.t('form.required') });
    const row = await loadRow(c, id);
    if (row === undefined) return c.notFound();
    if (stock === was) {
      // Nothing to change: the shown value is the requested one.
      noAudit(c, 'stock set to the value already shown: nothing written');
      return c.redirect(back, 303);
    }
    try {
      await run(c, [
        stockIs(c, id, was),
        stockWrite(c, id, stock),
        audit(c, { action: 'stock.set', entity: 'variants', entityId: id, before: { sku: row.sku, stock: was }, after: { sku: row.sku, stock } }),
      ]);
    } catch (err) {
      if (!isGuardAbort(err)) throw err;
      const now = (await loadRow(c, id))?.stock;
      return fail(c, 409, back, { [`stock`]: tm('err.stock_moved', { now: now === null || now === undefined ? '—' : now }) });
    }
    return c.redirect(withFlash(back, 'saved'), 303);
  });

  r.post('/stock/adjust', requirePerm('stock.edit'), async (c) => {
    const tm = m(c.var.lang);
    const f = await parseForm(c, AdjustSchema);
    const back = safeBack(f.values['back']);
    if (!f.ok) return fail(c, 422, back, f.errors);
    const { variant_id: id, delta, reason } = f.data;
    if (id === null || delta === null || delta === 0) return fail(c, 422, back, { delta: c.var.t('form.required') });
    let note: string | null = null;
    if (f.data.note !== null && f.data.note !== '') {
      const n = cleanText(f.data.note);
      if (!n.ok) return fail(c, 422, back, { note: fieldMessages(c.var.lang)('err.unsafe_char') });
      note = n.value;
    }
    // Relative change applied to the stock as it is now. Each attempt is conditional on the value it
    // read (so the audit row records the exact before/after); an order landing in between makes the
    // attempt fail and it is retried with the new value.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await loadRow(c, id);
      if (row === undefined) return c.notFound();
      if (row.stock === null) return fail(c, 422, back, { delta: tm('stock.err.untracked') });
      const next = row.stock + delta;
      if (next < 0) return fail(c, 422, back, { delta: tm('stock.err.negative', { now: row.stock }) });
      try {
        await run(c, [
          stockIs(c, id, row.stock),
          stockWrite(c, id, next),
          audit(c, { action: 'stock.adjust', entity: 'variants', entityId: id, before: { sku: row.sku, stock: row.stock }, after: { sku: row.sku, stock: next, delta, reason, note } }),
        ]);
        return c.redirect(withFlash(back, 'saved'), 303);
      } catch (err) {
        if (!isGuardAbort(err)) throw err;
      }
    }
    return fail(c, 409, back, { _form: fieldMessages(c.var.lang)('err.stale') });
  });

  r.get('/stock/track', requirePerm('stock.edit'), async (c) => {
    const raw = c.req.query('variant') ?? '';
    const row = /^\d{1,15}$/.test(raw) ? await loadRow(c, Number(raw)) : undefined;
    if (row === undefined) return c.notFound();
    const tm = m(c.var.lang);
    return c.render(<TrackPage row={row} back={safeBack(c.req.query('back'))} />, {
      title: row.stock === null ? tm('stock.track') : tm('stock.untrack'),
      breadcrumbs: [...crumbs(c), { label: title(c), href: '/products/stock' }],
    });
  });

  r.post('/stock/track', requirePerm('stock.edit'), async (c) => {
    const tm = m(c.var.lang);
    const f = await parseForm(c, TrackSchema);
    const back = safeBack(f.values['back']);
    const id = f.ok ? f.data.variant_id : null;
    const row = id === null ? undefined : await loadRow(c, id);
    if (row === undefined) return f.ok ? c.notFound() : fail(c, 422, back, f.errors);
    const again = (status: 409 | 422, errors: Record<string, string>) => {
      c.status(status);
      return c.render(<TrackPage row={row} back={back} errors={errors} />, { title: tm('stock.title'), breadcrumbs: crumbs(c) });
    };
    if (!f.ok) return again(422, f.errors);
    if (!f.data.confirm) return again(422, { confirm: tm('stock.err.confirm') });
    const tracking = f.data.track === '1';
    if (tracking && f.data.stock === null) return again(422, { stock: c.var.t('form.required') });
    if (!tracking && f.data.was === null) return again(422, { _form: fieldMessages(c.var.lang)('err.stale') });
    const expected = tracking ? null : f.data.was;
    const next = tracking ? f.data.stock : null;
    try {
      await run(c, [
        stockIs(c, row.variantId, expected),
        stockWrite(c, row.variantId, next),
        audit(c, { action: 'stock.track', entity: 'variants', entityId: row.variantId, before: { sku: row.sku, stock: expected }, after: { sku: row.sku, stock: next } }),
      ]);
    } catch (err) {
      if (!isGuardAbort(err)) throw err;
      const fresh = (await loadRow(c, row.variantId)) ?? row;
      c.status(409);
      return c.render(<TrackPage row={fresh} back={back} errors={{ _form: fieldMessages(c.var.lang)('err.stale') }} />, { title: tm('stock.title'), breadcrumbs: crumbs(c) });
    }
    return c.redirect(withFlash(back, 'saved'), 303);
  });
}
