/**
 * Worker-rendered HTML for the no-JS path: fills orderform's static templates with HTMLRewriter
 * (plan WEB-0 §2.3–2.4; slot contract artifacts/WEB-3/review-slots.md). The Worker carries no UI
 * strings: every message is pre-rendered (hidden) in the template from brand copy; the Worker only
 * un-hides, sets values, and inserts data (names, amounts, options) escaped.
 */
import { formatNumber, formatPrice, isOrderRef, type Lang } from '@hb/shared';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

export interface ReviewLine {
  readonly name: string;
  readonly label: string | null;
  readonly qty: number;
  readonly unitPriceDzd: number;
  readonly lineTotalDzd: number;
}

export interface ReviewView {
  readonly lang: Lang;
  readonly lines: readonly ReviewLine[];
  readonly subtotalDzd: number | null;
  readonly feeDzd: number | null;
  readonly totalDzd: number | null;
  /** Hidden inputs appended to `form[data-hb="form"]`, in order. */
  readonly hidden: readonly (readonly [string, string])[];
  readonly name: string;
  readonly phone: string;
  readonly communes: readonly { readonly id: number; readonly name: string }[];
  readonly selectedCommune: number | undefined;
  /** Field or business error codes; each un-hides `[data-hb-error="<code>"]`. */
  readonly errors: readonly { readonly field: string; readonly code: string }[];
  /** Summary + confirm button (`data-hb-when="can-confirm"`) only when the order can be placed. */
  readonly canConfirm: boolean;
  /** Product page URL for the «edit» link (`a[data-hb="back"]`). */
  readonly backHref: string | null;
}

function linesHtml(view: ReviewView): string {
  return view.lines
    .map((l) => {
      const label = l.label === null ? '' : `<span class="of-line-variant">${escapeHtml(l.label)}</span>`;
      return (
        `<li class="of-line"><span class="of-line-name">${escapeHtml(l.name)}</span>${label}` +
        `<span class="of-line-qty"><bdi>${escapeHtml(formatPrice(l.unitPriceDzd, view.lang))}</bdi> × <bdi>${escapeHtml(formatNumber(l.qty, view.lang))}</bdi></span>` +
        `<bdi class="of-line-total">${escapeHtml(formatPrice(l.lineTotalDzd, view.lang))}</bdi></li>`
      );
    })
    .join('');
}

const unhide = (el: Element): void => {
  el.removeAttribute('hidden');
};

/** Fills the review template. The response keeps the template's bytes outside the slots. */
export function renderReview(template: Response, view: ReviewView, status: number, headers: Record<string, string>): Response {
  const codes = new Set(view.errors.map((e) => e.code));
  const fields = new Set(view.errors.map((e) => e.field));
  const states = new Set<string>();
  if (view.errors.length > 0) states.add('has-errors');
  if (view.canConfirm) states.add('can-confirm');
  const amount = (v: number | null) => (v === null ? '' : formatPrice(v, view.lang));

  const rewriter = new HTMLRewriter()
    .on('[data-hb="lines"]', { element: (el) => void el.setInnerContent(linesHtml(view), { html: true }) })
    .on('[data-hb="subtotal"]', { element: (el) => void el.setInnerContent(amount(view.subtotalDzd)) })
    .on('[data-hb="fee"]', { element: (el) => void el.setInnerContent(amount(view.feeDzd)) })
    .on('[data-hb="total"]', { element: (el) => void el.setInnerContent(amount(view.totalDzd)) })
    .on('[data-hb="name"]', { element: (el) => void el.setAttribute('value', view.name) })
    .on('[data-hb="phone"]', { element: (el) => void el.setAttribute('value', view.phone) })
    .on('[data-hb="back"]', {
      element: (el) => {
        if (view.backHref !== null) el.setAttribute('href', view.backHref);
      },
    })
    .on('[data-hb="commune-select"]', {
      element: (el) => {
        const opts = view.communes
          .map((c) => `<option value="${c.id}"${c.id === view.selectedCommune ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
          .join('');
        el.append(opts, { html: true });
      },
    })
    .on('[data-hb="form"]', {
      element: (el) => {
        const inputs = view.hidden
          .map(([n, v]) => `<input type="hidden" name="${escapeHtml(n)}" value="${escapeHtml(v)}">`)
          .join('');
        el.append(inputs, { html: true });
      },
    })
    .on('[data-hb-error]', {
      element: (el) => {
        if (codes.has(el.getAttribute('data-hb-error') ?? '')) unhide(el);
      },
    })
    .on('[data-hb-field]', {
      element: (el) => {
        if (fields.has(el.getAttribute('data-hb-field') ?? '')) el.setAttribute('aria-invalid', 'true');
      },
    })
    .on('[data-hb-when]', {
      element: (el) => {
        if (states.has(el.getAttribute('data-hb-when') ?? '')) unhide(el);
      },
    });

  const res = new Response(template.body, { status, headers: new Headers(template.headers) });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  res.headers.delete('Content-Length');
  res.headers.delete('ETag');
  return rewriter.transform(res);
}

/**
 * Confirmation page: puts a valid ref into `<bdi data-hb="ref">` and un-hides
 * `data-hb-when="has-ref"`. Anything else ⇒ the static page untouched (generic thank-you).
 */
export function renderConfirmation(page: Response, ref: string | undefined): Response {
  if (!isOrderRef(ref) || !page.ok) return page;
  return new HTMLRewriter()
    .on('[data-hb="ref"]', { element: (el) => void el.setInnerContent(ref) })
    .on('[data-hb-when="has-ref"]', { element: unhide })
    .transform(page);
}
