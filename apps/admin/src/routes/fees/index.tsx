// /fees (ACAT-4, H): delivery fee per wilaya. Owner: admin-catalog. Plan: artifacts/ACAT-4/plan.md.
//
// GET  /           69 wilayas (fees.view: owner edits, confirmer/logistics read); ?sel=all|notset|placeholder pre-ticks rows
// POST /preview    validate + diff, nothing written (fees.edit = owner; noAudit)
// POST /apply      re-validate + one D1 batch: version guards, writes, one `fee.update` audit row per wilaya
// GET  /quote      quote simulator through @hb/db/fees (the provider /api/quote and /api/order use)
//
// Placeholder fees (seeded, invented) are unavailable outside development and are confirmed only
// by an explicit tick. Existing orders keep the fee they were placed with.
import type { Context } from 'hono';
import * as v from 'valibot';
import { createAdminTableFeeProvider } from '@hb/db/fees';
import { computeTotals, createStaticFeeProvider, MAX_QTY_PER_LINE, type FeeProvider } from '@hb/shared';
import { noAudit } from '../../audit/audit.ts';
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { readForm, validateForm, vCheckbox, vOptionalInt, vOptionalMoneyDzd, vOptionalText } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { withFlash } from '../../ui/flash.tsx';
import { isGuardAbort } from '../products/lib/guard.ts';
import { loadPickable } from '../products/pack.tsx';
import { applyBulk, diffFees, FEE_MAX, parseRange, WILAYA_MAX, WILAYA_MIN, type Change, type ProposedRow } from './core.ts';
import { currentMap, loadFeeTable, applyFees, type FeeTableRow } from './data.ts';
import { m } from './messages.ts';
import { FeeForm, FeeTableReadonly, Notes, PreviewPage, QuotePage, type SampleQuote } from './views.tsx';

type Ctx = Context<AppEnv>;

const r = createRouter({ roles: rolesFor('fees.view') });

const CODES = Array.from({ length: WILAYA_MAX - WILAYA_MIN + 1 }, (_, i) => WILAYA_MIN + i);
const optionalInt = (min: number, max: number) => v.optional(vOptionalInt(min, max), '');

const FeeSchema = (() => {
  const e: Record<string, v.GenericSchema<unknown, unknown>> = {
    range: v.optional(vOptionalText(200), ''),
    bulk_fee: vOptionalMoneyDzd(FEE_MAX),
    bulk_avail: v.optional(v.picklist(['', 'on', 'off']), ''),
    bulk_confirm: vCheckbox(),
  };
  for (const code of CODES) {
    e[`fee_${code}`] = vOptionalMoneyDzd(FEE_MAX);
    e[`avail_${code}`] = vCheckbox();
    e[`confirm_${code}`] = vCheckbox();
    e[`sel_${code}`] = vCheckbox();
    e[`v_${code}`] = optionalInt(0, Number.MAX_SAFE_INTEGER);
  }
  return v.strictObject(e);
})();

/** Form values for the table as it is in D1 (what the edit form starts from). */
function valuesOf(table: readonly FeeTableRow[], sel: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of table) {
    out[`v_${row.code}`] = String(row.fee?.version ?? 0);
    if (row.fee !== null) {
      out[`fee_${row.code}`] = String(row.fee.feeDzd);
      if (row.fee.available) out[`avail_${row.code}`] = '1';
    }
    const pick = sel === 'all' || (sel === 'notset' && row.fee === null) || (sel === 'placeholder' && row.fee?.placeholder === true);
    if (pick) out[`sel_${row.code}`] = '1';
  }
  return out;
}

const devPlaceholders = (c: Ctx) => c.env.ENV === 'development';

async function renderTable(c: Ctx, table: readonly FeeTableRow[], values?: Record<string, string>, errors?: Record<string, string>) {
  const tm = m(c.var.lang);
  const placeholders = table.filter((row) => row.fee?.placeholder).length;
  const body = can(c.var.user, 'fees.edit') ? (
    <FeeForm rows={table} values={values ?? valuesOf(table, c.req.query('sel'))} errors={errors} />
  ) : (
    <FeeTableReadonly rows={table} />
  );
  return c.render(
    <>
      <Notes placeholders={placeholders} />
      {body}
    </>,
    { title: tm('title'), actions: <a class="btn btn--secondary" href="/fees/quote">{tm('quote.title')}</a> },
  );
}

