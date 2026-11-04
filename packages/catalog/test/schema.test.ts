import { describe, expect, test } from 'vitest';
import { fixtureSnapshot, parseSnapshot, SnapshotError, validateSnapshot, type CatalogSnapshot } from '../src/index.ts';
import { OFF_SITE } from './url.test.ts';

const clone = (): CatalogSnapshot => structuredClone(fixtureSnapshot) as CatalogSnapshot;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const mut = (s: CatalogSnapshot) => s as unknown as Mutable<CatalogSnapshot>;
// The fixture carries 3 wilayas; completeness has its own test below.
const issuesOf = (s: unknown, requireAllWilayas = false): string[] => {
  const r = validateSnapshot(s, { requireAllWilayas });
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('validateSnapshot', () => {
  test('fixture is valid', () => {
    expect(issuesOf(fixtureSnapshot)).toEqual([]);
    expect(parseSnapshot(fixtureSnapshot, 'fixture', { requireAllWilayas: false })).toEqual(fixtureSnapshot);
  });

  test('round-trips through JSON (snapshot is plain JSON)', () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify(fixtureSnapshot)), 'fixture', { requireAllWilayas: false })).toEqual(fixtureSnapshot);
  });

  test('rejects unknown keys (strict objects)', () => {
    const s = mut(clone()) as unknown as { products: Record<string, unknown>[] };
    s.products[0]!['featured'] = true;
    expect(issuesOf(s).join()).toMatch(/featured|key/i);
  });

  test('rejects non-integer and minor-unit prices', () => {
    const s = mut(clone());
    s.products[1]!.variants[0]!.priceDzd = 3200.5;
    expect(issuesOf(s).length).toBeGreaterThan(0);
  });

  test('rejects non-ASCII and reserved slugs', () => {
    const a = mut(clone());
    a.products[0]!.slug = { fr: 'tablier', ar: 'مريلة' };
    expect(issuesOf(a).join()).toMatch(/kebab/);
    const b = mut(clone());
    b.contentPages[0]!.slug = { fr: 'search', ar: 'tawsil' };
    expect(issuesOf(b).join()).toMatch(/reserved/);
  });

  test('rejects duplicate slugs per language', () => {
    const s = mut(clone());
    s.products[1]!.slug = { fr: 'tablier-de-cuisine', ar: 'x' };
    expect(issuesOf(s).join()).toMatch(/duplicate slug "tablier-de-cuisine"/);
  });

  test('variable product: one value per option, unique combinations', () => {
    const a = mut(clone());
    a.products[0]!.variants[1]!.optionValueIds = [301, 303];
    expect(issuesOf(a).join()).toMatch(/share option combination/);
    const b = mut(clone());
    b.products[0]!.variants[1]!.optionValueIds = [301, 302];
    expect(issuesOf(b).join()).toMatch(/exactly one value of each option/);
    const c = mut(clone());
    c.products[0]!.variants[1]!.optionValueIds = [301, 999];
    expect(issuesOf(c).join()).toMatch(/not in this product/);
  });

  test('exactly one active default variant', () => {
    const s = mut(clone());
    s.products[0]!.variants[1]!.isDefault = true;
    expect(issuesOf(s).join()).toMatch(/exactly one default/);
  });

  test('simple product: one variant, no options', () => {
    const s = mut(clone());
    s.products[1]!.variants.push({ ...s.products[1]!.variants[0]!, id: 9999, sku: 'X', isDefault: false });
    expect(issuesOf(s).join()).toMatch(/exactly 1 variant/);
  });

  test('pack: needs items, cannot contain a pack, unknown variants rejected', () => {
    const a = mut(clone());
    a.products[5]!.packItems = [];
    expect(issuesOf(a).join()).toMatch(/pack needs/);
    const b = mut(clone());
    b.products[5]!.packItems = [{ variantId: 1061, qty: 1 }];
    expect(issuesOf(b).join()).toMatch(/cannot contain a pack/);
    const c = mut(clone());
    c.products[5]!.packItems = [{ variantId: 42, qty: 1 }];
    expect(issuesOf(c).join()).toMatch(/unknown variant 42/);
  });

  test('compareAt must exceed price', () => {
    const s = mut(clone());
    s.products[0]!.variants[0]!.compareAtDzd = 1900;
    expect(issuesOf(s).join()).toMatch(/greater than priceDzd/);
  });

  test('category tree: unknown parent and cycles', () => {
    const a = mut(clone());
    a.categories[0]!.parentId = 2;
    expect(issuesOf(a).join()).toMatch(/cycle/);
    const b = mut(clone());
    b.categories[1]!.parentId = 77;
    expect(issuesOf(b).join()).toMatch(/unknown category 77/);
  });

  test('settings references and formats', () => {
    // Integrity runs only on structurally valid input, so check each separately.
    const a = mut(clone());
    a.settings.homeFeaturedProductIds = [404];
    expect(issuesOf(a).join()).toMatch(/unknown product 404/);
    const b = mut(clone());
    b.settings.contactPhone = '+213560417403';
    expect(issuesOf(b).join()).toMatch(/national format/);
  });

  test.each(OFF_SITE)('content link href rejected: %j', (href) => {
    const s = mut(clone()) as unknown as { contentPages: { body: { fr: { type: string; href?: string }[] } }[] };
    s.contentPages[0]!.body.fr[3]!.href = href;
    expect(issuesOf(s).join()).toMatch(/link href/);
  });

  test.each(['/fr/livraison/', '/fr/livraison/#frais', '/', 'tel:+213560417403', 'tel:0560417403', 'https://wa.me/213779942022'])(
    'content link href accepted: %j',
    (href) => {
      const s = mut(clone()) as unknown as { contentPages: { body: { fr: { type: string; href?: string }[] } }[] };
      s.contentPages[0]!.body.fr[3]!.href = href;
      expect(issuesOf(s)).toEqual([]);
    },
  );

  test.each(['../../etc/passwd', '/etc/passwd', 'https://evil.example/x.jpg', 'a/../../b.jpg', 'a\\b.jpg', 'A/B.JPG', 'a b.jpg', '.hidden/x.jpg'])(
    'image key rejected: %j',
    (key) => {
      const s = mut(clone());
      s.products[1]!.images[0]!.key = key;
      expect(issuesOf(s).join()).toMatch(/image key/);
    },
  );

  test('text: bidi overrides and control characters rejected, newlines only in descriptions', () => {
    const a = mut(clone());
    a.products[1]!.name = { fr: 'Poêle \u202e82 mc', ar: 'x' };
    expect(issuesOf(a).join()).toMatch(/bidi-override/);
    const b = mut(clone());
    b.products[1]!.name = { fr: 'Poêle\n28', ar: 'x' };
    expect(issuesOf(b).join()).toMatch(/control or bidi/);
    const c = mut(clone());
    c.products[1]!.description = { fr: 'a\n\nb', ar: 'مقلاة\u200c' };
    expect(issuesOf(c)).toEqual([]);
    const d = mut(clone());
    d.products[1]!.name = { fr: 'x'.repeat(201), ar: 'x' };
    expect(issuesOf(d).length).toBeGreaterThan(0);
    const e = mut(clone());
    e.settings.turnstileSiteKey = '"><script>';
    expect(issuesOf(e).join()).toMatch(/turnstileSiteKey/);
  });

  test('all 69 wilayas required unless disabled', () => {
    expect(issuesOf(fixtureSnapshot, true).join()).toMatch(/missing wilaya codes 1, 2, 3, 4, 5, 6, 8/);
    const s = mut(clone());
    s.wilayas = Array.from({ length: 69 }, (_, i) => ({ code: i + 1, name: { ar: `و${i + 1}`, fr: `W${i + 1}` }, courierCode: null }));
    expect(issuesOf(s, true)).toEqual([]);
  });

  // Nit 4 (CAT-1 r1): each check below had no test.
  test('duplicate SKUs rejected', () => {
    const s = mut(clone());
    s.products[2]!.variants[0]!.sku = 'POE-28';
    expect(issuesOf(s).join()).toMatch(/duplicate id POE-28/);
  });

  test("image variantId must belong to the product", () => {
    const s = mut(clone());
    s.products[1]!.images.push({ ...s.products[1]!.images[0]!, id: 5999, variantId: 1011 });
    expect(issuesOf(s).join()).toMatch(/variant 1011 is not in this product/);
  });

  test('active product needs a product-level image', () => {
    const s = mut(clone());
    s.products[1]!.images = [];
    expect(issuesOf(s).join()).toMatch(/needs ≥ 1 product-level image/);
  });

  test('parseSnapshot throws SnapshotError listing issues', () => {
    expect(() => parseSnapshot({}, 'test')).toThrow(SnapshotError);
  });
});

