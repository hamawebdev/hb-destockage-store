// Pack contents (ACAT-6, plan §4.4). A pack is a product (`kind = 'pack'`) with its own single
// variant (price, stock, SKU) and a list of contained variants (`pack_items`) shown on its page.
// Pack stock is independent of the contents' stock (BRIEF §2, lead decision ACAT-0 §0a #4).
//
// POST /products/:id/pack/add      { v, variant_id, qty }
// POST /products/:id/pack/update   { v, variant_id, qty }
// POST /products/:id/pack/move     { v, variant_id, dir: up|down }
// POST /products/:id/pack/remove   { v, variant_id }
// Each action rewrites the item list in one batch: product-version guard, delete + re-insert in
// order, product version bump, one `pack.update` audit row with the before/after lists.
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { packItems, products, variants } from '@hb/db';
import { audit } from '../../audit/audit.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { vOptionalInt, vPicklist, validateForm, readForm } from '../../lib/forms.ts';
import { useUi } from '../../ui/context.ts';
import { Bdi, Money } from '../../ui/format.tsx';
import { ErrorSummary, Form, NumberInput, Select, Submit, type FieldErrors } from '../../ui/form.tsx';
import { withFlash } from '../../ui/flash.tsx';
import { fieldMessages } from './lib/field-messages.ts';
import { bumpUpdatedAt } from './lib/diff.ts';
import { isGuardAbort, versionGuard } from './lib/guard.ts';
import type { ProductAggregate } from './data.ts';
import { m } from './messages.ts';

type Ctx = Context<AppEnv>;

export const PACK_MAX_ITEMS = 20;
export const PACK_MAX_QTY = 99;

/** A variant as shown in the pack editor and picker. */
export interface PackVariant {
  variantId: number;
  productId: number;
  productNameFr: string;
  productNameAr: string;
  sku: string;
  priceDzd: number;
  labelFr: string | null;
  labelAr: string | null;
  active: boolean;
}
export interface PackLine extends PackVariant {
  qty: number;
}

/** "Rouge / 28 cm": the variant's option values, for the editor and picker labels. */
const labelFrSql = sql<string | null>`(select group_concat(ov.value_fr, ' / ') from variant_option_values vov
  join option_values ov on ov.id = vov.option_value_id where vov.variant_id = ${variants.id})`;
const labelArSql = sql<string | null>`(select group_concat(ov.value_ar, ' / ') from variant_option_values vov
  join option_values ov on ov.id = vov.option_value_id where vov.variant_id = ${variants.id})`;

const variantColumns = {
  variantId: variants.id,
  productId: products.id,
  productNameFr: products.nameFr,
  productNameAr: products.nameAr,
  sku: variants.sku,
  priceDzd: variants.priceDzd,
  labelFr: labelFrSql,
  labelAr: labelArSql,
  active: variants.active,
};

export async function loadPackLines(c: Ctx, packId: number): Promise<PackLine[]> {
  return c.var.db
    .select({ ...variantColumns, qty: packItems.qty })
    .from(packItems)
    .innerJoin(variants, eq(variants.id, packItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(packItems.packProductId, packId))
    .orderBy(asc(packItems.position), asc(packItems.variantId));
}

/** Active variants of non-pack, non-archived products: what a pack may contain. */
export async function loadPickable(c: Ctx): Promise<PackVariant[]> {
  return c.var.db
    .select(variantColumns)
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(ne(products.kind, 'pack'), ne(products.status, 'archived'), eq(variants.active, true)))
    .orderBy(asc(products.nameFr), asc(variants.position), asc(variants.id));
}

const variantLabel = (x: PackVariant, lang: 'fr' | 'ar') => {
  const name = lang === 'ar' ? x.productNameAr : x.productNameFr;
  const values = lang === 'ar' ? x.labelAr : x.labelFr;
  return values ? `${name} — ${values}` : name;
};

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------

