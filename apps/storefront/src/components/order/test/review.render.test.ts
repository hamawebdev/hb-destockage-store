// ORDER-6: the no-JS review template honours web's frozen slot contract (artifacts/WEB-3/review-slots.md).
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import Review from '../Review.astro';
import { REVIEW_ERROR_CODES, REVIEW_FIELD_CODES } from '../review-codes.ts';
import { contact, strings } from './fixtures.ts';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});
const tag = (html: string, re: RegExp) => html.match(re)?.[0] ?? '';

describe.each(['ar', 'fr'] as const)('Review template (%s)', (lang) => {
  const render = () => container.renderToString(Review, { props: { lang, strings: strings[lang], contact } });

  it('posts to /api/order and carries no hidden input of its own (the Worker appends them)', async () => {
    const html = await render();
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(tag(html, /<form[^>]*>/)).toMatch(/data-hb="form" method="post" action="\/api\/order"/);
    expect(form).not.toMatch(/type="hidden"/);
  });

  it('pre-renders every error code the Worker may show, hidden, with resolved copy', async () => {
    const html = await render();
    for (const code of REVIEW_ERROR_CODES) {
      const els = html.match(new RegExp(`<[a-z]+[^>]*data-hb-error="${code}"[^>]*>`, 'g')) ?? [];
      const field = Object.values(REVIEW_FIELD_CODES).some((codes) => (codes as readonly string[]).includes(code));
      expect(els, code).toHaveLength(field ? 2 : 1); // summary + under the field
      for (const el of els) expect(el, code).toMatch(/\shidden/);
    }
    // order.errors.order_total_out_of_range was added by brand (BRAND-3 ebf90cc) after this branch's copy of brand/copy;
    // it arrives through main. Until then it may be missing (rendered as a visible [PLACEHOLDER], refused by
    // HB_STRICT_COPY=1); once present (e.g. on team/pages, which has ebf90cc) its real copy must render. No other code
    // may lack copy. (It was pinned as exactly-missing so that the copy's arrival would be flagged; it was, on team/pages.)
    const missing = REVIEW_ERROR_CODES.filter((c) => strings[lang][`order.errors.${c}`] === undefined);
    expect(['order_total_out_of_range']).toEqual(expect.arrayContaining(missing));
    let withoutGaps = html;
    for (const c of missing) withoutGaps = withoutGaps.replace(new RegExp(`<[a-z]+[^>]*data-hb-error="${c}"[^>]*>[^<]*</[a-z]+>`, 'g'), '');
    expect(withoutGaps).not.toMatch(/\[PLACEHOLDER\]|\{(phone|max|option)\}/);
    expect(html).toContain('⁦0560417403⁩'); // {phone} isolated LTR inside messages
  });

  it('has the frozen value/insertion slots with the right attributes', async () => {
    const html = await render();
    expect(tag(html, /<input[^>]*data-hb="name"[^>]*>/)).toMatch(/name="name"/);
    const phone = tag(html, /<input[^>]*data-hb="phone"[^>]*>/);
    for (const a of ['name="phone"', 'type="tel"', 'inputmode="tel"', 'dir="ltr"', 'maxlength="64"']) expect(phone).toContain(a);
    const sel = html.slice(html.indexOf('<select'), html.indexOf('</select>'));
    expect(sel).toMatch(/name="communeId" required/);
    expect(sel).toMatch(/data-hb="commune-select"/);
    expect(sel.match(/<option/g)).toHaveLength(1);
    expect(sel).toMatch(/<option value="">/);
    for (const s of ['lines', 'subtotal', 'fee', 'total', 'back']) expect(html, s).toMatch(new RegExp(`data-hb="${s}"`));
    for (const f of ['name', 'phone', 'communeId']) expect(html, f).toContain(`data-hb-field="${f}"`);
  });

  it('keeps amounts and the confirm button inside can-confirm, and the error summary hidden as an alert', async () => {
    const html = await render();
    const blocks = [...html.matchAll(/<(div|section)[^>]*data-hb-when="can-confirm"[^>]*hidden[^>]*>[\s\S]*?<\/\1>/g)].map((m) => m[0]);
    expect(blocks).toHaveLength(2);
    expect(blocks.join('')).toMatch(/data-hb="total"/);
    expect(blocks.join('')).toMatch(/<button type="submit"/);
    expect(html.slice(html.indexOf('</form>'))).not.toMatch(/<button/);
    expect(tag(html, /<div[^>]*data-hb-when="has-errors"[^>]*>/)).toMatch(/role="alert"[^>]*hidden|hidden[^>]*role="alert"/);
  });

  it('ties fields to always-rendered error containers (hidden messages are never read as descriptions)', async () => {
    const html = await render();
    for (const [, ids] of html.matchAll(/aria-describedby="([^"]+)"/g))
      for (const id of ids!.split(' ')) expect(tag(html, new RegExp(`<[a-z]+ id="${id}"[^>]*>`)), id).not.toMatch(/\shidden/);
    expect(html).not.toMatch(/<script|\sstyle="|\son[a-z]+=/i);
  });
});

describe('Review template CSS', () => {
  it('lets `hidden` win over every display rule (the Worker shows/hides only via `hidden`)', () => {
    const src = readFileSync(fileURLToPath(new URL('../Review.astro', import.meta.url)), 'utf8');
    const css = src.slice(src.indexOf('<style'));
    expect(css).toMatch(/\.or \[hidden\] \{ display: none !important; \}/);
    expect(css).not.toMatch(/(margin|padding|border)-(left|right)|[^-](left|right)\s*:|letter-spacing/);
  });
});