describe('exports for admin (pure)', () => {
  test('checkProductIntegrity on one product', async () => {
    const { checkProductIntegrity, SLUG } = await import('../src/schema.ts');
    const { isContentLinkHref } = await import('../src/url.ts');
    const s = clone();
    const variantKindById = new Map(s.products.flatMap((p) => p.variants.map((x) => [x.id, p.kind] as const)));
    const ctx = { variantKindById, categoryIds: new Set(s.categories.map((c) => c.id)) };
    for (const p of s.products) expect(checkProductIntegrity(p, ctx)).toEqual([]);
    const bad = { ...s.products[0]!, variants: s.products[0]!.variants.map((x) => ({ ...x, isDefault: true })) };
    expect(checkProductIntegrity(bad, ctx).map((i) => i.message).join()).toMatch(/exactly one default/);
    expect(checkProductIntegrity({ ...s.products[0]!, categoryId: 99 }, ctx)[0]!.path).toBe('product.categoryId');
    expect(SLUG.test('pack-luxe-4-en-1')).toBe(true);
    expect(SLUG.test('Pack')).toBe(false);
    expect(isContentLinkHref('//evil.example')).toBe(false);
    expect(isContentLinkHref('tel:+213560417403')).toBe(true);
  });
});

test('category image: optional, unique id, not tied to a variant', () => {
  const ok = mut(clone()) as unknown as { categories: Record<string, unknown>[] };
  const image = { id: 9001, variantId: null, key: 'fixture/cat.jpg', width: 800, height: 600, alt: { ar: 'م', fr: 'c' }, position: 0, placeholder: true };
  ok.categories[0]!['image'] = image;
  ok.categories[1]!['image'] = null;
  expect(issuesOf(ok)).toEqual([]);
  ok.categories[0]!['image'] = { ...image, id: 5011 };
  expect(issuesOf(ok).join()).toMatch(/duplicate id 5011/);
  ok.categories[0]!['image'] = { ...image, variantId: 1011 };
  expect(issuesOf(ok).join()).toMatch(/cannot belong to a variant/);
});
