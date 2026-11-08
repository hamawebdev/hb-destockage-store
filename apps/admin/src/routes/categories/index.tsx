// /categories (ACAT-1): category tree CRUD. Owner: admin-catalog. Plan: artifacts/ACAT-0/plan.md §5.
//
// GET  /              list (catalog.view)            POST /               create (catalog.edit)
// GET  /new           create form (catalog.edit)
// GET  /:id           edit form, or read-only view   POST /:id            update (catalog.edit)
// POST /:id/archive   active = 0 (catalog.edit)      POST /:id/restore    active = 1 (catalog.edit)
// GET  /:id/delete    confirm page (catalog.edit)    POST /:id/delete     delete (catalog.edit)
//
// Every write: one D1 batch with its audit row (data.ts). Inputs: Valibot via parseForm, then
// finishCategory (text safety, slugs, parent placement).
import type { Context } from 'hono';
import * as v from 'valibot';
import type { Category } from '@hb/db';
import { noAudit } from '../../audit/audit.ts';
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { paramId, parseForm } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { withFlash } from '../../ui/flash.tsx';
import { uniqueViolation } from '../products/lib/db-errors.ts';
import { fieldMessages } from '../products/lib/field-messages.ts';
import {
  activeProductsInSubtree,
  createCategory,
  deleteCategory,
  loadCategories,
  loadCategory,
  productCounts,
  setCategoryActive,
  updateCategory,
} from './data.ts';
import { m } from './messages.ts';
import { loadImages } from '../media/data.ts';
import { PhotosSection } from '../media/views.tsx';
import { orderTree, parentChoices } from './tree.ts';
import { CategoryFormSchema, finishCategory, type CategoryErrorKey } from './validate.ts';
import { brokenUrls, CategoryActions, CategoryForm, CategoryList, CategoryReadonly, DeletePage } from './views.tsx';

type Ctx = Context<AppEnv>;

const r = createRouter({ roles: rolesFor('catalog.view') });

/** Action forms carry only the CSRF token (removed before validation): nothing else is accepted. */
const EmptyForm = v.strictObject({});

const titleOf = (c: Ctx) => m(c.var.lang)('title');
const crumbs = (c: Ctx) => [{ label: titleOf(c), href: '/categories' }];

/** Translates finishCategory's message keys. */
function translateErrors(c: Ctx, errors: Readonly<Record<string, CategoryErrorKey>>): Record<string, string> {
  const tm = m(c.var.lang);
  const tf = fieldMessages(c.var.lang);
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(errors)) {
    out[field] = key.startsWith('parent.') ? tm(key as Parameters<typeof tm>[0]) : tf(key as Parameters<typeof tf>[0]);
  }
  return out;
}

/** Form values for an existing row (what the edit form starts from). */
function valuesOf(row: Category): Record<string, string> {
  const v: Record<string, string> = {
    name_fr: row.nameFr,
    name_ar: row.nameAr,
    description_fr: row.descriptionFr ?? '',
    description_ar: row.descriptionAr ?? '',
    slug_fr: row.slugFr,
    slug_ar: row.slugAr,
    parent_id: row.parentId === null ? '' : String(row.parentId),
    sort: String(row.sort),
    v: String(row.updatedAt),
  };
  if (row.active) v['active'] = '1';
  if (row.placeholder) v['placeholder'] = '1';
  if (row.translationPlaceholder.includes('fr')) v['tp_fr'] = '1';
  if (row.translationPlaceholder.includes('ar')) v['tp_ar'] = '1';
  return v;
}

const slugTakenIn = (all: readonly Category[], selfId: number | null) => (lang: 'fr' | 'ar', slug: string) =>
  all.some((k) => k.id !== selfId && (lang === 'fr' ? k.slugFr : k.slugAr) === slug);