type Planned = { ok: true; changes: Change[]; hidden: Record<string, string> } | { ok: false; errors: Record<string, string> };

/** Parses the form, applies the bulk bar and diffs against D1 (shared by preview and apply). */
function plan(c: Ctx, table: readonly FeeTableRow[], values: Record<string, string>): Planned {
  const tm = m(c.var.lang);
  const f = validateForm(c, FeeSchema, values);
  if (!f.ok) return { ok: false, errors: f.errors };
  const d = f.data as Record<string, unknown>;
  const range = parseRange((d['range'] as string | null) ?? '');
  if (range === null) return { ok: false, errors: { range: tm('err.range') } };
  const rows: ProposedRow[] = CODES.map((code) => ({
    code,
    feeDzd: (d[`fee_${code}`] ?? null) as number | null,
    available: d[`avail_${code}`] === true,
    confirm: d[`confirm_${code}`] === true,
    version: (d[`v_${code}`] ?? 0) as number,
  }));
  const selected = new Set([...range, ...CODES.filter((code) => d[`sel_${code}`] === true)]);
  const bulkAvail = d['bulk_avail'] === 'on' ? true : d['bulk_avail'] === 'off' ? false : null;
  const bulk = { codes: selected, feeDzd: (d['bulk_fee'] ?? null) as number | null, available: bulkAvail, confirm: d['bulk_confirm'] === true };
  const proposed = applyBulk(rows, bulk.feeDzd === null && bulk.available === null && !bulk.confirm ? null : bulk);
  // Versions must match what is in D1 now (the guards check again inside the batch).
  const current = currentMap(table);
  for (const p of proposed) {
    if (p.version !== (current.get(p.code)?.version ?? 0)) return { ok: false, errors: { _form: tm('err.stale') } };
  }
  const diff = diffFees(current, proposed);
  if (!diff.ok) return { ok: false, errors: Object.fromEntries([...diff.errors].map(([code]) => [`fee_${code}`, tm('err.fee_required')])) };
  // The apply form carries the final (post-bulk) table, so it re-validates the same values.
  const hidden: Record<string, string> = {};
  for (const p of proposed) {
    hidden[`v_${p.code}`] = String(p.version);
    if (p.feeDzd !== null) hidden[`fee_${p.code}`] = String(p.feeDzd);
    if (p.available) hidden[`avail_${p.code}`] = '1';
    if (p.confirm) hidden[`confirm_${p.code}`] = '1';
  }
  return { ok: true, changes: diff.changes, hidden };
}

async function sampleQuote(c: Ctx, table: readonly FeeTableRow[], changes: readonly Change[]): Promise<SampleQuote | null> {
  const ch = changes[0];
  const item = (await loadPickable(c))[0];
  if (ch === undefined || item === undefined) return null;
  const req = { wilayaCode: ch.code, items: [{ variantId: item.variantId, qty: 1, weightG: null, unitPriceDzd: item.priceDzd }] };
  const now = await createAdminTableFeeProvider(c.var.db, { allowPlaceholderFees: devPlaceholders(c) }).quote(req);
  const afterFee = ch.after.available && (!ch.after.placeholder || devPlaceholders(c)) ? ch.after.feeDzd : null;
  const after = await createStaticFeeProvider({ [ch.code]: afterFee }).quote(req);
  const total = (fee: number | null) => (fee === null ? null : computeTotals([{ unitPriceDzd: item.priceDzd, qty: 1 }], fee).totalDzd);
  const w = table.find((row) => row.code === ch.code);
  return {
    wilaya: w ? (c.var.lang === 'ar' ? w.nameAr : w.nameFr) : String(ch.code),
    product: c.var.lang === 'ar' ? item.productNameAr : item.productNameFr,
    now: { feeDzd: now.feeDzd, totalDzd: total(now.feeDzd) },
    after: { feeDzd: after.feeDzd, totalDzd: total(after.feeDzd) },
  };
}

