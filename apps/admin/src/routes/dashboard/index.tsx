// Dashboard (admin-core, ADMIN-5). Tiles per role: artifacts/ADMIN-5/plan.md. Every tile links to
// where the work happens; a tile whose source is missing shows "indisponible" instead of failing.
import { ORDER_STATUSES } from '@hb/shared';
import type { Child } from 'hono/jsx';
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { CurrentUser } from '../../env.ts';
import type { MessageKey, Translator } from '../../i18n/index.ts';
import { createRouter } from '../../lib/router.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Code, DateTime, Num } from '../../ui/format.tsx';
import { Table } from '../../ui/table.tsx';
import {
  backupView,
  dayWindows,
  deadNotifications,
  flaggedOpenCount,
  lastPublish,
  lowStockCount,
  lowStockThreshold,
  ordersByStatus,
  placeholderFeesCount,
  readSetting,
  safeTile,
  toCallCount,
  toShipCount,
  type BackupView,
  type DeadSummary,
  type Tile,
} from './data.ts';
import { DEFAULT_DELAY_DAYS, delayDaysSetting, delayedCount } from '../parcels/data.ts';
import { pm } from '../parcels/messages.ts';

const r = createRouter({ roles: rolesFor('dashboard.view') });

/** Who sees which tile (plan ADMIN-5). Exported for tests. */
export const TILE_ACCESS = {
  orders: (u: Pick<CurrentUser, 'role'>) => can(u, 'orders.view'),
  toCall: (u: Pick<CurrentUser, 'role'>) => can(u, 'orders.queue'),
  flagged: (u: Pick<CurrentUser, 'role'>) => can(u, 'customers.sensitive'),
  toShip: (u: Pick<CurrentUser, 'role'>) => can(u, 'orders.shipping'),
  delayed: (u: Pick<CurrentUser, 'role'>) => can(u, 'delivery.view'),
  lowStock: (u: Pick<CurrentUser, 'role'>) => can(u, 'stock.edit'),
  placeholderFees: (u: Pick<CurrentUser, 'role'>) => can(u, 'fees.edit'),
  backup: (u: Pick<CurrentUser, 'role'>) => u.role === 'owner',
  deadNotifications: (u: Pick<CurrentUser, 'role'>) => u.role === 'owner' || u.role === 'confirmer',
  publish: (u: Pick<CurrentUser, 'role'>) => can(u, 'publish.run'),
} as const;

type TileName = keyof typeof TILE_ACCESS;

function Card(props: { name: TileName; title: string; href?: string; tone?: 'neutral' | 'warning' | 'danger' | 'success'; children: Child }) {
  // The title is the link (never the whole card: tiles may contain their own links).
  return (
    <section class={`tile tile--${props.tone ?? 'neutral'}`} data-tile={props.name}>
      <h2 class="tile__title">{props.href ? <a class="tile__link" href={props.href}>{props.title}</a> : props.title}</h2>
      <div class="tile__body">{props.children}</div>
    </section>
  );
}

function Group(props: { title: string; name: string; children: Child[] }) {
  return (
    <section class="tile-group" aria-labelledby={`dash-${props.name}`}>
      <h2 class="tile-group__title" id={`dash-${props.name}`}>{props.title}</h2>
      <div class={`tiles tiles--${props.name}`}>{props.children}</div>
    </section>
  );
}

function Unavailable(props: { t: Translator }) {
  return <p class="muted">{props.t('dash.unavailable')}</p>;
}

function Big(props: { value: number }) {
  return <p class="tile__value"><Num value={props.value} /></p>;
}

