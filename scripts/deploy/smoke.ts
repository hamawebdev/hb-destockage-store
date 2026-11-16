// Post-deployment smoke checks. Read-only: POST /api/order is sent an invalid body, so no order
// or notification is ever created. Docs: docs/DEPLOY.md.

export interface SmokeProduct {
  readonly status: string;
  readonly slug: { readonly ar: string; readonly fr: string };
  readonly variants: readonly {
    readonly id: number;
    readonly priceDzd: number;
    readonly stock: number | null;
    readonly active: boolean;
  }[];
}

export interface SmokeSnapshot {
  readonly products: readonly SmokeProduct[];
  /** Wilayas production has a confirmed fee for (up to 3); empty until the client confirms fees. */
  readonly quoteWilayas: readonly number[];
  /** A wilaya production must refuse: one with a placeholder fee, or any when none is confirmed. */
  readonly refusedWilaya: number | null;
}

export interface SmokeTargets {
  readonly siteOrigin: string; // https://shop.example
  readonly adminOrigin: string; // https://admin.shop.example
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const UA = 'hb-deploy-smoke/1 (GitHub Actions)';

const lang = (l: string): { lang: string; dir: string } => ({ lang: l, dir: l === 'ar' ? 'rtl' : 'ltr' });

/** The attributes of the <html> tag of a page. */
function htmlTag(html: string): string {
  return /<html\b[^>]*>/i.exec(html)?.[0] ?? '';
}

function attr(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*["']?([^"'\\s>]+)`, 'i').exec(tag)?.[1] ?? null;
}

/** Problems with a storefront page; empty when the page is good. */
export function checkStorefront(l: 'ar' | 'fr', status: number, html: string, snapshot: SmokeSnapshot): string[] {
  const problems: string[] = [];
  if (status !== 200) problems.push(`/${l}/ returned ${status}, expected 200`);
  const want = lang(l);
  const tag = htmlTag(html);
  if (attr(tag, 'lang') !== want.lang) problems.push(`/${l}/ <html lang> is ${attr(tag, 'lang')}, expected ${want.lang}`);
  if (attr(tag, 'dir') !== want.dir) problems.push(`/${l}/ <html dir> is ${attr(tag, 'dir')}, expected ${want.dir}`);
  const hasProduct = snapshot.products.some((p) => p.status === 'active' && html.includes(`/${l}/p/${p.slug[l]}/`));
  if (!hasProduct) problems.push(`/${l}/ has no link to a product of the published catalogue`);
  return problems;
}

/** A variant that is on sale, or null when the catalogue has none. */
export function sellableVariant(snapshot: SmokeSnapshot): number | null {
  for (const p of snapshot.products) {
    if (p.status !== 'active') continue;
    for (const v of p.variants) {
      if (v.active && v.priceDzd > 0 && (v.stock === null || v.stock > 0)) return v.id;
    }
  }
  return null;
}

const isDzd = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

interface QuoteBody {
  ok?: unknown;
  available?: unknown;
  lines?: { lineTotalDzd?: unknown }[];
  subtotalDzd?: unknown;
  feeDzd?: unknown;
  totalDzd?: unknown;
  code?: unknown;
}

/** Problems with one quote response; 'unavailable' when delivery is not offered to that wilaya. */
export function checkQuote(status: number, body: QuoteBody): string[] | 'unavailable' {
  if (status !== 200) return [`/api/quote returned ${status}, expected 200 (code: ${String(body.code)})`];
  if (body.ok !== true) return ['/api/quote answered 200 without ok: true'];
  if (body.available === false) {
    if (body.feeDzd !== null || body.totalDzd !== null) return ['/api/quote refused delivery but still returned a fee or total'];
    return 'unavailable';
  }
  if (body.available !== true) return ['/api/quote answered 200 with neither available: true nor available: false'];
  const { lines, subtotalDzd, feeDzd, totalDzd } = body;
  if (!isDzd(subtotalDzd) || !isDzd(feeDzd) || !isDzd(totalDzd)) return ['/api/quote totals are not integer DZD amounts'];
  if (!Array.isArray(lines) || lines.length === 0) return ['/api/quote returned no lines'];
  const problems: string[] = [];
  if (subtotalDzd <= 0) problems.push('/api/quote subtotal is not positive');
  const sum = lines.reduce((n, l) => n + (isDzd(l.lineTotalDzd) ? l.lineTotalDzd : NaN), 0);
  if (sum !== subtotalDzd) problems.push(`/api/quote subtotal ${subtotalDzd} differs from the sum of lines ${sum}`);
  if (totalDzd !== subtotalDzd + feeDzd) problems.push(`/api/quote total ${totalDzd} is not subtotal + fee (${subtotalDzd} + ${feeDzd})`);
  return problems;
}

/** POST /api/order with an invalid body must be refused by validation. */
export function checkOrderRefusal(status: number): string[] {
  return status === 400 || status === 422 ? [] : [`/api/order with an invalid body returned ${status}, expected a validation 400 or 422`];
}

/** Without credentials the admin must only ever redirect to Access or refuse. */
export function checkAdmin(status: number, location: string | null): string[] {
  if (status === 401 || status === 403) return [];
  if (status >= 300 && status < 400 && location !== null) {
    let host = '';
    try {
      host = new URL(location).hostname;
    } catch {
      return [`admin redirected to an invalid location: ${location}`];
    }
    if (host.endsWith('.cloudflareaccess.com')) return [];
    return [`admin redirected to ${host}, not a Cloudflare Access login`];
  }
  return [`admin answered ${status} without credentials: it must redirect to Access or return 401/403`];
}

/** All checks once; returns every problem found. */
export async function runSmokeOnce(targets: SmokeTargets, snapshot: SmokeSnapshot | null, get: Fetcher, scope: 'all' | 'site' | 'admin'): Promise<string[]> {
  const problems: string[] = [];
  if (scope === 'admin' || snapshot === null) {
    // Backoffice deployment (D-025): only the admin's front door is checked; the site was not deployed.
    try {
      const r = await get(`${targets.adminOrigin}/`, { headers: { 'User-Agent': UA }, redirect: 'manual' });
      problems.push(...checkAdmin(r.status, r.headers.get('location')));
    } catch (err) {
      problems.push(`admin: ${err instanceof Error ? err.message : String(err)}`);
    }
    return problems;
  }
  const attempt = async (label: string, f: () => Promise<void>): Promise<void> => {
    try {
      await f();
    } catch (err) {
      problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const headers = { 'User-Agent': UA };
  const json = { ...headers, 'Content-Type': 'application/json' };

  for (const l of ['ar', 'fr'] as const) {
    await attempt(`/${l}/`, async () => {
      const r = await get(`${targets.siteOrigin}/${l}/`, { headers, redirect: 'manual' });
      problems.push(...checkStorefront(l, r.status, await r.text(), snapshot));
    });
  }

  await attempt('/api/quote', async () => {
    const variantId = sellableVariant(snapshot);
    if (variantId === null) {
      problems.push('the published catalogue has no sellable variant to quote');
      return;
    }
    const quote = async (wilayaCode: number): Promise<string[] | 'unavailable'> => {
      const r = await get(`${targets.siteOrigin}/api/quote`, {
        method: 'POST',
        headers: json,
        redirect: 'manual',
        body: JSON.stringify({ items: [{ variantId, qty: 1 }], wilayaCode }),
      });
      return checkQuote(r.status, (await r.json().catch(() => ({}))) as QuoteBody);
    };
    for (const wilayaCode of snapshot.quoteWilayas) {
      const result = await quote(wilayaCode);
      if (result === 'unavailable') problems.push(`/api/quote: wilaya ${wilayaCode} has a confirmed fee in production but delivery is not offered`);
      else problems.push(...result);
    }
    if (snapshot.refusedWilaya === null) {
      if (snapshot.quoteWilayas.length === 0) problems.push('/api/quote: production has neither a confirmed fee nor a wilaya to check the refusal on');
      return;
    }
    const refused = await quote(snapshot.refusedWilaya);
    if (refused === 'unavailable') return;
    problems.push(...refused);
    if (refused.length === 0) problems.push(`/api/quote offered delivery to wilaya ${snapshot.refusedWilaya}, which has no confirmed fee in production: an unconfirmed fee is being quoted`);
  });

  await attempt('/api/order', async () => {
    const r = await get(`${targets.siteOrigin}/api/order`, { method: 'POST', headers: json, redirect: 'manual', body: '{}' });
    problems.push(...checkOrderRefusal(r.status));
  });

  if (scope === 'all') {
    await attempt('admin', async () => {
      const r = await get(`${targets.adminOrigin}/`, { headers, redirect: 'manual' });
      problems.push(...checkAdmin(r.status, r.headers.get('location')));
    });
  }
  return problems;
}

/** Repeats the checks until they pass or the attempts run out (new versions take a moment to reach every colo). */
export async function runSmoke(
  targets: SmokeTargets,
  snapshot: SmokeSnapshot | null,
  get: Fetcher,
  scope: 'all' | 'site' | 'admin',
  opts: { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void>; log: (line: string) => void },
): Promise<string[]> {
  let problems: string[] = [];
  for (let n = 1; n <= opts.attempts; n++) {
    problems = await runSmokeOnce(targets, snapshot, get, scope);
    if (problems.length === 0) return [];
    opts.log(`smoke attempt ${n}/${opts.attempts} failed: ${problems.join('; ')}`);
    if (n < opts.attempts) await opts.sleep(opts.delayMs);
  }
  return problems;
}
