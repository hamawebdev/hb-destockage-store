// ORDER-4: confirmation page content, rendered with Astro's container from the real CAT-3 props fixture.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import Confirmation from '../Confirmation.astro';
import { strings } from './fixtures.ts';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});
// Real CAT-3 props; strings = brand/copy (what the build uses when brand's files exist, shell lib/catalog.ts),
// not the catalogue's older fixture copy.
const props = (lang: 'ar' | 'fr') => {
  const p = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../../packages/catalog/fixtures/props.${lang}.json`, import.meta.url)), 'utf8'))
    .pages[`/${lang}/order/confirmation/`].props;
  return { ...p, layout: { ...p.layout, strings: strings[lang] } };
};

describe.each(['ar', 'fr'] as const)('Confirmation (%s)', (lang) => {
  const render = async () => container.renderToString(Confirmation, { props: { props: props(lang) } });

  it('has a heading without the Latin store name (QA-1 BUG-9)', async () => {
    const h1 = (await render()).match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1] ?? '';
    expect(h1.length).toBeGreaterThan(5);
    expect(h1).not.toMatch(/HB Destockage/);
  });

  it('exposes exactly web\'s frozen slots: hidden has-ref block with an empty LTR <bdi data-hb="ref">', async () => {
    const html = await render();
    expect(html).toMatch(/<div class="oc-ref" data-hb-when="has-ref" hidden>/);
    expect(html).toMatch(/<bdi class="oc-ref-value" dir="ltr" translate="no" data-hb="ref"><\/bdi>/);
    expect(html.match(/data-hb=/g)).toHaveLength(1);
    expect(html.match(/data-hb-when=/g)).toHaveLength(1);
  });

  it('isolates the contact phone, links WhatsApp plainly, and needs no JS', async () => {
    const html = await render();
    expect(html).toContain('<a class="oc-link" href="tel:+213560417403"><bdi dir="ltr">0560 41 74 03</bdi></a>');
    expect(html).toContain('href="https://wa.me/213779942022"');
    expect(html).not.toMatch(/<script|\sstyle="|\son[a-z]+=|\{phone\}|\[PLACEHOLDER\]/i);
    expect(html).toContain(`href="/${lang}/"`);
  });

  it('lists the three next steps (call, shipping, cash on delivery)', async () => {
    expect((await render()).match(/<li>/g)).toHaveLength(3);
  });
});
