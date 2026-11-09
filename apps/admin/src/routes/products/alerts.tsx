// UX-9 — low-stock alerts: variants on sale at or below the store's threshold (settings
// `lowStockThreshold`, the dashboard tile's number), out of stock first, then the ones that sell
// most. Each row shows how much was ordered in the last 30 days and roughly how long the stock
// lasts, with the stock screen's own "set" form (POST /products/stock/set, which comes back here).
//
// GET /products/stock/alerts   stock.edit (owner, logistics, content), like the stock screen
import { and, asc, desc, eq, isNotNull, lte, ne, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { products, variants } from '@hb/db';
import { requirePerm } from '../../auth/require-role.ts';
import { can } from '../../auth/permissions.ts';
import type { AppEnv } from '../../env.ts';
import { DEFAULT_PAGE_SIZE, offsetOf, pageCount, parsePage } from '../../lib/pagination.ts';
import { EmptyState, StatusBadge } from '../../ui/badge.tsx';
import { useUi } from '../../ui/context.ts';
import { Form, NumberInput, Submit } from '../../ui/form.tsx';
import { Code, Num } from '../../ui/format.tsx';
import { Stats } from '../../ui/kit.tsx';
import { Pagination } from '../../ui/pagination.tsx';
import { Table } from '../../ui/table.tsx';
import { lowStockThreshold } from '../dashboard/data.ts';
import { m } from './messages.ts';
import { labelSql, withSku } from './stock.tsx';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SALES_WINDOW_DAYS = 30;

export interface AlertRow {
  variantId: number;
  productId: number;
  productNameFr: string;
  productNameAr: string;
  sku: string;
  stock: number;
  labelFr: string | null;
  labelAr: string | null;
  sold: number;
}

/** Same set as the dashboard's lowStockCount: active variant, tracked, stock ≤ threshold; not archived. */
const alertWhere = (threshold: number) =>
  and(eq(variants.active, true), isNotNull(variants.stock), lte(variants.stock, threshold), ne(products.status, 'archived'));

export async function stockAlerts(c: Context<AppEnv>, threshold: number, page: number, now: number) {
  const db = c.var.db;
  const since = now - SALES_WINDOW_DAYS * DAY_MS;
  // Units ordered in the window, from orders that were not cancelled (index order_items_variant_idx).
  const sold = sql<number>`(select coalesce(sum(oi.qty), 0) from order_items oi join orders o on o.id = oi.order_id
    where oi.variant_id = ${variants.id} and o.created_at >= ${since} and o.status <> 'cancelled')`.mapWith(Number);
  const where = alertWhere(threshold);
  const [rows, totals] = await Promise.all([
    db
      .select({
        variantId: variants.id,
        productId: products.id,
        productNameFr: products.nameFr,
        productNameAr: products.nameAr,
        sku: variants.sku,
        stock: sql<number>`${variants.stock}`.mapWith(Number),
        labelFr: labelSql('fr'),
        labelAr: labelSql('ar'),
        sold,
      })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(where)
      .orderBy(asc(variants.stock), desc(sold), asc(products.nameFr), asc(variants.id))
      .limit(DEFAULT_PAGE_SIZE)
      .offset(offsetOf(page)),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number), out: sql<number>`sum(case when ${variants.stock} = 0 then 1 else 0 end)`.mapWith(Number) })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(where),
  ]);
  return { rows: rows as AlertRow[], total: totals[0]?.n ?? 0, out: totals[0]?.out ?? 0 };
}

/** Whole days the stock lasts at the window's pace; null without sales. */
export function daysLeft(stock: number, sold: number): number | null {
  if (sold <= 0) return null;
  return Math.floor(stock / (sold / SALES_WINDOW_DAYS));
}

