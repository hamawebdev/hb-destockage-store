import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DZ_MOBILE_NSN_PATTERN, normalizePhone } from '@hb/shared/phone';
import { ERROR_MESSAGE_KEYS, PHONE_INPUT_MAX_LENGTH, UI_MESSAGE_KEYS, orderFormConfig, orderFormConfigJson, orderFormModel, variantsAttr } from '../form-model.ts';
import { str } from '../str.ts';
import { contact, singleForm, strings, variableForm } from './fixtures.ts';

const LANGS = ['ar', 'fr'] as const;
const model = (lang: 'ar' | 'fr', form = singleForm(lang), extra = {}) =>
  orderFormModel({ lang, form, productName: 'Pack 3 en 1', brandLatin: null, strings: strings[lang], contact, ...extra });

describe('orderFormModel', () => {
  it.each(LANGS)('lists all 69 wilayas in code order (%s)', (lang) => {
    const m = model(lang);
    expect(m.wilayas).toHaveLength(69);
    expect(m.wilayas.map((w) => w.value)).toEqual(Array.from({ length: 69 }, (_, i) => String(i + 1)));
    expect(m.wilayas[15]?.label).toMatch(/^16 - /);
  });

  it('renders the shared libphonenumber pattern, never ^0[567]', () => {
    const cfg = orderFormConfig('ar', strings.ar, contact); // /ar/order/form.json (BUG-12)
    const re = new RegExp(`^(?:${cfg.re})$`);
    expect(cfg.re).toBe(DZ_MOBILE_NSN_PATTERN);
    for (const ok of ['555123456', '661234567', '771234567', '540123456', '560123456']) expect(re.test(ok)).toBe(true);
    for (const bad of ['501234567', '531234567', '551234567'.slice(0, 8), '21123456']) expect(re.test(bad)).toBe(false);
  });

  it('contains nothing per-visitor: deterministic, no idempotency key, no timestamp', () => {
    const a = JSON.stringify({ ...model('ar'), t: null });
    const b = JSON.stringify({ ...model('ar'), t: null });
    expect(a).toBe(b);
    expect(model('ar').hidden.map((h) => h.name)).not.toContain('idempotencyKey');
    expect(a).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    expect(a).not.toMatch(/1[78]\d{11}/); // epoch-ms timestamps
  });

  it('posts the no-JS contract fields (WEB-0 §2.3)', () => {
    expect(model('fr').hidden).toEqual([
      { name: 'lang', value: 'fr' },
      { name: 'productId', value: '7' },
      { name: 'step', value: 'review' },
      { name: 'variantId', value: '12' },
    ]);
  });

  it('leaves variantId to pages for multi-variant products', () => {
    const m = model('ar', variableForm('ar'));
    expect(m.hidden.map((h) => h.name)).not.toContain('variantId');
    expect(m.summary.variantLabel).toBe('أحمر / L');
  });

  it('encodes variants as id:price:maxQty and clamps qty to the default variant', () => {
    expect(variantsAttr(variableForm('fr').variants)).toBe('21:3200:3,22:3400:0');
    expect(model('fr', variableForm('fr')).qty).toEqual({ min: 1, max: 3, value: 1 });
    expect(model('fr').qty.max).toBe(10);
  });

  it('adds data-js only with a version, in the shape shell\'s loader accepts', () => {
    expect(model('ar').dataAttrs['data-js']).toBeUndefined();
    const js = model('ar', singleForm('ar'), { jsVersion: 'aB3_-x9Zq0' }).dataAttrs['data-js'];
    expect(js).toMatch(/^\/js\/[\w.-]+\.js(\?v=[\w-]+)?$/);
  });

  it('wires lazy Turnstile only with a site key and the first-party loader, never a third-party URL', () => {
    expect(model('ar').dataAttrs['data-ts-key']).toBeUndefined();
    expect(model('ar', variableForm('ar')).dataAttrs['data-ts-js']).toBeUndefined(); // loader not built
    const m = model('ar', variableForm('ar'), { tsJsVersion: 'Ab_9-xyz01' });
    expect(m.dataAttrs['data-ts-key']).toBe('0x4AAAAAAA-test');
    expect(m.dataAttrs['data-ts-js']).toBe('/js/order-ts.js?v=Ab_9-xyz01');
    expect(model('ar', singleForm('ar'), { tsJsVersion: 'x' }).dataAttrs['data-ts-js']).toBeUndefined(); // no key
    expect(JSON.stringify(m.dataAttrs)).not.toMatch(/https?:\/\//);
  });

  it.each(LANGS)('resolves every message from brand copy: UI inline, errors in form.json (%s)', (lang) => {
    const m = model(lang, variableForm(lang));
    expect(m.uiMessages.map((x) => x.code)).toEqual(Object.keys(UI_MESSAGE_KEYS));
    for (const { code, text } of m.uiMessages) expect(text, code).not.toContain('[PLACEHOLDER]');
    const cfg = orderFormConfig(lang, strings[lang], contact);
    expect(Object.keys(cfg.m)).toEqual(Object.keys(ERROR_MESSAGE_KEYS));
    for (const [code, text] of Object.entries(cfg.m)) {
      expect(text, code).not.toContain('[PLACEHOLDER]');
      expect(text, code).not.toMatch(/\{(phone|option)\}/);
    }
    expect(cfg.m.rate_limited).toContain('⁦0560417403⁩'); // phone isolated LTR inside RTL text
    expect(cfg.confirm).toBe(`/${lang}/order/confirmation/`);
  });

  it('versions data-cfg by the exact JSON the endpoint serves', () => {
    const { json, version } = orderFormConfigJson('fr', strings.fr, contact);
    expect(model('fr').dataAttrs['data-cfg']).toBe(`/fr/order/form.json?v=${version}`);
    expect(version).toMatch(/^[\w-]{10}$/);
    expect(JSON.parse(json).v).toBe(1);
    expect(model('fr').dataAttrs['data-phone-re']).toBeUndefined();
  });

  it('starts the summary with the static price and no fee/total', () => {
    const m = model('ar');
    expect(m.summary.unitPrice).toBe(m.summary.subtotal);
    expect(m.summary.unitPrice).toMatch(/14\.600/);
    expect(m.summary.total).toBe('—');
  });
});

describe('no client length cap below what the server accepts (ORDER-1 review r1 F1)', () => {
  // The longest accepted spellings in @hb/shared's phone tests (packages/shared/test/phone.test.ts, team/shared
  // SHARED-2) plus rev-e's repro, and the same wrapped in the bidi isolates contact apps add when copying.
  const LONGEST_ACCEPTED = [
    '00213 (0) 555 12 34 56',
    '+213 (0) 560 41 74 03',
    '00 213 560 41 74 03',
    '\u2067+213 560 41 74 03\u2069',
    '+٢١٣ ٥٦٠ ٤١ ٧٤ ٠٣',
    '  0560417403  ',
    '\u2067\u200f00213 (0) 555 12 34 56\u200e\u2069',
  ];
  // Accepted only from SHARED-2 on (this branch still carries SHARED-1): checked for length only.
  const SHARED2_ONLY = ['213 0560 41 74 03', '05–60—41‐74−03'];
  it.each(SHARED2_ONLY)('%j (SHARED-2) fits in the phone input', (spelling) => {
    expect(spelling.length).toBeLessThanOrEqual(PHONE_INPUT_MAX_LENGTH);
  });
  it.each(LONGEST_ACCEPTED)('%j fits in the phone input and is accepted by the server', (spelling) => {
    expect(normalizePhone(spelling).ok).toBe(true);
    expect(spelling.length).toBeLessThanOrEqual(orderFormModel({ lang: 'ar', form: singleForm('ar'), productName: 'x', brandLatin: null, strings: strings.ar, contact }).phone.maxLength);
  });
  it('mirrors @hb/shared PHONE_INPUT_MAX_LENGTH (64) and caps nothing else', () => {
    expect(PHONE_INPUT_MAX_LENGTH).toBe(64);
    const m = model('fr');
    expect(m.phone.maxLength).toBe(64);
    expect(m.name).toEqual({ minLength: 2 });
  });
});

describe('str', () => {
  afterEach(() => {
    delete process.env['HB_STRICT_COPY'];
  });
  it('marks a missing key as a placeholder in dev and throws in strict builds', () => {
    expect(str({}, 'order.nope')).toBe('[PLACEHOLDER] order.nope');
    process.env['HB_STRICT_COPY'] = '1';
    expect(() => str({}, 'order.nope')).toThrow(/missing UI string/);
    expect(() => str({ k: '[PLACEHOLDER] x' }, 'k')).toThrow(/placeholder/);
  });
  it('fills only known variables', () => {
    expect(str({ k: 'a {max} {total}' }, 'k', { max: 3 })).toBe('a 3 {total}');
  });
});

describe('OrderForm.astro source rules (CSP + RTL)', () => {
  const src = readFileSync(fileURLToPath(new URL('../OrderForm.astro', import.meta.url)), 'utf8');
  const css = src.slice(src.indexOf('<style'));
  it('has no script, no style= attribute, no inline handler', () => {
    expect(src).not.toMatch(/<script/i);
    expect(src).not.toMatch(/\sstyle=/);
    expect(src).not.toMatch(/\son[a-z]+=/i);
    expect(src).not.toMatch(/client:/);
  });
  it('uses logical properties only and no letter-spacing', () => {
    expect(css).not.toMatch(/(margin|padding|border)-(left|right)|[^-](left|right)\s*:|text-align:\s*(left|right)|float:/);
    expect(css).not.toMatch(/letter-spacing/);
  });
  it('keeps the idempotency key empty in the markup', () => {
    expect(src).toMatch(/name="idempotencyKey" value=""/);
  });
});

describe('real CAT-3 props fixtures (packages/catalog/fixtures/props.<lang>.json)', () => {
  // `@hb/catalog/fixtures/props` builds them; the committed JSON is the same data without running sharp.
  const load = (lang: 'ar' | 'fr') =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../../packages/catalog/fixtures/props.${lang}.json`, import.meta.url)), 'utf8')) as {
      pages: Record<string, { template: string; props: any }>;
    };
  it.each(LANGS)('builds a valid model for every product page (%s)', (lang) => {
    const products = Object.entries(load(lang).pages).filter(([, p]) => p.template === 'product');
    expect(products.length).toBeGreaterThan(2);
    for (const [path, { props }] of products) {
      const m = orderFormModel({ lang, form: props.orderForm, productName: props.product.name, brandLatin: props.product.brandLatin, strings: props.layout.strings, contact: props.layout.contact });
      expect(m.wilayas.map((w) => w.value), path).toEqual(props.orderForm.wilayas.map((w: any) => String(w.code))); // fixture snapshot has a few wilayas; 69 is asserted above
      expect(m.dataAttrs['data-communes'], path).toBe(`/geo/communes/${lang}/{code}.json`);
      expect(m.dataAttrs['data-cfg'], path).toMatch(new RegExp(`^/${lang}/order/form\\.json\\?v=`));
      const dv = props.orderForm.variants.find((v: any) => v.id === props.orderForm.defaultVariantId);
      expect(m.qty.max, path).toBeLessThanOrEqual(Math.max(1, dv.maxQty));
      expect(m.hidden.some((h) => h.name === 'variantId'), path).toBe(props.orderForm.singleVariant);
    }
    expect(products.some(([, p]) => p.props.orderForm.orderable === false)).toBe(true);
  });
});

describe('Turnstile origin appears only in the lazily imported first-party loader', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  it('is in public/js/order-ts.js and nowhere in the component or order.js', () => {
    expect(read('../../../../public/js/order-ts.js')).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    expect(read('../../../../public/js/order.js')).not.toContain('cloudflare');
    expect(read('../OrderForm.astro')).not.toContain('cloudflare');
  });
  it('is imported by order.js only from the first focusin/pointerdown inside the form', () => {
    const js = read('../../../../public/js/order.js');
    expect(js.match(/import\(ds\.tsJs\)/g)).toHaveLength(1);
    const start = js.slice(js.indexOf('const start = () =>'), js.indexOf("f.addEventListener('pointerdown', start);") + 40);
    expect(start).toContain('if (started) return;');
    expect(start).toContain("f.addEventListener('focusin', start);");
    expect(js).not.toMatch(/requestIdleCallback|IntersectionObserver|addEventListener\('(load|scroll)'/);
  });
});
