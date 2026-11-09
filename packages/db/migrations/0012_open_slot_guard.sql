-- SHIP-1 (SHIP-0 contract, §1 "open-slot guard"). Hand-written (drizzle-kit --custom).
-- A parcel slot is open while a shipment for the order is reserved, sending, draft or uncertain, or
-- accepted but not yet applied to the order. While it is open the order must not leave `confirmed`,
-- and what the courier was told (destination, recipient, amounts) must not change: otherwise the
-- parcel collects one amount and the order says another. `IS NOT` so a NULL address is covered and a
-- no-op update passes. The accept batch closes the slot (applied_at) before it moves the order.
-- The abort rolls back the whole D1 batch; @hb/db maps the message to a refusal.
CREATE TRIGGER `orders_open_slot_status` BEFORE UPDATE OF `status` ON `orders`
WHEN OLD.`status` = 'confirmed' AND NEW.`status` IS NOT OLD.`status` AND EXISTS (
  SELECT 1 FROM `shipments` s WHERE s.`order_id` = NEW.`id`
    AND (s.`state` IN ('reserved', 'sending', 'draft', 'uncertain') OR (s.`state` = 'accepted' AND s.`applied_at` IS NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'shipment_in_progress');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_open_slot_contact` BEFORE UPDATE OF `wilaya_code`, `commune_id`, `fee_dzd`, `total_dzd`, `phone_e164`, `name`, `address` ON `orders`
WHEN (
  OLD.`wilaya_code` IS NOT NEW.`wilaya_code` OR OLD.`commune_id` IS NOT NEW.`commune_id`
  OR OLD.`fee_dzd` IS NOT NEW.`fee_dzd` OR OLD.`total_dzd` IS NOT NEW.`total_dzd`
  OR OLD.`phone_e164` IS NOT NEW.`phone_e164` OR OLD.`name` IS NOT NEW.`name`
  OR OLD.`address` IS NOT NEW.`address`
) AND EXISTS (
  SELECT 1 FROM `shipments` s WHERE s.`order_id` = NEW.`id`
    AND (s.`state` IN ('reserved', 'sending', 'draft', 'uncertain') OR (s.`state` = 'accepted' AND s.`applied_at` IS NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'shipment_in_progress');
END;
--> statement-breakpoint
-- SHEET-0: the singleton connection row, so the job and the admin only ever use conditional UPDATEs.
INSERT INTO `sheets_connection` (`id`, `status`, `generation`, `failure_count`, `updated_at`)
VALUES (1, 'disconnected', 1, 0, cast(unixepoch('subsec') * 1000 as integer));