function AlertsPage(props: { rows: readonly AlertRow[]; total: number; out: number; threshold: number; page: number; pages: number; canSettings: boolean }) {
  const { lang } = useUi();
  const tm = m(lang);
  const back = props.page > 1 ? `/products/stock/alerts?page=${props.page}` : '/products/stock/alerts';
  const name = (r: AlertRow) => {
    const n = lang === 'ar' ? r.productNameAr : r.productNameFr;
    const v = lang === 'ar' ? r.labelAr : r.labelFr;
    return v ? `${n} — ${v}` : n;
  };
  return (
    <>
      <p class="page-lead">{tm('alerts.lead', { threshold: props.threshold })}</p>
      {props.total === 0 ? (
        <EmptyState
          icon="check"
          title={tm('alerts.empty.title')}
          action={<a class="btn btn--secondary" href="/products/stock">{tm('alerts.allStock')}</a>}
        >
          {tm('alerts.empty', { threshold: props.threshold })}
        </EmptyState>
      ) : (
        <>
          <Stats
            items={[
              { label: tm('alerts.out'), value: <Num value={props.out} /> },
              { label: tm('alerts.low'), value: <Num value={props.total - props.out} /> },
            ]}
          />
          <Table
            stack
            caption={tm('alerts.caption')}
            rows={props.rows}
            rowKey={(r) => r.variantId}
            columns={[
              {
                key: 'product',
                header: tm('alerts.col.product'),
                cell: (r) => (
                  <>
                    <a href={`/products/${r.productId}`}>{name(r)}</a>
                    <span class="cell-sub"><Code>{r.sku}</Code></span>
                  </>
                ),
              },
              {
                key: 'stock',
                header: tm('alerts.col.stock'),
                cell: (r) => (
                  <span class="stock-cell">
                    <Num value={r.stock} />
                    <StatusBadge tone={r.stock === 0 ? 'danger' : 'warning'} label={r.stock === 0 ? tm('alerts.out') : tm('alerts.low')} />
                  </span>
                ),
              },
              { key: 'sold', header: tm('alerts.col.sold'), numeric: true, cell: (r) => <Num value={r.sold} /> },
              {
                key: 'left',
                header: tm('alerts.col.left'),
                cell: (r) => {
                  if (r.stock === 0) return <span class="muted">—</span>;
                  const d = daysLeft(r.stock, r.sold);
                  if (d === null) return <span class="muted">{tm('alerts.noSales')}</span>;
                  return d < 1 ? <strong class="delay">{tm('alerts.lessThanDay')}</strong> : tm('alerts.daysLeft', { days: d });
                },
              },
              {
                key: 'set',
                header: tm('alerts.col.set'),
                cell: (r) => (
                  <Form action="/products/stock/set" class="inline-set">
                    <input type="hidden" name="variant_id" value={String(r.variantId)} />
                    <input type="hidden" name="was" value={String(r.stock)} />
                    <input type="hidden" name="back" value={back} />
                    <NumberInput name="stock" idSuffix={r.variantId} label={withSku(tm('stock.set'), r.sku)} value={String(r.stock)} />
                    <Submit variant="secondary">{tm('stock.setButton')}</Submit>
                  </Form>
                ),
              },
            ]}
          />
          <Pagination page={props.page} pages={props.pages} baseUrl="/products/stock/alerts" />
        </>
      )}
      <p class="list-note">
        <a href="/products/stock">{tm('alerts.allStock')}</a>
        {props.canSettings ? <> · <a href="/settings#f-lowStockThreshold">{tm('alerts.settings')}</a></> : null}
      </p>
    </>
  );
}

export function mountStockAlertRoutes(r: Hono<AppEnv>): void {
  r.get('/stock/alerts', requirePerm('stock.edit'), async (c) => {
    const tm = m(c.var.lang);
    const threshold = await lowStockThreshold(c.var.db);
    const page = parsePage(c);
    const { rows, total, out } = await stockAlerts(c, threshold, page, Date.now());
    return c.render(
      <AlertsPage rows={rows} total={total} out={out} threshold={threshold} page={page} pages={pageCount(total)} canSettings={can(c.var.user, 'settings.edit')} />,
      { title: tm('alerts.title'), breadcrumbs: [{ label: tm('title'), href: '/products' }, { label: tm('stock.title'), href: '/products/stock' }] },
    );
  });
}
