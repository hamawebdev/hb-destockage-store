// ACAT-2 products, options/matrix, variant grid, status: HTTP tests on a real D1.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { fileURLToPath } from 'node:url';
import { createDb } from '@hb/db';
import { exportCatalogSnapshot } from '@hb/db/export';
import { buildAllPages, buildHomeProps, buildProductProps, createBuildContext } from '@hb/catalog/build';
import { stubImageManifest } from '@hb/catalog/image-stub';
import { findRepoRoot, loadStrings } from '@hb/catalog/sources';
import { idAndLabelProblems } from './html.ts';

// The shared machine is heavily loaded: real-D1 HTTP tests can take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
let catId = 0;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

async function post(email: string, path: string, data: Record<string, string>): Promise<Response> {
  return postAs(h, email, path, data);
}
const q = <T,>(sql: string, ...args: unknown[]) => h.db.prepare(sql).bind(...args).all<T>().then((r) => r.results);
const one = <T,>(sql: string, ...args: unknown[]) => h.db.prepare(sql).bind(...args).first<T>();
// audit_log is append-only (rows survive between tests): only count rows written by this test.
let auditFloor = 0;
const audits = (action: string) =>
  q<{ entity_id: string; before: string | null; after: string | null }>('select * from audit_log where action = ? and id > ? order by id', action, auditFloor);

interface V { id: number; sku: string; price_dzd: number; compare_at_dzd: number | null; stock: number | null; active: number; is_default: number; updated_at: number }
const variantsOf = (pid: number) => q<V>('select * from variants where product_id = ? order by position, id', pid);
const productOf = (pid: number) => one<{ kind: string; status: string; updated_at: number; name_fr: string; slug_fr: string }>('select * from products where id = ?', pid);

beforeEach(async () => {
  auditFloor = (await one<{ n: number }>('select coalesce(max(id), 0) n from audit_log'))!.n;
  for (const sql of ['delete from images', 'delete from pack_items', 'delete from variants', 'delete from product_options', 'delete from products', 'delete from categories']) {
    await h.db.prepare(sql).run();
  }
  const r = await h.db.prepare("insert into categories (slug_fr, slug_ar, name_fr, name_ar) values ('cuisine', 'mtbkh', 'Cuisine', 'مطبخ') returning id").first<{ id: number }>();
  catId = r!.id;
});

const base = () => ({ kind: 'simple', category_id: String(catId), name_fr: 'Poêle 28 cm', name_ar: 'مقلاة 28 سم', sku: 'hb-poele', price: '2500' });

async function create(over: Record<string, string> = {}): Promise<number> {
  const res = await post(USERS.content, '/products', { ...base(), ...over });
  expect(res.status, await res.clone().text().then((t) => t.slice(t.indexOf('error-summary'), t.indexOf('error-summary') + 400))).toBe(303);
  return Number(/\/products\/(\d+)/.exec(res.headers.get('Location') ?? '')![1]);
}

/** Current grid form values for a product, as the edit page renders them. */
async function gridValues(pid: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const x of await variantsOf(pid)) {
    Object.assign(out, {
      [`sku_${x.id}`]: x.sku,
      [`price_${x.id}`]: String(x.price_dzd),
      [`compare_${x.id}`]: x.compare_at_dzd === null ? '' : String(x.compare_at_dzd),
      [`stock_${x.id}`]: x.stock === null ? '' : String(x.stock),
      [`stockwas_${x.id}`]: x.stock === null ? '' : String(x.stock),
      [`weight_${x.id}`]: '',
      [`ver_${x.id}`]: String(x.updated_at),
    });
    if (x.active) out[`active_${x.id}`] = '1';
    if (x.is_default) out['default'] = String(x.id);
  }
  return out;
}