export function PackSection(props: { agg: ProductAggregate; lines: readonly PackLine[]; pickable: readonly PackVariant[]; errors?: FieldErrors | undefined }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const id = props.agg.product.id;
  const version = String(props.agg.product.updatedAt);
  const packPrice = props.agg.variants[0]?.priceDzd ?? 0;
  const value = props.lines.reduce((s, l) => s + l.priceDzd * l.qty, 0);
  const inPack = new Set(props.lines.map((l) => l.variantId));
  const action = (path: string, variantId: number, extra: Record<string, string>, label: string, variant: 'secondary' | 'danger' = 'secondary') => (
    <Form action={`/products/${id}/pack/${path}`} class="inline-form">
      <input type="hidden" name="v" value={version} />
      <input type="hidden" name="variant_id" value={String(variantId)} />
      {Object.entries(extra).map(([k, val]) => (
        <input type="hidden" name={k} value={val} />
      ))}
      <Submit variant={variant}>{label}</Submit>
    </Form>
  );
  return (
    <section aria-labelledby="sec-pack">
      <h2 id="sec-pack">{tm('pack.title')}</h2>
      <ErrorSummary errors={props.errors} />
      {props.lines.length === 0 ? (
        <p class="callout callout--warning"><strong>{tm('pack.empty')}</strong></p>
      ) : (
        <div class="table-wrap" role="region" aria-label={tm('pack.title')} tabindex={0}>
          <table class="table">
            <caption class="table__caption">{tm('pack.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{tm('col.name')}</th>
                <th scope="col">SKU</th>
                <th scope="col" class="num">{tm('field.price')}</th>
                <th scope="col">{tm('pack.qty')}</th>
                <th scope="col">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {props.lines.map((l, i) => (
                <tr>
                  <th scope="row">
                    {variantLabel(l, lang)}
                    {l.active ? null : <> ({tm('pack.inactive')})</>}
                  </th>
                  <td><Bdi ltr>{l.sku}</Bdi></td>
                  <td class="num"><Money dzd={l.priceDzd} /></td>
                  <td>
                    <Form action={`/products/${id}/pack/update`} class="inline-form">
                      <input type="hidden" name="v" value={version} />
                      <input type="hidden" name="variant_id" value={String(l.variantId)} />
                      <input class="input" name="qty" value={String(l.qty)} inputmode="numeric" dir="ltr" maxlength={2} aria-label={`${tm('pack.qty')} — ${l.sku}`} />
                      <Submit variant="secondary">{t('common.save')}</Submit>
                    </Form>
                  </td>
                  <td>
                    {i > 0 ? action('move', l.variantId, { dir: 'up' }, tm('pack.up')) : null}
                    {i < props.lines.length - 1 ? action('move', l.variantId, { dir: 'down' }, tm('pack.down')) : null}
                    {action('remove', l.variantId, {}, tm('pack.remove'), 'danger')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        {tm('pack.value')} <Money dzd={value} /> · {tm('pack.price')} <Money dzd={packPrice} />
        {value > packPrice ? <> · {tm('pack.saving')} <Money dzd={value - packPrice} /></> : null}
      </p>
      {props.lines.length < PACK_MAX_ITEMS ? (
        <Form action={`/products/${id}/pack/add`}>
          <input type="hidden" name="v" value={version} />
          <Select
            name="variant_id"
            label={tm('pack.add')}
            required
            placeholder="—"
            error={props.errors?.['variant_id']}
            options={props.pickable
              .filter((x) => !inPack.has(x.variantId) && x.productId !== id)
              .map((x) => ({ value: String(x.variantId), label: `${variantLabel(x, lang)} (${x.sku})` }))}
          />
          <NumberInput name="qty" label={tm('pack.qty')} value="1" error={props.errors?.['qty']} />
          <Submit>{tm('pack.addButton')}</Submit>
        </Form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

const optionalInt = (min: number, max: number) => v.optional(vOptionalInt(min, max), '');
const Base = { v: optionalInt(0, Number.MAX_SAFE_INTEGER), variant_id: optionalInt(1, Number.MAX_SAFE_INTEGER) };
const SCHEMAS = {
  add: v.strictObject({ ...Base, qty: optionalInt(1, PACK_MAX_QTY) }),
  update: v.strictObject({ ...Base, qty: optionalInt(1, PACK_MAX_QTY) }),
  move: v.strictObject({ ...Base, dir: vPicklist(['up', 'down'] as const) }),
  remove: v.strictObject(Base),
} as const;
type ActionName = keyof typeof SCHEMAS;

type Items = { variantId: number; qty: number }[];

/** Pure: the new item list for an action, or an error key. */
export function nextItems(
  items: Items,
  action: ActionName,
  data: { variant_id: number | null; qty?: number | null; dir?: 'up' | 'down' },
  pickable: ReadonlySet<number>,
): { ok: true; items: Items } | { ok: false; field: string; error: 'pack.err.variant' | 'pack.err.duplicate' | 'pack.err.full' | 'form.required' | 'err.stale' } {
  const id = data.variant_id;
  if (id === null) return { ok: false, field: 'variant_id', error: 'form.required' };
  const idx = items.findIndex((x) => x.variantId === id);
  switch (action) {
    case 'add':
      if (!pickable.has(id)) return { ok: false, field: 'variant_id', error: 'pack.err.variant' };
      if (idx >= 0) return { ok: false, field: 'variant_id', error: 'pack.err.duplicate' };
      if (items.length >= PACK_MAX_ITEMS) return { ok: false, field: 'variant_id', error: 'pack.err.full' };
      if (data.qty === null || data.qty === undefined) return { ok: false, field: 'qty', error: 'form.required' };
      return { ok: true, items: [...items, { variantId: id, qty: data.qty }] };
    case 'update':
      if (idx < 0) return { ok: false, field: '_form', error: 'err.stale' };
      if (data.qty === null || data.qty === undefined) return { ok: false, field: 'qty', error: 'form.required' };
      return { ok: true, items: items.map((x) => (x.variantId === id ? { ...x, qty: data.qty as number } : x)) };
    case 'move': {
      if (idx < 0) return { ok: false, field: '_form', error: 'err.stale' };
      const j = data.dir === 'up' ? idx - 1 : idx + 1;
      if (j < 0 || j >= items.length) return { ok: true, items };
      const out = [...items];
      [out[idx], out[j]] = [out[j] as Items[number], out[idx] as Items[number]];
      return { ok: true, items: out };
    }
    case 'remove':
      if (idx < 0) return { ok: false, field: '_form', error: 'err.stale' };
      return { ok: true, items: items.filter((x) => x.variantId !== id) };
  }
}

export function mountPackRoutes(
  r: Hono<AppEnv>,
  deps: {
    loadAggregate: (c: Ctx, id: number) => Promise<ProductAggregate | null>;
    renderEdit: (c: Ctx, agg: ProductAggregate, o: { pack?: { errors: Record<string, string> } }) => Response | Promise<Response>;
    paramId: (c: Ctx) => number | null;
  },
): void {
  for (const action of Object.keys(SCHEMAS) as ActionName[]) {
    r.post(`/:id/pack/${action}`, requirePerm('catalog.edit'), async (c) => {
      const id = deps.paramId(c);
      const agg = id === null ? null : await deps.loadAggregate(c, id);
      if (agg === null || agg.product.kind !== 'pack') return c.notFound();
      const tm = m(c.var.lang);
      const tf = fieldMessages(c.var.lang);
      const fail = (status: 409 | 422, errors: Record<string, string>) => {
        c.status(status);
        return deps.renderEdit(c, agg, { pack: { errors } });
      };
      const f = validateForm(c, SCHEMAS[action], await readForm(c));
      if (!f.ok) return fail(422, f.errors);
      const data = f.data as { v: number | null; variant_id: number | null; qty?: number | null; dir?: 'up' | 'down' };
      if (data.v !== agg.product.updatedAt) return fail(409, { _form: tf('err.stale') });
      const pickable = new Set((await loadPickable(c)).filter((x) => x.productId !== agg.product.id).map((x) => x.variantId));
      const next = nextItems(agg.packItems.map((x) => ({ ...x })), action, data, pickable);
      if (!next.ok) {
        const msg = next.error === 'form.required' ? c.var.t('form.required') : next.error === 'err.stale' ? tf('err.stale') : tm(next.error);
        return fail(next.error === 'err.stale' ? 409 : 422, { [next.field]: msg });
      }
      const db = c.var.db;
      const pid = agg.product.id;
      const items: BatchItem<'sqlite'>[] = [
        versionGuard(db, 'products', 'id', pid, agg.product.updatedAt),
        db.delete(packItems).where(eq(packItems.packProductId, pid)),
        ...next.items.map((x, position) => db.insert(packItems).values({ packProductId: pid, variantId: x.variantId, qty: x.qty, position })),
        db.update(products).set({ updatedAt: bumpUpdatedAt() }).where(eq(products.id, pid)),
        audit(c, { action: 'pack.update', entity: 'pack_items', entityId: pid, before: { items: agg.packItems }, after: { items: next.items } }),
      ];
      try {
        await db.batch(items as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
      } catch (err) {
        if (!isGuardAbort(err)) throw err;
        return fail(409, { _form: tf('err.stale') });
      }
      return c.redirect(`${withFlash(`/products/${pid}`, 'saved')}#sec-pack`, 303);
    });
  }
}