function StatusCounts(props: { t: Translator; counts: Map<string, number> }) {
  const total = [...props.counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return <p class="muted">{props.t('dash.none')}</p>;
  return (
    <>
      <p class="tile__value"><Num value={total} /></p>
      <ul class="tile__list">
        {ORDER_STATUSES.filter((s) => (props.counts.get(s) ?? 0) > 0).map((s) => (
          <li>
            <a href={`/orders?status=${s}`}>{props.t(`dash.status.${s}` as MessageKey)}</a> <Num value={props.counts.get(s) ?? 0} />
          </li>
        ))}
      </ul>
    </>
  );
}

function BackupBody(props: { t: Translator; view: BackupView }) {
  const { t, view } = props;
  if (view.state === 'unavailable') return <Unavailable t={t} />;
  if (view.state === 'never') return <p><StatusBadge tone="danger" label={t('dash.backupNever')} /></p>;
  return (
    <>
      <p class="tile__value">{t('dash.backupAgo', { hours: view.ageHours })}</p>
      <p>{view.state === 'stale' ? <StatusBadge tone="danger" label={t('dash.backupStale')} /> : <StatusBadge tone="success" label={t('dash.backupOk')} />}</p>
      {view.failureStage ? <p>{t('dash.backupFailure', { stage: view.failureStage })}</p> : null}
    </>
  );
}

function DeadBody(props: { t: Translator; dead: DeadSummary }) {
  const { t, dead } = props;
  return (
    <>
      <p class="tile__value"><Num value={dead.orders} /></p>
      {dead.lastAt !== null ? <p>{t('dash.deadLast')} <DateTime ms={dead.lastAt} /></p> : null}
      {dead.orders > 0 ? <p class="muted">{t('dash.deadNotificationsHint')}</p> : null}
      {dead.invalidMessages > 0 ? <p><StatusBadge tone="warning" label={t('dash.notifyInvalid', { count: dead.invalidMessages })} /></p> : null}
    </>
  );
}

r.get('/', requirePerm('dashboard.view'), async (c) => {
  const t = c.var.t;
  const db = c.var.db;
  const user = c.var.user;
  const now = Date.now();
  const show = (name: TileName) => TILE_ACCESS[name](user);
  const skip = <T,>(): Promise<Tile<T> | null> => Promise.resolve(null);
  const { today, week } = dayWindows(now);

  const [ordersToday, orders7d, toCall, flagged, toShip, delayed, lowStock, fees, backup, dead, publish] = await Promise.all([
    show('orders') ? safeTile('ordersToday', () => ordersByStatus(db, today)) : skip<Map<string, number>>(),
    show('orders') ? safeTile('orders7d', () => ordersByStatus(db, week)) : skip<Map<string, number>>(),
    show('toCall') ? safeTile('toCall', () => toCallCount(db, now)) : skip<number>(),
    show('flagged') ? safeTile('flagged', () => flaggedOpenCount(db)) : skip<number>(),
    show('toShip') ? safeTile('toShip', () => toShipCount(db)) : skip<number>(),
    show('delayed')
      ? safeTile('delayed', async () => {
          const days = await delayDaysSetting(db);
          return { days, n: await delayedCount(db, now, days) };
        })
      : skip<{ days: number; n: number }>(),
    show('lowStock')
      ? safeTile('lowStock', async () => {
          const threshold = await lowStockThreshold(db);
          return { threshold, n: await lowStockCount(db, threshold) };
        })
      : skip<{ threshold: number; n: number }>(),
    show('placeholderFees') ? safeTile('placeholderFees', () => placeholderFeesCount(db)) : skip<number>(),
    show('backup') ? safeTile('backup', async () => backupView(await readSetting(db, 'jobs.backup_status'), now)) : skip<BackupView>(),
    show('deadNotifications') ? safeTile('deadNotifications', () => deadNotifications(db)) : skip<DeadSummary>(),
    show('publish') ? safeTile('publish', () => lastPublish(db)) : skip<{ status: string; at: number } | null>(),
  ]);

  const work: Child[] = [];
  const ordersGroup: Child[] = [];
  const health: Child[] = [];
  if (ordersToday) {
    ordersGroup.push(<Card name="orders" title={t('dash.ordersToday')} href="/orders">{ordersToday.ok ? <StatusCounts t={t} counts={ordersToday.value} /> : <Unavailable t={t} />}</Card>);
  }
  if (orders7d) {
    ordersGroup.push(<Card name="orders" title={t('dash.orders7d')} href="/orders">{orders7d.ok ? <StatusCounts t={t} counts={orders7d.value} /> : <Unavailable t={t} />}</Card>);
  }
  if (toCall) {
    work.push(<Card name="toCall" title={t('dash.toCall')} href="/orders/queue" tone={toCall.ok && toCall.value > 0 ? 'warning' : 'neutral'}>{toCall.ok ? <Big value={toCall.value} /> : <Unavailable t={t} />}</Card>);
  }
  if (flagged) {
    work.push(<Card name="flagged" title={t('dash.flagged')} href="/orders?flagged=1" tone={flagged.ok && flagged.value > 0 ? 'warning' : 'neutral'}>{flagged.ok ? <Big value={flagged.value} /> : <Unavailable t={t} />}</Card>);
  }
  if (toShip) {
    work.push(<Card name="toShip" title={t('dash.toShip')} href="/orders/shipping">{toShip.ok ? <Big value={toShip.value} /> : <Unavailable t={t} />}</Card>);
  }
  if (delayed) {
    work.push(
      <Card name="delayed" title={pm(c.var.lang)('delayed.dashTitle', { days: delayed.ok ? delayed.value.days : DEFAULT_DELAY_DAYS })} href="/parcels/delayed" tone={delayed.ok && delayed.value.n > 0 ? 'warning' : 'neutral'}>
        {delayed.ok ? <Big value={delayed.value.n} /> : <Unavailable t={t} />}
      </Card>,
    );
  }
  if (lowStock) {
    work.push(
      <Card name="lowStock" title={t('dash.lowStock', { threshold: lowStock.ok ? lowStock.value.threshold : 3 })} href="/products/stock/alerts" tone={lowStock.ok && lowStock.value.n > 0 ? 'warning' : 'neutral'}>
        {lowStock.ok ? <Big value={lowStock.value.n} /> : <Unavailable t={t} />}
      </Card>,
    );
  }
  if (fees) {
    work.push(
      <Card name="placeholderFees" title={t('dash.placeholderFees')} href="/fees" tone={fees.ok && fees.value > 0 ? 'warning' : 'neutral'}>
        {fees.ok ? (
          <>
            <Big value={fees.value} />
            {fees.value > 0 ? <p class="muted">{t('dash.placeholderFeesHint')}</p> : null}
          </>
        ) : (
          <Unavailable t={t} />
        )}
      </Card>,
    );
  }
  if (backup) {
    const tone = !backup.ok || backup.value.state === 'never' || backup.value.state === 'stale' || backup.value.state === 'unavailable' ? 'danger' : 'success';
    health.push(<Card name="backup" title={t('dash.backup')} tone={tone}>{backup.ok ? <BackupBody t={t} view={backup.value} /> : <Unavailable t={t} />}</Card>);
  }
  if (dead) {
    health.push(
      <Card name="deadNotifications" title={t('dash.deadNotifications')} href="/orders" tone={dead.ok && (dead.value.orders > 0 || dead.value.invalidMessages > 0) ? 'danger' : 'neutral'}>
        {dead.ok ? <DeadBody t={t} dead={dead.value} /> : <Unavailable t={t} />}
      </Card>,
    );
  }
  if (publish) {
    health.push(
      <Card name="publish" title={t('dash.lastPublish')} href="/publish" tone={publish.ok && publish.value?.status === 'failed' ? 'danger' : 'neutral'}>
        {!publish.ok ? (
          <Unavailable t={t} />
        ) : publish.value === null ? (
          <p class="muted">{t('dash.publishNever')}</p>
        ) : (
          <>
            <p class="tile__value">{t(`dash.publish.${publish.value.status}` as MessageKey)}</p>
            <p><DateTime ms={publish.value.at} /></p>
          </>
        )}
      </Card>,
    );
  }

  const deadList = dead?.ok && dead.value.recent.length > 0 ? dead.value.recent : null;
  return c.render(
    <>
      {work.length > 0 ? <Group title={t('dash.group.work')} name="work">{work}</Group> : null}
      {ordersGroup.length > 0 ? <Group title={t('dash.group.orders')} name="orders">{ordersGroup}</Group> : null}
      {health.length > 0 ? <Group title={t('dash.group.health')} name="health">{health}</Group> : null}
      {deadList ? (
        <Table
          caption={t('dash.deadList')}
          stack
          rows={deadList}
          rowKey={(d) => `${d.ref}-${d.channel}-${d.deadAt ?? 0}`}
          columns={[
            { key: 'ref', header: t('dash.col.ref'), cell: (d) => <Code>{d.ref}</Code> },
            { key: 'channel', header: t('dash.col.channel'), cell: (d) => <Code>{d.channel}</Code> },
            { key: 'error', header: t('dash.col.error'), cell: (d) => (d.lastError ? <Code>{d.lastError}</Code> : t('common.none')) },
            { key: 'at', header: t('dash.col.at'), cell: (d) => (d.deadAt !== null ? <DateTime ms={d.deadAt} /> : t('common.none')) },
          ]}
        />
      ) : null}
    </>,
    { title: t('nav.dashboard') },
  );
});

export default r;
