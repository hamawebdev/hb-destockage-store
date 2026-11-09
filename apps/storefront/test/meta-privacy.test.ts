// The Meta section on the privacy page (META-6; contract §8).
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { ContentProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ContentView from '../src/components/content/ContentView.astro';

const PIXEL = '000000000000000';
const root = join(import.meta.dirname, '..', '..', '..');

/** The rendered text escapes apostrophes; compare on a stretch that has none. */
const stripMark = (text: string) => text.replace(/\[PLACEHOLDER[^\]]*\]\s*/, '').split(/['"]/)[0]!.slice(0, 40);

function privacyProps(lang: 'ar' | 'fr'): ContentProps {
  const page = Object.values(fixturePages(lang)).find((p) => p.template === 'content');
  if (!page) throw new Error('no content fixture');
  const props = page.props as ContentProps;
  return { ...props, page: { ...props.page, key: 'privacy' } };
}

describe.each(['ar', 'fr'] as const)('privacy page (%s)', (lang) => {
  let c: AstroContainer;
  beforeAll(async () => {
    c = await AstroContainer.create();
  });
  afterEach(() => vi.unstubAllEnvs());
  const render = (props: ContentProps) => c.renderToString(ContentView, { props: { props } });

  it('no section and no button when Meta is off', async () => {
    vi.stubEnv('META_PIXEL_ID', '');
    const p = privacyProps(lang);
    const html = await render(p);
    expect(html).not.toContain('data-meta-reset');
    expect(html).not.toContain(p.layout.strings['privacy.meta.title']);
  });

  it('section, legal-review mark and hidden reset button when configured', async () => {
    vi.stubEnv('META_PIXEL_ID', PIXEL);
    const p = privacyProps(lang);
    const html = await render(p);
    expect(html).toContain(p.layout.strings['privacy.meta.title']);
    expect(html).toMatch(/data-placeholder="privacy\.meta\.body1"/);
    expect(html).toMatch(/<button[^>]*data-meta-reset[^>]*hidden/);
    // Last in the body, after the page's own text, so revealing it moves nothing above the footer.
    expect(html.indexOf('data-meta-reset')).toBeGreaterThan(html.lastIndexOf('</ul>'));
    expect(html).not.toContain('ct-reset');
    expect(html).toContain(p.layout.strings['consent.change']);
  });

  it('consent required: promises the choice; no consent-off wording', async () => {
    vi.stubEnv('META_PIXEL_ID', PIXEL);
    const p = privacyProps(lang);
    const html = await render(p);
    expect(html).toMatch(/data-placeholder="privacy\.meta\.body1"/);
    expect(html).toContain(stripMark(p.layout.strings['privacy.meta.body2']!));
    expect(html).not.toContain(stripMark(p.layout.strings['privacy.meta.off.body2']!));
  });

  it('META_CONSENT_REQUIRED=0: the variant, marked for legal review, with no promise of acceptance', async () => {
    vi.stubEnv('META_PIXEL_ID', PIXEL);
    vi.stubEnv('META_CONSENT_REQUIRED', '0');
    const p = privacyProps(lang);
    const html = await render(p);
    expect(html).toMatch(/data-placeholder="privacy\.meta\.off\.body1"/);
    expect(html).toContain(stripMark(p.layout.strings['privacy.meta.off.body2']!));
    expect(html).not.toContain(stripMark(p.layout.strings['privacy.meta.body2']!));
    expect(html).toMatch(/<button[^>]*data-meta-reset[^>]*hidden/);
  });

  it('only on the privacy page', async () => {
    vi.stubEnv('META_PIXEL_ID', PIXEL);
    const p = privacyProps(lang);
    expect(await render({ ...p, page: { ...p.page, key: 'about' } })).not.toContain('data-meta-reset');
  });

  it('the copy says what is sent and that a choice is required, marked for legal review', () => {
    const strings = JSON.parse(readFileSync(join(root, `brand/copy/strings.${lang}.json`), 'utf8')) as Record<string, string>;
    expect(strings['privacy.meta.body1']).toMatch(/\[PLACEHOLDER:/);
    for (const k of ['privacy.meta.title', 'privacy.meta.body1', 'privacy.meta.body2', 'privacy.meta.body3', 'privacy.meta.body4']) expect(strings[k], k).toBeTruthy();
  });
});

it('the seed privacy text no longer promises no cookies at all', () => {
  const p = JSON.parse(readFileSync(join(root, 'data/content/privacy.json'), 'utf8')) as { body: Record<'ar' | 'fr', { type: string; items?: string[] }[]> };
  const items = (lang: 'ar' | 'fr') => p.body[lang].flatMap((b) => b.items ?? []);
  expect(items('fr')).not.toContain('Aucun cookie.');
  expect(items('fr').some((x) => x.startsWith('Aucun cookie, sauf'))).toBe(true);
  expect(items('ar')).not.toContain('لا نستعمل ملفات تعريف الارتباط (كوكيز).');
});
