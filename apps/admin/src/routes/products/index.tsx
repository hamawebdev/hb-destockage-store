// /products (ACAT-2): products, options, variant matrix, variant grid, status. Owner: admin-catalog.
// Plan: artifacts/ACAT-0/plan.md §3–§4.
//
// GET  /                      list + filters (catalog.view)
// GET  /new, POST /           create (catalog.edit): draft product + its default variant
// GET  /:id                   edit page (catalog.edit) or read-only view (catalog.view)
// POST /:id                   details (catalog.edit)
// POST /:id/options           options form → matrix preview (read-only POST, nothing written)
// POST /:id/options/apply     options + matrix applied in one batch (catalog.edit)
// POST /:id/variants          variant grid: SKU, prices, stock, weight, active, default (catalog.edit)
// POST /:id/status            draft / active / archived; `active` runs the activation check
// GET  /:id/delete, POST      delete when never ordered and not in a pack (else archive)
import type { Context } from 'hono';
import * as v from 'valibot';
import type { Category } from '@hb/db';
import { PRODUCT_KINDS, PRODUCT_STATUSES } from '@hb/db';
import { noAudit } from '../../audit/audit.ts';
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { paramId, parseForm, readForm, validateForm, vOptionalInt, vPicklist } from '../../lib/forms.ts';
import { DEFAULT_PAGE_SIZE, offsetOf, pageCount, parsePage } from '../../lib/pagination.ts';
import { createRouter } from '../../lib/router.ts';
import { withFlash } from '../../ui/flash.tsx';
import { loadCategories } from '../categories/data.ts';
import { descendantIds } from '../categories/tree.ts';
import { uniqueViolation } from './lib/db-errors.ts';
import { fieldMessages } from './lib/field-messages.ts';
import { isGuardAbort } from './lib/guard.ts';
import { AUTO_SKU_PREFIX, generateMatrix, MATRIX_LIMITS, nextAutoSku, SKU_RE, type MatrixError, type MatrixPlan } from './lib/matrix.ts';
import { cleanText } from './lib/text.ts';
import {
  activationIssues,
  applyOptions,
  createProduct,
  deleteProduct,
  isReferenced,
  listProducts,
  loadAggregate,
  maxIds,
  saveGrid,
  setStatus,
  skusWithPrefix,
  takenSkus,
  updateDetails,
  withTempIds,
  type ActivationIssue,
  type ProductAggregate,
} from './data.ts';
import { m } from './messages.ts';
import { loadPackLines, loadPickable, mountPackRoutes, PackSection } from './pack.tsx';
import { mountStockRoutes } from './stock.tsx';
import { mountStockAlertRoutes } from './alerts.tsx';
import { bindChoices, loadImages } from '../media/data.ts';
import { PhotosSection } from '../media/views.tsx';
import {
  CreateSchema,
  DetailsSchema,
  finishDetails,
  finishFirstVariant,
  finishGrid,
  finishOptions,
  gridSchema,
  optionsSchema,
  suggestBaseSku,
  type ErrorKey,
} from './validate.ts';
import {
  brokenProductUrls,
  CreateForm,
  DeletePage,
  DetailsForm,
  gridValuesOf,
  MatrixPreview,
  OptionsForm,
  optionValuesOf,
  ProductList,
  ProductReadonly,
  StatusSection,
  VariantGrid,
} from './views.tsx';

type Ctx = Context<AppEnv>;

const r = createRouter({ roles: rolesFor('catalog.view') });

const EmptyForm = v.strictObject({});
const optionalInt = (min: number, max: number) => v.optional(vOptionalInt(min, max), '');
const StatusSchema = v.strictObject({ to: vPicklist(PRODUCT_STATUSES), v: optionalInt(0, Number.MAX_SAFE_INTEGER) });

const tm = (c: Ctx) => m(c.var.lang);
const crumbs = (c: Ctx) => [{ label: tm(c)('title'), href: '/products' }];
const nameOf = (c: Ctx, p: { nameFr: string; nameAr: string }) => (c.var.lang === 'ar' ? p.nameAr : p.nameFr);

