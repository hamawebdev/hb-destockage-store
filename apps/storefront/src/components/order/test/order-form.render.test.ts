// Renders OrderForm.astro with Astro's container (shell's vitest.config.ts uses getViteConfig).
// Set ORDER_RENDER_OUT=<dir> to also write the HTML (used for byte measurements in artifacts/ORDER-1).
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import OrderForm from '../OrderForm.astro';
import { orderFormConfigJson } from '../form-model.ts';
import { SHOP_NUMBER, singleForm, strings, variableForm } from './fixtures.ts';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

const render = async (lang: 'ar' | 'fr', form = singleForm(lang), name = 'single') => {
  const html = await container.renderToString(OrderForm, {
    props: { lang, form, productName: 'Pack 3 en 1', brandLatin: null, strings: strings[lang], privacyHref: `/${lang}/privacy/` },
  });
  const out = process.env['ORDER_RENDER_OUT'];
  if (out) writeFileSync(`${out}/${lang}-${name}.html`, html);
  return html;
};
const attrs = (html: string, id: string) => html.match(new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`))?.[0] ?? '';

describe.each(['ar', 'fr'] as const)('OrderForm rendered (%s)', (lang) => {
  it('cart mode does not depend on the borrowed product being orderable (review I3)', async () => {
    const html = await container.renderToString(OrderForm, {
      props: { lang, mode: 'cart', form: { ...singleForm(lang), orderable: false }, strings: strings[lang] },
    });
    expect(html).not.toMatch(/<fieldset[^>]*\bdisabled/);
    expect(html).not.toContain('of-unavail');
    expect(html).toContain('id="of-rows"');
  });

  it('the variant picker comes last, after the delivery panel, still inside the form', async () => {
    const html = await container.renderToString(OrderForm, {
      props: { lang, form: singleForm(lang), strings: strings[lang] },
      slots: { picker: '<div class="cat-picker">x</div>' },
    });
    expect(html.indexOf('class="cat-picker"')).toBeGreaterThan(html.indexOf('id="of-sum"'));
    expect(html.indexOf('class="cat-picker"')).toBeLessThan(html.indexOf('</fieldset>'));
  });

  it('a sold-out product keeps its disabled form', async () => {
    const html = await render(lang, { ...singleForm(lang), orderable: false }, 'sold-out');
    expect(html).toMatch(/<fieldset[^>]*\bdisabled/);
    expect(html).toContain('of-unavail');
  });

  it('is a plain POST form to /api/order that works without JS', async () => {
    const html = await render(lang);
    expect(html).toMatch(/<form id="order-form" class="of-form" method="post" action="\/api\/order" novalidate/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/challenges\.cloudflare\.com/);
    for (const n of ['lang', 'productId', 'variantId', 'name', 'phone', 'wilayaCode', 'communeId', 'qty', 'website', 'step', 'idempotencyKey'])
      expect(html, n).toContain(`name="${n}"`);
    expect(html).toContain('name="idempotencyKey" value=""');
    expect(html).toContain('name="step" value="review"');
  });

  it('has the required phone input attributes', async () => {
    const phone = attrs(await render(lang), 'of-phone');
    for (const a of ['type="tel"', 'inputmode="tel"', 'dir="ltr"', 'autocomplete="tel"', 'required', 'maxlength="64"']) expect(phone).toContain(a);
    expect(phone).not.toMatch(/pattern=/);
    expect(attrs(await render(lang), 'of-name')).not.toMatch(/maxlength=/); // review r1 F1: no raw cap below the server's
  });

  it('lists 69 wilayas after the placeholder and leaves communes for JS / the review step', async () => {
    const html = await render(lang);
    const sel = html.slice(html.indexOf('id="of-wilaya"'), html.indexOf('</select>', html.indexOf('id="of-wilaya"')));
    expect(sel.match(/<option value="\d+">/g)).toHaveLength(69);
    expect(attrs(html, 'of-commune')).toContain('disabled');
    expect(html).toMatch(/<noscript><p id="of-commune-hint"/);
  });

  it('ties every label, hint and error slot to an existing element', async () => {
    const html = await render(lang);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]));
    for (const [, f] of html.matchAll(/<label for="([^"]+)"/g)) expect(ids.has(f), f).toBe(true);
    for (const [, d] of html.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of d!.split(' ')) expect(ids.has(id), id).toBe(true);
    expect(attrs(html, 'of-status')).toContain('aria-live="polite"');
    expect(attrs(html, 'of-alert')).toContain('role="alert"');
  });

  it('keeps the honeypot out of the accessibility tree by class, not aria-hidden', async () => {
    const html = await render(lang);
    expect(html).toMatch(/<div class="of-hp">\s*<label for="of-hp">[^<]+<\/label>\s*<input id="of-hp" name="website" type="text" tabindex="-1" autocomplete="off">/);
    expect(html.slice(html.indexOf('class="of-hp"') - 20, html.indexOf('id="of-hp" name'))).not.toContain('aria-hidden');
  });

  it('inlines only the UI-state strings; error copy lives in form.json (BUG-12)', async () => {
    const html = await render(lang);
    const tpl = html.slice(html.indexOf('<template id="of-ui">'));
    expect(tpl.match(/data-k=/g)).toHaveLength(10); // 6 UI states + 4 messages a quote can trigger before form.json
    expect(tpl).toContain('data-k="delivery_unavailable"');
    expect(tpl).not.toMatch(/\{phone\}|\[PLACEHOLDER\]/);
    expect(tpl).not.toContain('data-k="network_error"');
    expect(html).not.toContain('of-msgs');
    expect(html).toMatch(/data-cfg="\/(ar|fr)\/order\/form\.json\?v=[\w-]+"/);
    const out = process.env['ORDER_RENDER_OUT'];
    if (out) writeFileSync(`${out}/${lang}-form.json`, orderFormConfigJson(lang, strings[lang]).json);
  });

  it('lets pages post the variant for multi-variant products', async () => {
    const html = await render(lang, variableForm(lang), 'variable');
    expect(html).not.toContain('name="variantId"');
    expect(html).toContain('data-variants="21:3200:3,22:3400:0"');
    expect(attrs(html, 'of-qty')).toContain('max="3"');
  });

  it('renders the Turnstile hooks without any third-party URL (rendered for the ORDER-3 browser test)', async () => {
    const html = await render(lang, singleForm(lang, { turnstileSiteKey: '1x00000000000000000000AA' }), 'ts');
    expect(html).toMatch(/data-ts-key="1x00000000000000000000AA"/);
    expect(html).toMatch(/data-ts-js="\/js\/order-ts\.js\?v=[\w-]+"/);
    expect(html).not.toMatch(/challenges\.cloudflare\.com|preconnect|dns-prefetch/);
  });

  it('disables the form and links back to the shop when nothing is orderable', async () => {
    const html = await render(lang, singleForm(lang, { orderable: false }), 'oos');
    expect(html).toMatch(/<fieldset class="of-fields" disabled>/);
    expect(html).toMatch(new RegExp(`id="of-unavail">[\\s\\S]*href="/${lang}/"`));
  });

  it('shows no shop phone or WhatsApp before an order, in any state (D-029)', async () => {
    const states = { 'no-number-single': singleForm(lang), 'no-number-oos': singleForm(lang, { orderable: false }), 'no-number-variable': variableForm(lang) };
    for (const [name, form] of Object.entries(states)) expect(await render(lang, form, name)).not.toMatch(SHOP_NUMBER);
    const cart = await container.renderToString(OrderForm, { props: { lang, mode: 'cart', form: singleForm(lang), strings: strings[lang] } });
    expect(cart).not.toMatch(SHOP_NUMBER);
  });
});