// ---------------------------------------------------------------------------------------------

r.get('/', requirePerm('fees.view'), async (c) => renderTable(c, await loadFeeTable(c)));

r.post('/preview', requirePerm('fees.edit'), async (c) => {
  noAudit(c, 'fee preview: validation and diff only, nothing written');
  const table = await loadFeeTable(c);
  const values = await readForm(c);
  const p = plan(c, table, values);
  if (!p.ok) {
    c.status(p.errors['_form'] ? 409 : 422);
    return renderTable(c, table, values, p.errors);
  }
  const names = new Map(table.map((row) => [row.code, row]));
  return c.render(<PreviewPage changes={p.changes} names={names} hidden={p.hidden} sample={await sampleQuote(c, table, p.changes)} />, {
    title: m(c.var.lang)('preview.title'),
    breadcrumbs: [{ label: m(c.var.lang)('title'), href: '/fees' }],
  });
});

r.post('/apply', requirePerm('fees.edit'), async (c) => {
  const tm = m(c.var.lang);
  const table = await loadFeeTable(c);
  const values = await readForm(c);
  const p = plan(c, table, values);
  if (!p.ok) {
    c.status(p.errors['_form'] ? 409 : 422);
    return renderTable(c, table, values, p.errors);
  }
  if (p.changes.length === 0) {
    noAudit(c, 'fee apply without changes: nothing written');
    return c.redirect('/fees', 303);
  }
  try {
    await applyFees(c, p.changes);
  } catch (err) {
    if (!isGuardAbort(err)) throw err;
    c.status(409);
    return renderTable(c, await loadFeeTable(c), undefined, { _form: tm('err.stale') });
  }
  return c.redirect(withFlash('/fees', 'saved'), 303);
});

r.get('/quote', requirePerm('fees.view'), async (c) => {
  const table = await loadFeeTable(c);
  const pickable = await loadPickable(c);
  const lang = c.var.lang;
  const variants = pickable.map((x) => ({ value: String(x.variantId), label: `${lang === 'ar' ? x.productNameAr : x.productNameFr}${(lang === 'ar' ? x.labelAr : x.labelFr) ? ` — ${lang === 'ar' ? x.labelAr : x.labelFr}` : ''} (${x.sku})` }));
  const wilayaOptions = table.map((row) => ({ value: String(row.code), label: `${row.code} — ${lang === 'ar' ? row.nameAr : row.nameFr}` }));
  const q = { variant: c.req.query('variant') ?? '', qty: c.req.query('qty') ?? '1', wilaya: c.req.query('wilaya') ?? '' };
  let result: Parameters<typeof QuotePage>[0]['result'] = null;
  const item = pickable.find((x) => String(x.variantId) === q.variant);
  const qty = /^\d{1,2}$/.test(q.qty) ? Math.min(Math.max(Number(q.qty), 1), MAX_QTY_PER_LINE) : 1;
  const wilayaCode = /^\d{1,2}$/.test(q.wilaya) ? Number(q.wilaya) : null;
  if (item !== undefined && wilayaCode !== null && wilayaCode >= WILAYA_MIN && wilayaCode <= WILAYA_MAX) {
    const provider: FeeProvider = createAdminTableFeeProvider(c.var.db, { allowPlaceholderFees: devPlaceholders(c) });
    const quote = await provider.quote({ wilayaCode, items: [{ variantId: item.variantId, qty, weightG: null, unitPriceDzd: item.priceDzd }] });
    const subtotal = item.priceDzd * qty;
    result = quote.available
      ? { available: true, subtotalDzd: subtotal, feeDzd: quote.feeDzd, totalDzd: computeTotals([{ unitPriceDzd: item.priceDzd, qty }], quote.feeDzd).totalDzd, source: quote.source }
      : { available: false, subtotalDzd: subtotal, feeDzd: null, totalDzd: null, source: quote.source };
  }
  return c.render(<QuotePage variants={variants} wilayas={wilayaOptions} values={{ ...q, qty: String(qty) }} result={result} />, {
    title: m(lang)('quote.title'),
    breadcrumbs: [{ label: m(lang)('title'), href: '/fees' }],
  });
});

export default r;