function translate(c: Ctx, errors: Readonly<Record<string, ErrorKey>>): Record<string, string> {
  const t1 = tm(c);
  const tf = fieldMessages(c.var.lang);
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(errors)) {
    out[field] = key === 'form.required' ? c.var.t('form.required') : key.startsWith('err.slug') || key === 'err.unsafe_char' || key === 'err.stale' ? tf(key as Parameters<typeof tf>[0]) : t1(key as Parameters<typeof t1>[0]);
  }
  return out;
}

function matrixErrors(c: Ctx, errors: readonly MatrixError[], agg: ProductAggregate): Record<string, string> {
  const t1 = tm(c);
  const out: Record<string, string> = {};
  for (const e of errors) {
    const sku = (ids: readonly number[]) => agg.variants.filter((x) => ids.includes(x.id)).map((x) => x.sku).join(', ');
    out[`_matrix_${e.code}`] =
      e.code === 'too_many_combinations'
        ? t1('matrix.err.too_many_combinations', { count: e.count })
        : e.code === 'referenced_conflict'
          ? t1('matrix.err.referenced_conflict', { skus: sku(e.variantIds) })
          : t1(`matrix.err.${e.code}`);
  }
  return out;
}

/** Slug owners among products, for the uniqueness pre-check (excluding `selfId`). */
async function productSlugTaken(c: Ctx, selfId: number | null) {
  const rows = await c.var.db.query.products.findMany({ columns: { id: true, slugFr: true, slugAr: true } });
  return (lang: 'fr' | 'ar', slug: string) => rows.some((p) => p.id !== selfId && (lang === 'fr' ? p.slugFr : p.slugAr) === slug);
}

function detailsValuesOf(p: ProductAggregate['product']): Record<string, string> {
  const out: Record<string, string> = {
    category_id: p.categoryId === null ? '' : String(p.categoryId),
    name_fr: p.nameFr,
    name_ar: p.nameAr,
    brand_latin: p.brandLatin ?? '',
    summary_fr: p.summaryFr,
    summary_ar: p.summaryAr,
    description_fr: p.descriptionFr,
    description_ar: p.descriptionAr,
    slug_fr: p.slugFr,
    slug_ar: p.slugAr,
    sort: String(p.sort),
    v: String(p.updatedAt),
  };
  if (p.placeholder) out['placeholder'] = '1';
  if (p.translationPlaceholder.includes('fr')) out['tp_fr'] = '1';
  if (p.translationPlaceholder.includes('ar')) out['tp_ar'] = '1';
  return out;
}

interface EditOverrides {
  details?: { values: Record<string, string>; errors?: Record<string, string>; slugWarning?: string[] };
  options?: { values: Record<string, string>; errors?: Record<string, string> };
  grid?: { values: Record<string, string>; errors?: Record<string, string> };
  issues?: ActivationIssue[];
  pack?: { errors: Record<string, string> };
}

async function renderEdit(c: Ctx, agg: ProductAggregate, o: EditOverrides = {}) {
  const cats = await loadCategories(c);
  const p = agg.product;
  const [packLines, pickable] = p.kind === 'pack' ? await Promise.all([loadPackLines(c, p.id), loadPickable(c)]) : [[], []];
  const [photos, choices] = await Promise.all([loadImages(c, { kind: 'product', id: p.id }), bindChoices(c, p.id)]);
  return c.render(
    <>
      <DetailsForm
        id={p.id}
        values={o.details?.values ?? detailsValuesOf(p)}
        errors={o.details?.errors}
        categories={cats}
        slugWarning={o.details?.slugWarning}
      />
      {p.kind === 'pack' ? <PackSection agg={agg} lines={packLines} pickable={pickable} errors={o.pack?.errors} /> : null}
      {p.kind !== 'pack' ? (
        <OptionsForm
          id={p.id}
          values={o.options?.values ?? optionValuesOf(agg, suggestBaseSku(agg.variants.map((x) => x.sku)))}
          errors={o.options?.errors}
          maxOptions={MATRIX_LIMITS.maxOptions}
        />
      ) : null}
      <VariantGrid agg={agg} values={o.grid?.values ?? gridValuesOf(agg)} errors={o.grid?.errors} />
      <PhotosSection owner={{ kind: 'product', id: p.id }} images={photos} choices={choices} />
      <StatusSection agg={agg} issues={o.issues} />
    </>,
    { title: `${tm(c)('edit')}${c.var.lang === 'ar' ? ': ' : ' : '}${nameOf(c, p)}`, breadcrumbs: crumbs(c) },
  );
}

