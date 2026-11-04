import { describe, expect, test } from 'vitest';
import { fixtureSnapshot, parseSnapshot, SnapshotError, validateSnapshot, type CatalogSnapshot } from '../src/index.ts';

const clone = (): CatalogSnapshot => structuredClone(fixtureSnapshot) as CatalogSnapshot;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const mut = (s: CatalogSnapshot) => s as unknown as Mutable<CatalogSnapshot>;
const issuesOf = (s: unknown): string[] => {
  const r = validateSnapshot(s);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('validateSnapshot', () => {
  test('fixture is valid', () => {
    expect(issuesOf(fixtureSnapshot)).toEqual([]);
    expect(parseSnapshot(fixtureSnapshot)).toEqual(fixtureSnapshot);
  });

  test('round-trips through JSON (snapshot is plain JSON)', () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify(fixtureSnapshot)))).toEqual(fixtureSnapshot);
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

  test('content link hrefs are same-origin, tel: or wa.me only', () => {
    const s = mut(clone()) as unknown as { contentPages: { body: { fr: { type: string; href?: string }[] } }[] };
    s.contentPages[0]!.body.fr[3]!.href = 'https://evil.example/';
    expect(issuesOf(s).join()).toMatch(/link href/);
  });

  test('parseSnapshot throws SnapshotError listing issues', () => {
    expect(() => parseSnapshot({}, 'test')).toThrow(SnapshotError);
  });
});