async function optionsForm(pid: number, options: { kind?: string; fr: string; ar: string; values: [string, string, string?][]; id?: number; valueIds?: number[] }[]) {
  const p = (await productOf(pid))!;
  const data: Record<string, string> = { v: String(p.updated_at), base_sku: 'HB-POELE' };
  options.forEach((o, i) => {
    if (o.id) data[`o${i}_id`] = String(o.id);
    data[`o${i}_kind`] = o.kind ?? 'size';
    data[`o${i}_name_fr`] = o.fr;
    data[`o${i}_name_ar`] = o.ar;
    o.values.forEach(([fr, ar, hex], j) => {
      const vid = o.valueIds?.[j];
      if (vid) data[`o${i}v${j}_id`] = String(vid);
      data[`o${i}v${j}_fr`] = fr;
      data[`o${i}v${j}_ar`] = ar;
      if (hex) data[`o${i}v${j}_hex`] = hex;
    });
  });
  return data;
}

describe('create', () => {
  test('simple product: draft + one default variant (SKU upper-cased), audited', async () => {
    const pid = await create({ stock: '7', compare_at: '3000' });
    expect(await productOf(pid)).toMatchObject({ kind: 'simple', status: 'draft', slug_fr: 'poele-28-cm' });
    const [v] = await variantsOf(pid);
    expect(v).toMatchObject({ sku: 'HB-POELE', price_dzd: 2500, compare_at_dzd: 3000, stock: 7, is_default: 1, active: 1 });
    const [a] = await audits('product.create');
    expect(a!.entity_id).toBe(String(pid));
  });

  test.each<[Record<string, string>, string]>([
    [{ price: '1.5' }, 'price'],
    [{ price: '-1' }, 'price'],
    [{ price: '1500.50' }, 'price'],
    [{ price: '1,500' }, 'price'],
    [{ price: '1e3' }, 'price'],
    [{ price: '' }, 'price'],
    [{ compare_at: '2500' }, 'compare_at'],
    [{ sku: 'hb poele' }, 'sku'],
    [{ brand_latin: 'فيليبس' }, 'brand_latin'],
    [{ category_id: '999999' }, 'category_id'],
    [{ kind: 'bundle' }, 'kind'],
    [{ status: 'active' }, 'mass assignment'],
  ])('rejects %j (%s) with 422, writes nothing', async (over) => {
    expect((await post(USERS.content, '/products', { ...base(), ...over })).status).toBe(422);
    expect((await one<{ n: number }>('select count(*) n from products'))!.n).toBe(0);
  });

  test.each([
    ['١٤.٦٠٠', 14600],
    ['14 600', 14600],
    ['1500.00', 1500],
    ['600,00', 600],
  ])('price %j is accepted as %d (admin-core vMoneyDzd)', async (price, dzd) => {
    const pid = await create({ price, sku: `hb-${dzd}` });
    expect((await variantsOf(pid))[0]!.price_dzd).toBe(dzd);
  });

  test('price above the order ceiling is saved with a visible warning', async () => {
    const pid = await create({ price: '10000001', sku: 'hb-cher' });
    const html = await (await h.as(USERS.owner, `/products/${pid}`)).text();
    expect(html).toContain('ne pourra pas être commandée');
  });

  test('duplicate SKU → 422 field error', async () => {
    await create();
    const res = await post(USERS.content, '/products', { ...base(), name_fr: 'Autre', name_ar: 'آخر' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('SKU est déjà utilisé');
  });
});

describe('roles', () => {
  test('confirmer/logistics: read-only page, 403 on every POST', async () => {
    const pid = await create();
    for (const user of [USERS.confirmer, USERS.logistics]) {
      expect((await h.as(user, '/products')).status).toBe(200);
      const html = await (await h.as(user, `/products/${pid}`)).text();
      expect(html).not.toContain(`action="/products/${pid}/variants"`);
      for (const path of ['/products', `/products/${pid}`, `/products/${pid}/variants`, `/products/${pid}/options/apply`, `/products/${pid}/status`, `/products/${pid}/delete`]) {
        expect((await postAs(h, user, path, { to: 'active' })).status, `${user} ${path}`).toBe(403);
      }
    }
  });
});

describe('details', () => {
  test('stale version → 409; XSS escaped on render', async () => {
    const pid = await create({ name_fr: '"><svg onload=alert(1)>' , slug_fr: 'x' });
    const html = await (await h.as(USERS.owner, `/products/${pid}`)).text();
    expect(html).not.toContain('<svg onload');
    const p = (await productOf(pid))!;
    const res = await post(USERS.owner, `/products/${pid}`, { category_id: String(catId), name_fr: 'N', name_ar: 'ن', slug_fr: 'x', slug_ar: 'mqla-28-sm', v: String(p.updated_at - 1) });
    expect(res.status).toBe(409);
    expect((await productOf(pid))!.name_fr).toBe('"><svg onload=alert(1)>');
  });
});

describe('variant grid', () => {
  test('price change audited as variant.update; compare-at ≤ price refused', async () => {
    const pid = await create();
    const [v] = await variantsOf(pid);
    const vals = await gridValues(pid);
    expect((await post(USERS.content, `/products/${pid}/variants`, { ...vals, [`compare_${v!.id}`]: '2000' })).status).toBe(422);
    expect((await post(USERS.content, `/products/${pid}/variants`, { ...vals, [`price_${v!.id}`]: '2400' })).status).toBe(303);
    expect((await variantsOf(pid))[0]!.price_dzd).toBe(2400);
    const [a] = await audits('variant.update');
    expect(a!.entity_id).toBe(String(v!.id));
    expect(JSON.parse(a!.before!)).toEqual({ sku: 'HB-POELE', priceDzd: 2500 });
    expect(JSON.parse(a!.after!)).toEqual({ sku: 'HB-POELE', priceDzd: 2400 });
  });

  test('unchanged grid → 303 with no audit row', async () => {
    const pid = await create();
    expect((await post(USERS.content, `/products/${pid}/variants`, await gridValues(pid))).status).toBe(303);
    expect(await audits('variant.update')).toHaveLength(0);
  });

  test('stock set is conditional on the stock shown: an order in between → 409, nothing written', async () => {
    const pid = await create({ stock: '10' });
    const [v] = await variantsOf(pid);
    const vals = await gridValues(pid);
    // An order decrements stock after the page was rendered.
    await h.db.prepare('update variants set stock = stock - 2 where id = ?').bind(v!.id).run();
    const res = await post(USERS.content, `/products/${pid}/variants`, { ...vals, [`stock_${v!.id}`]: '20', [`price_${v!.id}`]: '2600' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('valeur actuelle 8');
    expect((await variantsOf(pid))[0]).toMatchObject({ stock: 8, price_dzd: 2500 });
    expect(await audits('stock.set')).toHaveLength(0);
    // With the fresh value it goes through, audited as stock.set.
    const ok = await post(USERS.content, `/products/${pid}/variants`, { ...(await gridValues(pid)), [`stock_${v!.id}`]: '20' });
    expect(ok.status).toBe(303);
    expect((await variantsOf(pid))[0]!.stock).toBe(20);
    const [s] = await audits('stock.set');
    expect(s!.entity_id).toBe(String(v!.id));
    expect(JSON.parse(s!.before!)).toEqual({ sku: 'HB-POELE', stock: 8 });
    expect(JSON.parse(s!.after!)).toEqual({ sku: 'HB-POELE', stock: 20 });
  });

  test('stock blank = untracked (NULL)', async () => {
    const pid = await create({ stock: '5' });
    const [v] = await variantsOf(pid);
    expect((await post(USERS.content, `/products/${pid}/variants`, { ...(await gridValues(pid)), [`stock_${v!.id}`]: '' })).status).toBe(303);
    expect((await variantsOf(pid))[0]!.stock).toBeNull();
  });

  test('unknown grid fields are refused', async () => {
    const pid = await create();
    expect((await post(USERS.content, `/products/${pid}/variants`, { ...(await gridValues(pid)), sku_999999: 'X' })).status).toBe(422);
  });
});

describe('options and matrix', () => {
  test('preview writes nothing; apply creates the matrix, makes the product variable, audited', async () => {
    const pid = await create();
    const data = await optionsForm(pid, [
      { kind: 'size', fr: 'Taille', ar: 'المقاس', values: [['28 cm', '28 سم'], ['32 cm', '32 سم']] },
      { kind: 'colour', fr: 'Couleur', ar: 'اللون', values: [['Rouge', 'أحمر', '#C00000'], ['Noir', 'أسود', '#000000']] },
    ]);
    const preview = await post(USERS.content, `/products/${pid}/options`, data);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('HB-POELE-32CM-NOIR');
    expect(await variantsOf(pid)).toHaveLength(1);
    expect((await post(USERS.content, `/products/${pid}/options/apply`, data)).status).toBe(303);
    const vs = await variantsOf(pid);
    expect(vs.map((x) => x.sku)).toEqual(['HB-POELE', 'HB-POELE-28CM-NOIR', 'HB-POELE-32CM-ROUGE', 'HB-POELE-32CM-NOIR']);
    expect(vs.filter((x) => x.is_default)).toHaveLength(1);
    expect((await productOf(pid))!.kind).toBe('variable');
    const links = await q<{ n: number }>('select count(*) n from variant_option_values vov join variants v on v.id = vov.variant_id where v.product_id = ?', pid);
    expect(links[0]!.n).toBe(8);
    expect((await one<{ swatch_hex: string }>("select swatch_hex from option_values where value_fr = 'Rouge'"))!.swatch_hex).toBe('#c00000');
    expect(await audits('variant.generate')).toHaveLength(1);
  });

  test('swatch on a non-colour option, duplicate values, > 100 combinations → 422', async () => {
    const pid = await create();
    expect((await post(USERS.content, `/products/${pid}/options`, await optionsForm(pid, [{ fr: 'T', ar: 'م', values: [['A', 'أ', '#ffffff']] }]))).status).toBe(422);
    expect((await post(USERS.content, `/products/${pid}/options`, await optionsForm(pid, [{ fr: 'T', ar: 'م', values: [['A', 'أ'], ['a', 'ب']] }]))).status).toBe(422);
    const many = (n: number, p: string): [string, string][] => Array.from({ length: n }, (_, i) => [`${p}${i}`, `${p}${i}ع`]);
    const res = await post(USERS.content, `/products/${pid}/options`, await optionsForm(pid, [
      { fr: 'A', ar: 'أ', values: many(11, 'a') },
      { fr: 'B', ar: 'ب', kind: 'other', values: many(10, 'b') },
    ]));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Trop de combinaisons (110)');
  });

  async function twoByOne(pid: number) {
    const data = await optionsForm(pid, [{ kind: 'colour', fr: 'Couleur', ar: 'اللون', values: [['Rouge', 'أحمر'], ['Noir', 'أسود']] }]);
    expect((await post(USERS.content, `/products/${pid}/options/apply`, data)).status).toBe(303);
    const opt = (await one<{ id: number }>('select id from product_options where product_id = ?', pid))!;
    const vals = await q<{ id: number; value_fr: string }>('select id, value_fr from option_values where option_id = ? order by position', opt.id);
    return { optionId: opt.id, valueIds: vals.map((x) => x.id) };
  }

  test('removing a value deletes its unreferenced variant', async () => {
    const pid = await create();
    const { optionId, valueIds } = await twoByOne(pid);
    const data = await optionsForm(pid, [{ id: optionId, kind: 'colour', fr: 'Couleur', ar: 'اللون', values: [['Rouge', 'أحمر']], valueIds: [valueIds[0]!] }]);
    expect((await post(USERS.content, `/products/${pid}/options/apply`, data)).status).toBe(303);
    expect((await variantsOf(pid)).map((x) => x.sku)).toEqual(['HB-POELE']);
  });

  test('removing a value used by a variant in a pack is refused (referenced_conflict)', async () => {
    const pid = await create();
    const { optionId, valueIds } = await twoByOne(pid);
    const noir = (await variantsOf(pid)).find((x) => x.sku.endsWith('NOIR'))!;
    const pack = await h.db
      .prepare("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('pack', ?, 'pack', 'pack', 'Pack', 'حزمة') returning id")
      .bind(catId)
      .first<{ id: number }>();
    await h.db.prepare('insert into pack_items (pack_product_id, variant_id, qty) values (?, ?, 1)').bind(pack!.id, noir.id).run();
    const data = await optionsForm(pid, [{ id: optionId, kind: 'colour', fr: 'Couleur', ar: 'اللون', values: [['Rouge', 'أحمر']], valueIds: [valueIds[0]!] }]);
    const res = await post(USERS.content, `/products/${pid}/options/apply`, data);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(noir.sku);
    expect(await variantsOf(pid)).toHaveLength(2);
  });

  test('stale product version at apply → 409, nothing written', async () => {
    const pid = await create();
    const data = await optionsForm(pid, [{ fr: 'Taille', ar: 'المقاس', values: [['S', 'ص'], ['M', 'م']] }]);
    await h.db.prepare('update products set updated_at = updated_at + 5 where id = ?').bind(pid).run();
    expect((await post(USERS.content, `/products/${pid}/options/apply`, data)).status).toBe(409);
    expect(await variantsOf(pid)).toHaveLength(1);
    expect(await audits('variant.generate')).toHaveLength(0);
  });
});

describe('status', () => {
  test('activation is refused without a whole-product image, then allowed; audited', async () => {
    const pid = await create();
    const v = String((await productOf(pid))!.updated_at);
    const res = await post(USERS.content, `/products/${pid}/status`, { to: 'active', v });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Mise en ligne impossible');
    await h.db
      .prepare("insert into images (product_id, r2_key, width, height, alt_fr, alt_ar) values (?, 'p/1.jpg', 1200, 1200, 'Poêle', 'مقلاة')")
      .bind(pid)
      .run();
    expect((await post(USERS.content, `/products/${pid}/status`, { to: 'active', v })).status).toBe(303);
    expect((await productOf(pid))!.status).toBe('active');
    const [a] = await audits('product.status');
    expect(JSON.parse(a!.after!)).toEqual({ status: 'active' });
  });

  test('activation refused when the category is archived', async () => {
    const pid = await create();
    await h.db.prepare("insert into images (product_id, r2_key, width, height, alt_fr, alt_ar) values (?, 'p/2.jpg', 10, 10, 'a', 'ب')").bind(pid).run();
    await h.db.prepare('update categories set active = 0 where id = ?').bind(catId).run();
    const res = await post(USERS.content, `/products/${pid}/status`, { to: 'active', v: String((await productOf(pid))!.updated_at) });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('catégorie');
  });
});

describe('delete', () => {
  test('unreferenced product is deleted with its variants (audited); one in a pack is refused', async () => {
    const pid = await create();
    const other = await create({ sku: 'hb-autre', name_fr: 'Autre', name_ar: 'آخر' });
    const [ov] = await variantsOf(other);
    const pack = await h.db
      .prepare("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('pack', ?, 'pk', 'pk', 'Pack', 'حزمة') returning id")
      .bind(catId)
      .first<{ id: number }>();
    await h.db.prepare('insert into pack_items (pack_product_id, variant_id, qty) values (?, ?, 1)').bind(pack!.id, ov!.id).run();
    expect((await post(USERS.content, `/products/${other}/delete`, {})).status).toBe(409);
    expect(await productOf(other)).not.toBeNull();
    expect((await post(USERS.content, `/products/${pid}/delete`, {})).status).toBe(303);
    expect(await productOf(pid)).toBeNull();
    expect(await variantsOf(pid)).toHaveLength(0);
    expect(await audits('product.delete')).toHaveLength(1);
  });
});

describe('accessibility of repeated cards (rev-f a7c5393 F1)', () => {
  test('variant cards and the options form: no repeated id, labels stay inside their card', async () => {
    const pid = await create();
    const data = await optionsForm(pid, [{ kind: 'colour', fr: 'Couleur', ar: 'اللون', values: [['Rouge', 'أحمر'], ['Noir', 'أسود'], ['Bleu', 'أزرق']] }]);
    expect((await post(USERS.content, `/products/${pid}/options/apply`, data)).status).toBe(303);
    for (const user of [USERS.owner, USERS.ownerAr]) {
      const html = await (await h.as(user, `/products/${pid}`)).text();
      const grid = html.slice(html.indexOf('id="sec-variants"'));
      expect(grid.match(/<fieldset class="localized">/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(idAndLabelProblems(html)).toEqual([]);
      expect(idAndLabelProblems(grid.slice(0, grid.indexOf('</section>')), /<fieldset class="localized">[\s\S]*?<\/fieldset>/)).toEqual([]);
    }
  });
});

describe('no category, automatic SKU', () => {
  const bare = (kind: string, n: number) => ({ kind, name_fr: `Sans catégorie ${n}`, name_ar: `بدون صنف ${n}`, price: '1900' });
  const skuOf = async (pid: number) => (await variantsOf(pid))[0]!.sku;
  const categoryOf = async (pid: number) => (await one<{ category_id: number | null }>('select category_id from products where id = ?', pid))!.category_id;
  const publish = async (pid: number) => {
    await h.db.prepare("insert into images (product_id, r2_key, width, height, alt_fr, alt_ar) values (?, ?, 1200, 1200, 'Photo', 'صورة')").bind(pid, `p/nc-${pid}.jpg`).run();
    return post(USERS.content, `/products/${pid}/status`, { to: 'active', v: String((await productOf(pid))!.updated_at) });
  };

  test('the create form proposes the next SKU and does not require a category', async () => {
    const html = await (await h.as(USERS.content, '/products/new')).text();
    expect(html).toMatch(/<input[^>]*name="sku"[^>]*value="CDL-0001"/);
    expect(html).toMatch(/<input[^>]*name="sku_auto"[^>]*value="CDL-0001"/);
    expect(/<select[^>]*name="category_id"[^>]*>/.exec(html)![0]).not.toContain('required');
    expect(/<input[^>]*name="sku"[^>]*>/.exec(html)![0]).not.toContain('required');
    expect(html).toContain('Sans catégorie');
    expect(idAndLabelProblems(html)).toEqual([]);
  });

  test('simple, variable and pack are created with no category and no SKU typed, each with its own SKU, then published', async () => {
    const simple = await create({ ...bare('simple', 1), category_id: '', sku: '' });
    const variable = await create({ ...bare('variable', 2), category_id: '', sku: '' });
    // As the form posts it: the proposed SKU left untouched.
    const pack = await create({ ...bare('pack', 3), category_id: '', sku: 'CDL-0003', sku_auto: 'CDL-0003' });
    expect(await Promise.all([simple, variable, pack].map(categoryOf))).toEqual([null, null, null]);
    expect(await Promise.all([simple, variable, pack].map(skuOf))).toEqual(['CDL-0001', 'CDL-0002', 'CDL-0003']);

    // Variable: every variant gets its own SKU, built on the product's.
    const form = await optionsForm(variable, [{ fr: 'Taille', ar: 'المقاس', values: [['M', 'م'], ['L', 'ل']] }, { kind: 'colour', fr: 'Couleur', ar: 'اللون', values: [['Rouge', 'أحمر'], ['Noir', 'أسود']] }]);
    expect((await post(USERS.content, `/products/${variable}/options/apply`, { ...form, base_sku: 'CDL-0002' })).status).toBe(303);
    const skus = (await variantsOf(variable)).map((x) => x.sku);
    expect(skus).toEqual(['CDL-0002', 'CDL-0002-M-NOIR', 'CDL-0002-L-ROUGE', 'CDL-0002-L-NOIR']);
    // The next product does not land inside that family.
    expect(await skuOf(await create({ ...bare('simple', 4), category_id: '', sku: '' }))).toBe('CDL-0004');

    // Pack contents, then all three go on sale with no category.
    const item = (await variantsOf(simple))[0]!.id;
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: String((await productOf(pack))!.updated_at), variant_id: String(item), qty: '2' })).status).toBe(303);
    for (const pid of [simple, variable, pack]) {
      const res = await publish(pid);
      expect(res.status, `product ${pid}`).toBe(303);
      expect((await productOf(pid))!.status).toBe('active');
    }
    // What the next publish builds: the export of this database, through the storefront's page builder.
    for (const sql of [
      "insert into settings (key, value) values ('storeName', '{\"fr\":\"CDL\",\"ar\":\"CDL\"}') on conflict (key) do nothing",
      "insert into settings (key, value) values ('contactPhone', '\"0560417403\"') on conflict (key) do nothing",
      "insert into settings (key, value) values ('whatsapp', '\"213779942022\"') on conflict (key) do nothing",
    ]) await h.db.prepare(sql).run();
    const snapshot = await exportCatalogSnapshot(createDb(h.db), { integrity: { requireAllWilayas: false } });
    const strings = await loadStrings(findRepoRoot(fileURLToPath(import.meta.url)));
    const ctx = createBuildContext(snapshot, { siteUrl: 'https://comptoirdeluxe.com', strings, images: stubImageManifest(snapshot) });
    expect(() => buildAllPages(ctx)).not.toThrow();
    for (const lang of ['ar', 'fr'] as const) {
      const home = buildHomeProps(ctx, lang);
      expect(home.featured.map((x) => x.id).slice(0, home.pinnedCount).sort()).toEqual([simple, variable, pack].sort());
      for (const pid of [simple, variable, pack]) {
        const page = buildProductProps(ctx, lang, pid);
        expect(page.category).toBeNull();
        expect(page.orderForm.orderable).toBe(true);
        expect(home.featured.find((x) => x.id === pid)!.href).toBe(page.product.href);
      }
      // Under no category: the only category has no product.
      expect(home.categories.every((x) => x.count === 0)).toBe(true);
    }

    // Listed in the admin under "Sans catégorie"; the edit page still offers the categories.
    expect(await (await h.as(USERS.content, '/products')).text()).toContain('Sans catégorie');
    const edit = await (await h.as(USERS.content, `/products/${simple}`)).text();
    expect(edit).toContain('Cuisine');
    expect(idAndLabelProblems(edit.slice(0, edit.indexOf('</form>')))).toEqual([]);
  });

  test('a SKU typed by hand is kept, on creation and afterwards', async () => {
    const pid = await create({ ...bare('simple', 5), category_id: '', sku: 'mon-sku-01', sku_auto: 'CDL-0001' });
    expect(await skuOf(pid)).toBe('MON-SKU-01');
    const v = (await variantsOf(pid))[0]!;
    expect((await post(USERS.content, `/products/${pid}/variants`, { ...(await gridValues(pid)), [`sku_${v.id}`]: 'AUTRE-REF' })).status).toBe(303);
    expect(await skuOf(pid)).toBe('AUTRE-REF');
    // A typed SKU that is taken is refused, never replaced silently.
    const res = await post(USERS.content, '/products', { ...bare('simple', 6), sku: 'autre-ref', sku_auto: 'CDL-0001' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('déjà utilisé');
  });

  test('a proposed SKU taken by someone else meanwhile is replaced by the next one', async () => {
    await create({ ...bare('simple', 7), sku: 'CDL-0001' });
    const pid = await create({ ...bare('simple', 8), sku: 'CDL-0001', sku_auto: 'CDL-0001' });
    expect(await skuOf(pid)).toBe('CDL-0002');
  });

  test('a category can still be chosen, and removed or set later', async () => {
    const pid = await create({ ...bare('simple', 9), category_id: String(catId), sku: '' });
    expect(await categoryOf(pid)).toBe(catId);
    const details = async (category_id: string) => {
      const p = (await one<{ slug_fr: string; slug_ar: string; updated_at: number }>('select * from products where id = ?', pid))!;
      return post(USERS.content, `/products/${pid}`, { category_id, name_fr: 'Sans catégorie 9', name_ar: 'بدون صنف 9', slug_fr: p.slug_fr, slug_ar: p.slug_ar, v: String(p.updated_at) });
    };
    expect((await details('')).status).toBe(303);
    expect(await categoryOf(pid)).toBeNull();
    expect((await details(String(catId))).status).toBe(303);
    expect(await categoryOf(pid)).toBe(catId);
  });
});
