// Parcel follow-up (adminui). Mounted at /parcels by app.ts. Read-only pages:
//
//   GET /delayed       UX-8: parcels with no courier update for N days (?days=1..30, ?courier=<id>)
//   GET /performance   UX-10: delivery success rate by courier and by wilaya (?period=30|90|365, ?courier=<key>)
//
// Delivery fields only; gate delivery.view (owner, confirmer, logistics).
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { createRouter } from '../../lib/router.ts';
import {
  DEFAULT_PERIOD,
  PERIODS,
  delayDaysSetting,
  delayedParcels,
  followedCouriers,
  isDelayDays,
  ratesByCourier,
  ratesByWilaya,
  type Period,
} from './data.ts';
import { DelayedPage, PerformancePage } from './pages.tsx';
import { pm } from './messages.ts';

const r = createRouter({ roles: rolesFor('delivery.view') });
const DAY_MS = 24 * 60 * 60 * 1000;

r.get('/', requirePerm('delivery.view'), (c) => c.redirect('/parcels/delayed', 302));

r.get('/delayed', requirePerm('delivery.view'), async (c) => {
  const db = c.var.db;
  const now = Date.now();
  const [defaultDays, couriers] = await Promise.all([delayDaysSetting(db), followedCouriers(db)]);
  const rawDays = c.req.query('days') ?? '';
  const asked = /^\d{1,2}$/.test(rawDays) ? Number(rawDays) : NaN;
  const days = isDelayDays(asked) ? asked : defaultDays;
  const rawCourier = c.req.query('courier') ?? '';
  // Only a courier that has followed parcels: anything else is dropped (shows every courier).
  const courier = couriers.includes(rawCourier) ? rawCourier : null;
  const { rows, total } = await delayedParcels(db, now, days, courier);
  return c.render(
    <DelayedPage lang={c.var.lang} now={now} days={days} defaultDays={defaultDays} courier={courier} couriers={couriers} rows={rows} total={total} canConfigure={can(c.var.user, 'delivery.settings')} />,
    { title: pm(c.var.lang)('delayed.title') },
  );
});

r.get('/performance', requirePerm('delivery.view'), async (c) => {
  const db = c.var.db;
  const rawPeriod = Number(c.req.query('period') ?? '');
  const period: Period = (PERIODS as readonly number[]).includes(rawPeriod) ? (rawPeriod as Period) : DEFAULT_PERIOD;
  const since = Date.now() - period * DAY_MS;
  const byCourier = await ratesByCourier(db, since);
  const rawCourier = c.req.query('courier');
  const courier = rawCourier !== undefined && byCourier.some((x) => x.key === rawCourier) ? rawCourier : null;
  const byWilaya = await ratesByWilaya(db, since, courier);
  return c.render(<PerformancePage lang={c.var.lang} period={period} courier={courier} byCourier={byCourier} byWilaya={byWilaya} />, {
    title: pm(c.var.lang)('perf.title'),
  });
});

export default r;