async function loadOr404(c: Ctx): Promise<ProductAggregate | null> {
  const id = paramId(c);
  return id === null ? null : loadAggregate(c, id);
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

r.get('/', requirePerm('catalog.view'), async (c) => {
  const cats = await loadCategories(c);
  const qRaw = c.req.query('q') ?? '';
  const q = cleanText(qRaw.slice(0, 100));
  const category = c.req.query('category') ?? '';
  const status = c.req.query('status') ?? '';
  const kind = c.req.query('kind') ?? '';
  const catId = /^\d{1,9}$/.test(category) ? Number(category) : null;
  const filters = {
    q: q.ok && q.value !== '' ? q.value : null,
    categoryIds: catId === null ? null : [...descendantIds(cats, catId)],
    status: (PRODUCT_STATUSES as readonly string[]).includes(status) ? (status as (typeof PRODUCT_STATUSES)[number]) : null,
    kind: (PRODUCT_KINDS as readonly string[]).includes(kind) ? (kind as (typeof PRODUCT_KINDS)[number]) : null,
  };
  const page = parsePage(c);
  const { rows, total } = await listProducts(c, filters, DEFAULT_PAGE_SIZE, offsetOf(page));
  const qs = new URLSearchParams();
  if (filters.q !== null) qs.set('q', filters.q);
  if (catId !== null) qs.set('category', String(catId));
  if (filters.status !== null) qs.set('status', filters.status);
  if (filters.kind !== null) qs.set('kind', filters.kind);
  return c.render(
    <ProductList
      rows={rows}
      categories={cats}
      filters={{ q: filters.q ?? '', category: catId === null ? '' : String(catId), status: filters.status ?? '', kind: filters.kind ?? '' }}
      page={page}
      pages={pageCount(total)}
      baseUrl={`/products${qs.size > 0 ? `?${qs}` : ''}`}
    />,
    {
      title: tm(c)('title'),
      actions: (
        <>
          {can(c.var.user, 'stock.edit') ? <a class="btn btn--secondary" href="/products/stock">{tm(c)('stock.link')}</a> : null}
          {can(c.var.user, 'catalog.edit') ? <a class="btn btn--primary" href="/products/new">{tm(c)('new')}</a> : null}
        </>
      ),
    },
  );
});

// Stock screen (ACAT-7): registered before `/:id` so `/stock` is not taken for an id.
mountStockAlertRoutes(r);
mountStockRoutes(r);

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

r.get('/new', requirePerm('catalog.edit'), async (c) => {
  const cats = await loadCategories(c);
  const values: Record<string, string> = { kind: 'simple', sort: '0' };
  const cat = c.req.query('category');
  if (cat !== undefined && /^\d{1,9}$/.test(cat)) values['category_id'] = cat;
  // Proposed SKU: editable, and re-checked on save (`sku_auto` tells the POST it was left untouched).
  const sku = nextAutoSku(await skusWithPrefix(c, AUTO_SKU_PREFIX));
  values['sku'] = sku;
  values['sku_auto'] = sku;
  return c.render(<CreateForm values={values} categories={cats} />, { title: tm(c)('new'), breadcrumbs: crumbs(c) });
});

r.post('/', requirePerm('catalog.edit'), async (c) => {
  const cats = await loadCategories(c);
  const f = await parseForm(c, CreateSchema);
  const render = (status: 409 | 422, errors: Record<string, string>) => {
    c.status(status);
    return c.render(<CreateForm values={f.values} errors={errors} categories={cats} />, { title: tm(c)('new'), breadcrumbs: crumbs(c) });
  };
  if (!f.ok) return render(422, f.errors);
  const details = finishDetails(f.data, { categoryIds: new Set(cats.map((k) => k.id)), slugTaken: await productSlugTaken(c, null) });
  // SKU: the one typed. Left empty, or left as proposed while another product took it meanwhile: the next automatic one.
  let sku = f.data.sku ?? nextAutoSku(await skusWithPrefix(c, AUTO_SKU_PREFIX));
  let taken = await takenSkus(c, [sku]);
  if (taken.has(sku) && f.data.sku !== null && f.data.sku === f.data.sku_auto) {
    sku = nextAutoSku(await skusWithPrefix(c, AUTO_SKU_PREFIX));
    taken = await takenSkus(c, [sku]);
  }
  const first = finishFirstVariant(f.data, sku, (s) => taken.has(s));
  if (!details.ok || !first.ok) return render(422, translate(c, { ...(details.ok ? {} : details.errors), ...(first.ok ? {} : first.errors) }));
  try {
    const id = await createProduct(c, f.data.kind, details.row, {
      sku,
      priceDzd: f.data.price,
      compareAtDzd: f.data.compare_at,
      stock: f.data.stock,
      weightG: f.data.weight,
    });
    return c.redirect(withFlash(`/products/${id}`, 'created'), 303);
  } catch (err) {
    const u = uniqueViolation(err);
    if (u === null) throw err;
    const field = u.table === 'variants' ? 'sku' : u.column;
    return render(409, translate(c, { [field]: u.table === 'variants' ? 'err.sku_taken' : 'err.slug_taken' }));
  }
});

// ---------------------------------------------------------------------------------------------
// View / details
// ---------------------------------------------------------------------------------------------

r.get('/:id', requirePerm('catalog.view'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  if (!can(c.var.user, 'catalog.edit')) {
    const cats: Category[] = await loadCategories(c);
    const cat = cats.find((k) => k.id === agg.product.categoryId);
    return c.render(<ProductReadonly agg={agg} categoryName={cat ? nameOf(c, cat) : tm(c)('category.none')} />, { title: nameOf(c, agg.product), breadcrumbs: crumbs(c) });
  }
  return renderEdit(c, agg);
});

r.post('/:id', requirePerm('catalog.edit'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  const before = agg.product;
  const f = await parseForm(c, DetailsSchema);
  const again = (status: 409 | 422, errors?: Record<string, string>, slugWarning?: string[]) => {
    c.status(status);
    return renderEdit(c, agg, { details: { values: f.values, ...(errors ? { errors } : {}), ...(slugWarning ? { slugWarning } : {}) } });
  };
  if (!f.ok) return again(422, f.errors);
  const cats = await loadCategories(c);
  const done = finishDetails(f.data, { categoryIds: new Set(cats.map((k) => k.id)), slugTaken: await productSlugTaken(c, before.id) });
  if (!done.ok) return again(422, translate(c, done.errors));
  if (f.data.v !== before.updatedAt) return again(409, translate(c, { _form: 'err.stale' }));
  const broken = before.status === 'active' ? brokenProductUrls(before, done.row) : [];
  if (broken.length > 0 && f.data.confirm_slug_change !== true) {
    f.values['slug_fr'] = done.row.slugFr;
    f.values['slug_ar'] = done.row.slugAr;
    return again(422, undefined, broken);
  }
  try {
    const outcome = await updateDetails(c, before, f.data.v, done.row);
    if (outcome === 'unchanged') noAudit(c, 'product details submitted without changes: nothing written');
    if (outcome === 'conflict') return again(409, translate(c, { _form: 'err.stale' }));
    return c.redirect(withFlash(`/products/${before.id}`, 'saved'), 303);
  } catch (err) {
    const u = uniqueViolation(err);
    if (u?.table !== 'products') throw err;
    return again(409, translate(c, { [u.column]: 'err.slug_taken' }));
  }
});

// ---------------------------------------------------------------------------------------------
// Options + matrix
// ---------------------------------------------------------------------------------------------

type Planned =
  | { ok: true; values: Record<string, string>; draft: ReturnType<typeof withTempIds>; plan: MatrixPlan | null; toSimple: boolean; version: number }
  | { ok: false; values: Record<string, string>; errors: Record<string, string>; status: 409 | 422 };

async function planOptions(c: Ctx, agg: ProductAggregate, values: Record<string, string>): Promise<Planned> {
  const f = validateForm(c, optionsSchema(), values);
  if (!f.ok) return { ok: false, values, errors: f.errors, status: 422 };
  const data = f.data as Record<string, unknown>;
  if (data['v'] !== agg.product.updatedAt) return { ok: false, values, errors: translate(c, { _form: 'err.stale' }), status: 409 };
  if (agg.product.kind === 'pack') return { ok: false, values, errors: translate(c, { _form: 'err.kind_change' }), status: 422 };
  const fin = finishOptions(
    data,
    agg.options.map((o) => ({ id: o.id, kind: o.kind, valueIds: o.values.map((x) => x.id) })),
  );
  if (!fin.ok) return { ok: false, values, errors: translate(c, fin.errors), status: 422 };
  const baseSku = data['base_sku'] as string;
  if (!SKU_RE.test(baseSku)) return { ok: false, values, errors: translate(c, { base_sku: 'err.sku_format' }), status: 422 };
  const draft = withTempIds(fin.options);
  if (draft.options.length === 0) {
    // Back to a simple product: only possible with exactly one variant.
    if (agg.variants.length === 1) return { ok: true, values, draft, plan: null, toSimple: true, version: agg.product.updatedAt };
    return { ok: false, values, errors: matrixErrors(c, [{ code: 'no_options' }], agg), status: 422 };
  }
  const own = new Set(agg.variants.map((x) => x.sku));
  const taken = await skusWithPrefix(c, baseSku);
  const res = generateMatrix({
    options: draft.options.map((o) => ({ id: o.tid, values: o.values.map((x) => ({ id: x.tid, labelFr: x.valueFr })) })),
    existing: agg.variants.map((x) => ({ id: x.id, sku: x.sku, links: x.links, active: x.active, isDefault: x.isDefault, referenced: x.referenced })),
    baseSku,
    isSkuTaken: (s) => taken.has(s) && !own.has(s),
  });
  if (!res.ok) return { ok: false, values, errors: matrixErrors(c, res.errors, agg), status: 422 };
  return { ok: true, values, draft, plan: res.plan, toSimple: false, version: agg.product.updatedAt };
}

r.post('/:id/options', requirePerm('catalog.edit'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  const values = await readForm(c);
  const planned = await planOptions(c, agg, values);
  // Preview only: nothing is written.
  noAudit(c, 'matrix preview: read-only, the apply POST writes and audits');
  if (!planned.ok) {
    c.status(planned.status);
    return renderEdit(c, agg, { options: { values: planned.values, errors: planned.errors } });
  }
  const deletedSkus = agg.variants.filter((x) => planned.plan?.deleteVariantIds.includes(x.id)).map((x) => x.sku);
  return c.render(
    <MatrixPreview id={agg.product.id} values={planned.values} plan={planned.plan} toSimple={planned.toSimple} deletedSkus={deletedSkus} />,
    { title: tm(c)('matrix.title'), breadcrumbs: [...crumbs(c), { label: nameOf(c, agg.product), href: `/products/${agg.product.id}` }] },
  );
});

r.post('/:id/options/apply', requirePerm('catalog.edit'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  const values = await readForm(c);
  // Re-validated and re-planned on fresh state: the preview is never trusted.
  const planned = await planOptions(c, agg, values);
  if (!planned.ok) {
    c.status(planned.status);
    return renderEdit(c, agg, { options: { values: planned.values, errors: planned.errors } });
  }
  const def = agg.variants.find((x) => x.isDefault) ?? agg.variants[0];
  try {
    await applyOptions(c, agg, {
      version: planned.version,
      draft: planned.draft,
      plan: planned.plan,
      toSimple: planned.toSimple,
      newVariantPrice: def?.priceDzd ?? 0,
      newVariantWeight: def?.weightG ?? null,
      ids: await maxIds(c),
    });
  } catch (err) {
    // Stale version, a variant referenced meanwhile, or an id/SKU taken by a concurrent insert.
    if (!isGuardAbort(err) && uniqueViolation(err) === null) throw err;
    const fresh = (await loadAggregate(c, agg.product.id)) ?? agg;
    c.status(409);
    return renderEdit(c, fresh, { options: { values, errors: translate(c, { _form: 'err.stale' }) } });
  }
  return c.redirect(withFlash(`/products/${agg.product.id}`, 'saved'), 303);
});

// ---------------------------------------------------------------------------------------------
// Variant grid
// ---------------------------------------------------------------------------------------------

r.post('/:id/variants', requirePerm('catalog.edit'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  const ids = agg.variants.map((x) => x.id);
  const values = await readForm(c);
  const again = (status: 409 | 422, errors: Record<string, string>) => {
    c.status(status);
    return renderEdit(c, agg, { grid: { values, errors } });
  };
  const f = validateForm(c, gridSchema(ids), values);
  if (!f.ok) return again(422, f.errors);
  const skus = ids.map((id) => (f.data as Record<string, unknown>)[`sku_${id}`] as string);
  const taken = await takenSkus(c, skus, agg.product.id);
  const g = finishGrid(f.data as Record<string, unknown>, ids, (s) => taken.has(s));
  if (!g.ok) return again(422, translate(c, g.errors));
  try {
    const saved = await saveGrid(c, agg, g.rows, g.defaultId);
    if (saved === 'unchanged') noAudit(c, 'variant grid submitted without changes: nothing written');
  } catch (err) {
    const u = uniqueViolation(err);
    if (u?.table === 'variants') return again(409, translate(c, { _form: 'err.sku_taken' }));
    if (!isGuardAbort(err)) throw err;
    // A variant changed meanwhile (another editor, or an order moved the stock): show fresh values.
    const fresh = (await loadAggregate(c, agg.product.id)) ?? agg;
    const t1 = tm(c);
    const moved = g.rows.filter((row) => row.stock !== row.stockWas && fresh.variants.find((x) => x.id === row.id)?.stock !== row.stockWas);
    const errors: Record<string, string> = { _form: fieldMessages(c.var.lang)('err.stale') };
    for (const row of moved) {
      const now = fresh.variants.find((x) => x.id === row.id)?.stock;
      errors[`stock_${row.id}`] = t1('err.stock_moved', { now: now === null || now === undefined ? '—' : now });
    }
    c.status(409);
    return renderEdit(c, fresh, { grid: { values: { ...gridValuesOf(fresh), ...pickEdits(values, ids) }, errors } });
  }
  return c.redirect(withFlash(`/products/${agg.product.id}`, 'saved'), 303);
});

/** Keeps what the user typed, but with the fresh versions/expected stock so a resubmit can succeed. */
function pickEdits(values: Record<string, string>, ids: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    for (const k of ['sku', 'price', 'compare', 'stock', 'weight', 'active']) {
      const key = `${k}_${id}`;
      if (values[key] !== undefined) out[key] = values[key];
    }
  }
  if (values['default'] !== undefined) out['default'] = values['default'];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

r.post('/:id/status', requirePerm('catalog.edit'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  const f = await parseForm(c, StatusSchema);
  if (!f.ok) return c.text('Bad Request', 400);
  if (f.data.v !== agg.product.updatedAt) {
    c.status(409);
    return renderEdit(c, agg, { details: { values: detailsValuesOf(agg.product), errors: translate(c, { _form: 'err.stale' }) } });
  }
  if (f.data.to === agg.product.status) {
    noAudit(c, 'status already set: nothing written');
    return c.redirect(`/products/${agg.product.id}`, 303);
  }
  if (f.data.to === 'active') {
    const issues = await activationIssues(c, agg);
    if (issues.length > 0) {
      c.status(422);
      return renderEdit(c, agg, { issues });
    }
  }
  const ok = await setStatus(c, agg, f.data.v, f.data.to);
  if (!ok) {
    c.status(409);
    return renderEdit(c, (await loadAggregate(c, agg.product.id)) ?? agg, { details: { values: detailsValuesOf(agg.product), errors: translate(c, { _form: 'err.stale' }) } });
  }
  return c.redirect(withFlash(`/products/${agg.product.id}`, 'saved'), 303);
});

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

r.get('/:id/delete', requirePerm('catalog.edit'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  return c.render(<DeletePage agg={agg} referenced={await isReferenced(c, agg.product.id)} />, { title: tm(c)('delete.title'), breadcrumbs: crumbs(c) });
});

r.post('/:id/delete', requirePerm('catalog.edit'), async (c) => {
  const agg = await loadOr404(c);
  if (agg === null) return c.notFound();
  const f = await parseForm(c, EmptyForm);
  if (!f.ok) return c.text('Bad Request', 400);
  const blocked = async () => {
    c.status(409);
    return c.render(<DeletePage agg={agg} referenced />, { title: tm(c)('delete.title'), breadcrumbs: crumbs(c) });
  };
  if (await isReferenced(c, agg.product.id)) return blocked();
  try {
    await deleteProduct(c, agg);
  } catch (err) {
    if (!isGuardAbort(err)) throw err;
    return blocked();
  }
  return c.redirect(withFlash('/products', 'deleted'), 303);
});

mountPackRoutes(r, { loadAggregate, renderEdit, paramId });

export default r;
