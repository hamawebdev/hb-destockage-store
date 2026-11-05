// Renders the category template with Astro's container on CAT-3's fixture props (both languages).
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { CategoryProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import CategoryView from '../CategoryView.astro';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});
afterEach(() => {
  delete process.env['HB_STRICT_COPY'];
});

const pages = { ar: fixturePages('ar'), fr: fixturePages('fr') };
const category = (lang: 'ar' | 'fr', path: string): CategoryProps => {
  const page = pages[lang][path];
  if (!page || page.template !== 'category') throw new Error(`no category ${path}`);
  return page.props as CategoryProps;
};
const KITCHEN = { ar: '/ar/c/matbakh/', fr: '/fr/c/cuisine/' };
const KITCHEN2 = { ar: '/ar/c/matbakh/2/', fr: '/fr/c/cuisine/2/' };
const EMPTY = { ar: '/ar/c/hammam/', fr: '/fr/c/salle-de-bain/' };

describe.each(['ar', 'fr'] as const)('category page (%s)', (lang) => {
  it('grid, chips, pagination with rel prev/next and the current page marked', async () => {
    const p = category(lang, KITCHEN2[lang]);
    const html = await container.renderToString(CategoryView, { props: { ...p } });
    expect(html.match(/<article class="cat-card/g)?.length).toBe(p.products.length);
    expect(html).toContain('rel="prev"');
    expect(html).toMatch(/aria-current="page"[^>]*>2</);
    expect(html).toContain('aria-current="true"');
    for (const s of p.subCategories) expect(html).toContain(`href="${s.href}"`);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('empty category: empty state with a way out, no grid, no pager', async () => {
    const html = await container.renderToString(CategoryView, { props: { ...category(lang, EMPTY[lang]) } });
    expect(html).toContain('class="cat-empty"');
    expect(html).not.toContain('cat-grid');
    expect(html).not.toContain('cat-pager');
  });

  it('dev builds mark placeholders; HB_STRICT_COPY=1 builds render none of the QA markers', async () => {
    const p = category(lang, KITCHEN[lang]);
    const dev = await container.renderToString(CategoryView, { props: { ...p } });
    expect(dev).toContain('cat-flag--ph');
    process.env['HB_STRICT_COPY'] = '1';
    const strict = await container.renderToString(CategoryView, { props: { ...p } });
    expect(strict).not.toMatch(/cat-flag--ph|class="cat-ph"/);
    expect(strict).not.toContain(p.layout.strings['dev.placeholder']!);
  });
});
