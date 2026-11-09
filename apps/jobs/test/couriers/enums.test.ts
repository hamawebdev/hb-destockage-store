// @hb/db cannot depend on @hb/couriers, so it keeps its own copy of the status list. They must match.
import { SHIPMENT_COURIER_STATUSES } from '@hb/db';
import { COURIER_STATUSES } from '@hb/couriers';
import { expect, test } from 'vitest';

test('the database status list equals the courier status list', () => {
  expect([...SHIPMENT_COURIER_STATUSES]).toEqual([...COURIER_STATUSES]);
});
