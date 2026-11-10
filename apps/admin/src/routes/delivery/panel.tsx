// The shipment panel for the order page (placed by adminui). D1 only: never calls a courier.
import { and, desc, eq } from 'drizzle-orm';
import { getCourier } from '@hb/couriers';
import { deliveryExceptions, shipmentEvents, shipments, type Db, type Shipment, type ShipmentEvent } from '@hb/db';
import type { Lang } from '../../i18n/index.ts';
import { can } from '../../auth/permissions.ts';
import type { CurrentUser } from '../../env.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { Bdi, DateTime } from '../../ui/format.tsx';
import { Form, Submit } from '../../ui/form.tsx';
import { sm } from './send-messages.ts';

export interface ShipmentPanelData {
  shipment: Shipment;
  events: ShipmentEvent[];
  openExceptions: number;
}

/** Latest shipment of the order, its last events and open exceptions; null if never sent. */
export async function fetchShipmentPanel(db: Db, orderId: number): Promise<ShipmentPanelData | null> {
  const shipment = (await db.select().from(shipments).where(eq(shipments.orderId, orderId)).orderBy(desc(shipments.id)).limit(1))[0];
  if (!shipment) return null;
  const [events, open] = await Promise.all([
    db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipment.id)).orderBy(desc(shipmentEvents.id)).limit(10),
    db.select({ id: deliveryExceptions.id }).from(deliveryExceptions).where(and(eq(deliveryExceptions.shipmentId, shipment.id), eq(deliveryExceptions.state, 'open'))),
  ]);
  return { shipment, events, openExceptions: open.length };
}

const STATE_TONE: Record<Shipment['state'], Tone> = { reserved: 'info', sending: 'info', draft: 'warning', accepted: 'success', uncertain: 'warning', failed: 'danger' };

export function ShipmentPanel(props: { lang: Lang; user: Pick<CurrentUser, 'role'>; data: ShipmentPanelData | null; now: number }) {
  const tm = sm(props.lang);
  const data = props.data;
  return (
    <section class="card" id="shipment" aria-labelledby="shipment-title">
      <div class="card__head">
        <h2 class="card__title" id="shipment-title">{tm('panel.title')}</h2>
      </div>
      <div class="card__body">
      {data === null ? (
        <p class="muted">{tm('panel.none')}</p>
      ) : (
        <>
          <dl class="details">
            <dt>{tm('panel.state')}</dt>
            <dd><StatusBadge tone={STATE_TONE[data.shipment.state]} label={tm(`state.${data.shipment.state}`)} /></dd>
            <dt>{tm('panel.courier')}</dt>
            <dd><Bdi>{getCourier(data.shipment.courier)?.displayName ?? data.shipment.courier}</Bdi></dd>
            {data.shipment.tracking ? (
              <>
                <dt>{tm('panel.tracking')}</dt>
                <dd><Bdi ltr>{data.shipment.tracking}</Bdi></dd>
              </>
            ) : null}
            {data.shipment.courierStatus ? (
              <>
                <dt>{tm('panel.courierStatus')}</dt>
                <dd>
                  {tm(`status.${data.shipment.courierStatus}`)} {data.shipment.courierStatusRaw ? <span class="muted" lang="fr" dir="ltr">({data.shipment.courierStatusRaw})</span> : null}
                </dd>
              </>
            ) : null}
          </dl>
          {data.shipment.state === 'draft' && data.shipment.errorCode === 'locked' ? <p class="callout callout--warning">{tm('panel.locked')}</p> : null}
          <div class="actions">
            {data.shipment.tracking ? <a class="btn btn--secondary" href={`/delivery/shipments/${data.shipment.id}/waybill`}>{tm('waybill.open')}</a> : null}
            {data.shipment.state === 'draft' && can(props.user, 'delivery.send') ? (
              <Form action={`/delivery/shipments/${data.shipment.id}/validate`}>
                <Submit variant="secondary">{tm('panel.retryValidate')}</Submit>
              </Form>
            ) : null}
            {data.openExceptions > 0 && can(props.user, 'delivery.view') ? <a class="btn btn--secondary" href="/delivery/exceptions">{tm('panel.exceptions')}</a> : null}
          </div>
          {data.events.length > 0 ? (
            <>
              <h3>{tm('panel.history')}</h3>
              <ul>
                {data.events.map((e) => (
                  <li>
                    <DateTime ms={e.occurredAt ?? e.receivedAt} /> · {tm(`status.${e.mapped}`)} <span class="muted" lang="fr" dir="ltr">({e.rawStatus})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      </div>
    </section>
  );
}