async function renderEdit(
  c: Ctx,
  category: Category,
  all: readonly Category[],
  values: Record<string, string>,
  errors?: Record<string, string>,
  slugWarning?: string[],
) {
  const counts = await productCounts(c);
  const parent = category.parentId === null ? undefined : all.find((k) => k.id === category.parentId);
  const tm = m(c.var.lang);
  const photos = await loadImages(c, { kind: 'category', id: category.id });
  return c.render(
    <>
      <CategoryForm action={`/categories/${category.id}`} values={values} errors={errors} parents={parentChoices(all, category.id)} slugWarning={slugWarning} />
      <PhotosSection owner={{ kind: 'category', id: category.id }} images={photos} />
      <CategoryActions
        category={category}
        activeProductsHidden={activeProductsInSubtree(all, counts, category.id)}
        parentArchived={parent !== undefined && !parent.active}
      />
    </>,
    { title: `${tm('edit')}${c.var.lang === 'ar' ? ': ' : ' : '}${c.var.lang === 'ar' ? category.nameAr : category.nameFr}`, breadcrumbs: crumbs(c) },
  );
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

r.get('/', requirePerm('catalog.view'), async (c) => {
  const [all, counts] = await Promise.all([loadCategories(c), productCounts(c)]);
  const rows = orderTree(all).map((o) => ({ ordered: o, products: counts.get(o.node.id)?.total ?? 0 }));
  const tm = m(c.var.lang);
  return c.render(<CategoryList rows={rows} />, {
    title: titleOf(c),
    actions: can(c.var.user, 'catalog.edit') ? <a class="btn btn--primary" href="/categories/new">{tm('new')}</a> : undefined,
  });
});

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

r.get('/new', requirePerm('catalog.edit'), async (c) => {
  const all = await loadCategories(c);
  const values: Record<string, string> = { active: '1', sort: '0' };
  const parent = c.req.query('parent');
  if (parent !== undefined && /^\d{1,9}$/.test(parent)) values['parent_id'] = parent;
  return c.render(<CategoryForm action="/categories" values={values} parents={parentChoices(all, null)} />, {
    title: m(c.var.lang)('new'),
    breadcrumbs: crumbs(c),
  });
});

r.post('/', requirePerm('catalog.edit'), async (c) => {
  const all = await loadCategories(c);
  const f = await parseForm(c, CategoryFormSchema);
  const renderForm = (errors: Record<string, string>) =>
    c.render(<CategoryForm action="/categories" values={f.values} errors={errors} parents={parentChoices(all, null)} />, {
      title: m(c.var.lang)('new'),
      breadcrumbs: crumbs(c),
    });
  if (!f.ok) {
    c.status(422);
    return renderForm(f.errors);
  }
  const done = finishCategory(f.data, { id: null, nodes: all, slugTaken: slugTakenIn(all, null) });
  if (!done.ok) {
    c.status(422);
    return renderForm(translateErrors(c, done.errors));
  }
  try {
    const id = await createCategory(c, done.row);
    return c.redirect(withFlash(`/categories/${id}`, 'created'), 303);
  } catch (err) {
    const u = uniqueViolation(err);
    if (u?.table !== 'categories') throw err;
    // Lost a race on a slug: same message as the pre-check.
    c.status(409);
    return renderForm(translateErrors(c, { [u.column]: 'err.slug_taken' }));
  }
});

// ---------------------------------------------------------------------------------------------
// Edit / view
// ---------------------------------------------------------------------------------------------

r.get('/:id', requirePerm('catalog.view'), async (c) => {
  const id = paramId(c);
  if (id === null) return c.notFound();
  const all = await loadCategories(c);
  const category = all.find((k) => k.id === id);
  if (category === undefined) return c.notFound();
  if (!can(c.var.user, 'catalog.edit')) {
    const parent = all.find((k) => k.id === category.parentId);
    const name = parent === undefined ? null : c.var.lang === 'ar' ? parent.nameAr : parent.nameFr;
    return c.render(<CategoryReadonly category={category} parentName={name} />, {
      title: c.var.lang === 'ar' ? category.nameAr : category.nameFr,
      breadcrumbs: crumbs(c),
    });
  }
  return renderEdit(c, category, all, valuesOf(category));
});

r.post('/:id', requirePerm('catalog.edit'), async (c) => {
  const id = paramId(c);
  if (id === null) return c.notFound();
  const all = await loadCategories(c);
  const before = all.find((k) => k.id === id);
  if (before === undefined) return c.notFound();
  const f = await parseForm(c, CategoryFormSchema);
  if (!f.ok) {
    c.status(422);
    return renderEdit(c, before, all, f.values, f.errors);
  }
  const done = finishCategory(f.data, { id, nodes: all, slugTaken: slugTakenIn(all, id) });
  if (!done.ok) {
    c.status(422);
    return renderEdit(c, before, all, f.values, translateErrors(c, done.errors));
  }
  const tf = fieldMessages(c.var.lang);
  const version = f.data.v;
  if (version === null || version !== before.updatedAt) {
    c.status(409);
    return renderEdit(c, before, all, f.values, { _form: tf('err.stale') });
  }

  // Changing the slug of a visible category breaks its public URLs: say which, and require an
  // explicit confirmation (lead decision, ACAT-0 §0a #3). The change itself is audited.
  const broken = before.active ? brokenUrls(before, done.row) : [];
  if (broken.length > 0 && !f.data.confirm_slug_change) {
    const values = { ...f.values, slug_fr: done.row.slugFr, slug_ar: done.row.slugAr };
    c.status(422);
    return renderEdit(c, before, all, values, undefined, broken);
  }

  try {
    const outcome = await updateCategory(c, before, version, done.row);
    if (outcome === 'unchanged') noAudit(c, 'category form submitted without changes: nothing written');
    if (outcome === 'conflict') {
      const fresh = await loadCategory(c, id);
      if (fresh === undefined) return c.notFound();
      // Version moved on, or the parent became a descendant meanwhile: both are "reload".
      c.status(409);
      return renderEdit(c, fresh, await loadCategories(c), f.values, { _form: tf('err.stale') });
    }
    return c.redirect(withFlash(`/categories/${id}`, 'saved'), 303);
  } catch (err) {
    const u = uniqueViolation(err);
    if (u?.table !== 'categories') throw err;
    c.status(409);
    return renderEdit(c, before, all, f.values, translateErrors(c, { [u.column]: 'err.slug_taken' }));
  }
});

// ---------------------------------------------------------------------------------------------
// Archive / restore / delete
// ---------------------------------------------------------------------------------------------

for (const [path, active] of [['archive', false], ['restore', true]] as const) {
  r.post(`/:id/${path}`, requirePerm('catalog.edit'), async (c) => {
    const id = paramId(c);
    if (id === null) return c.notFound();
    const parsed = await parseForm(c, EmptyForm);
    if (!parsed.ok) return c.text('Bad Request', 400);
    const category = await loadCategory(c, id);
    if (category === undefined) return c.notFound();
    // Already in that state: nothing written, nothing audited; same redirect.
    await setCategoryActive(c, id, active);
    return c.redirect(withFlash(`/categories/${id}`, 'saved'), 303);
  });
}

async function deleteContext(c: Ctx, id: number) {
  const all = await loadCategories(c);
  const category = all.find((k) => k.id === id);
  if (category === undefined) return null;
  const counts = await productCounts(c);
  return { category, products: counts.get(id)?.total ?? 0, children: all.filter((k) => k.parentId === id).length };
}

r.get('/:id/delete', requirePerm('catalog.edit'), async (c) => {
  const id = paramId(c);
  if (id === null) return c.notFound();
  const ctx = await deleteContext(c, id);
  if (ctx === null) return c.notFound();
  return c.render(<DeletePage {...ctx} />, { title: m(c.var.lang)('delete.title'), breadcrumbs: crumbs(c) });
});

r.post('/:id/delete', requirePerm('catalog.edit'), async (c) => {
  const id = paramId(c);
  if (id === null) return c.notFound();
  const parsed = await parseForm(c, EmptyForm);
  if (!parsed.ok) return c.text('Bad Request', 400);
  const ctx = await deleteContext(c, id);
  if (ctx === null) return c.notFound();
  const deleted = ctx.products === 0 && ctx.children === 0 && (await deleteCategory(c, ctx.category));
  if (!deleted) {
    // Blocked (products or sub-categories, possibly added meanwhile): show why.
    const fresh = await deleteContext(c, id);
    if (fresh === null) return c.notFound();
    c.status(409);
    return c.render(<DeletePage {...fresh} />, { title: m(c.var.lang)('delete.title'), breadcrumbs: crumbs(c) });
  }
  return c.redirect(withFlash('/categories', 'deleted'), 303);
});

export default r;
