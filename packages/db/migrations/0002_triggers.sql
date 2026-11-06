-- DB-2 triggers: (1) append-only tables, (2) commune-in-wilaya, (3) order ref format, (4) storage types.
-- (1) audit_log and order_events are append-only, enforced in SQL (BRIEF §2).
-- UPDATE and DELETE abort. ON CONFLICT DO UPDATE (upsert) fires the UPDATE trigger and aborts.
-- INSERT OR REPLACE deletes the conflicting row WITHOUT firing DELETE triggers (recursive_triggers
-- is off in SQLite and D1), so a BEFORE INSERT trigger refuses any insert whose id already exists.
-- Hand-written (drizzle-kit --custom); Drizzle has no trigger DSL.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_replace` BEFORE INSERT ON `audit_log`
WHEN NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM `audit_log` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `order_events_no_update` BEFORE UPDATE ON `order_events`
BEGIN
  SELECT RAISE(ABORT, 'order_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `order_events_no_delete` BEFORE DELETE ON `order_events`
BEGIN
  SELECT RAISE(ABORT, 'order_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `order_events_no_replace` BEFORE INSERT ON `order_events`
WHEN NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM `order_events` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'order_events is append-only');
END;
--> statement-breakpoint
-- An order's commune must belong to its wilaya (SQLite cannot add a composite FK without a table
-- rebuild). Enforced on insert and on any change of either column.
CREATE TRIGGER `orders_commune_in_wilaya_ins` BEFORE INSERT ON `orders`
WHEN NOT EXISTS (SELECT 1 FROM `communes` WHERE `id` = NEW.`commune_id` AND `wilaya_code` = NEW.`wilaya_code`)
BEGIN
  SELECT RAISE(ABORT, 'orders.commune_id is not in orders.wilaya_code');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_commune_in_wilaya_upd` BEFORE UPDATE OF `commune_id`, `wilaya_code` ON `orders`
WHEN NOT EXISTS (SELECT 1 FROM `communes` WHERE `id` = NEW.`commune_id` AND `wilaya_code` = NEW.`wilaya_code`)
BEGIN
  SELECT RAISE(ABORT, 'orders.commune_id is not in orders.wilaya_code');
END;
--> statement-breakpoint
-- orders.ref matches @hb/shared ORDER_REF_RE /^HB-[0-9A-HJKMNP-TV-Z]{5}$/ (Crockford base32, no I L O U).
-- D1 caps LIKE/GLOB pattern length (~50 bytes; a longer pattern fails with "LIKE or GLOB pattern too
-- complex", which better-sqlite3 does not reproduce), hence a negated class instead of 5 classes.
CREATE TRIGGER `orders_ref_format_ins` BEFORE INSERT ON `orders`
WHEN NOT (length(NEW.`ref`) = 8 AND substr(NEW.`ref`, 1, 3) = 'HB-' AND substr(NEW.`ref`, 4) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
BEGIN
  SELECT RAISE(ABORT, 'orders.ref must match HB-XXXXX (Crockford base32)');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_ref_format_upd` BEFORE UPDATE OF `ref` ON `orders`
WHEN NOT (length(NEW.`ref`) = 8 AND substr(NEW.`ref`, 1, 3) = 'HB-' AND substr(NEW.`ref`, 4) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')
BEGIN
  SELECT RAISE(ABORT, 'orders.ref must match HB-XXXXX (Crockford base32)');
END;
--> statement-breakpoint
-- (4) Storage types and formats CHECK cannot express without a table rebuild (rev-d DB-1 r1 nits):
-- SQLite stores 1.5 or '12' in an INTEGER column as REAL/TEXT, so money, stock and quantity are
-- checked with typeof(); flags must be a JSON array; fee_source is `table` or `courier:<name>`.
CREATE TRIGGER `variants_int_types_ins` BEFORE INSERT ON `variants`
WHEN typeof(NEW.`price_dzd`) <> 'integer'
  OR (NEW.`compare_at_dzd` IS NOT NULL AND typeof(NEW.`compare_at_dzd`) <> 'integer')
  OR (NEW.`stock` IS NOT NULL AND typeof(NEW.`stock`) <> 'integer')
BEGIN
  SELECT RAISE(ABORT, 'variants: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `variants_int_types_upd` BEFORE UPDATE OF `price_dzd`, `compare_at_dzd`, `stock` ON `variants`
WHEN typeof(NEW.`price_dzd`) <> 'integer'
  OR (NEW.`compare_at_dzd` IS NOT NULL AND typeof(NEW.`compare_at_dzd`) <> 'integer')
  OR (NEW.`stock` IS NOT NULL AND typeof(NEW.`stock`) <> 'integer')
BEGIN
  SELECT RAISE(ABORT, 'variants: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_int_types_ins` BEFORE INSERT ON `orders`
WHEN typeof(NEW.`subtotal_dzd`) <> 'integer'
  OR typeof(NEW.`fee_dzd`) <> 'integer'
  OR typeof(NEW.`total_dzd`) <> 'integer'
  OR typeof(NEW.`call_attempts`) <> 'integer'
  OR typeof(NEW.`version`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'orders: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_int_types_upd` BEFORE UPDATE OF `subtotal_dzd`, `fee_dzd`, `total_dzd`, `call_attempts`, `version` ON `orders`
WHEN typeof(NEW.`subtotal_dzd`) <> 'integer'
  OR typeof(NEW.`fee_dzd`) <> 'integer'
  OR typeof(NEW.`total_dzd`) <> 'integer'
  OR typeof(NEW.`call_attempts`) <> 'integer'
  OR typeof(NEW.`version`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'orders: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `order_items_int_types_ins` BEFORE INSERT ON `order_items`
WHEN typeof(NEW.`unit_price_dzd`) <> 'integer'
  OR typeof(NEW.`qty`) <> 'integer'
  OR typeof(NEW.`line_total_dzd`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'order_items: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `order_items_int_types_upd` BEFORE UPDATE OF `unit_price_dzd`, `qty`, `line_total_dzd` ON `order_items`
WHEN typeof(NEW.`unit_price_dzd`) <> 'integer'
  OR typeof(NEW.`qty`) <> 'integer'
  OR typeof(NEW.`line_total_dzd`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'order_items: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_fees_int_types_ins` BEFORE INSERT ON `delivery_fees`
WHEN typeof(NEW.`fee_dzd`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'delivery_fees: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_fees_int_types_upd` BEFORE UPDATE OF `fee_dzd` ON `delivery_fees`
WHEN typeof(NEW.`fee_dzd`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'delivery_fees: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `pack_items_int_types_ins` BEFORE INSERT ON `pack_items`
WHEN typeof(NEW.`qty`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'pack_items: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `pack_items_int_types_upd` BEFORE UPDATE OF `qty` ON `pack_items`
WHEN typeof(NEW.`qty`) <> 'integer'
BEGIN
  SELECT RAISE(ABORT, 'pack_items: money/quantity columns must be integers');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_flags_array_ins` BEFORE INSERT ON `orders`
WHEN json_type(NEW.`flags`) IS NOT 'array'
BEGIN
  SELECT RAISE(ABORT, 'orders.flags must be a JSON array');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_flags_array_upd` BEFORE UPDATE OF `flags` ON `orders`
WHEN json_type(NEW.`flags`) IS NOT 'array'
BEGIN
  SELECT RAISE(ABORT, 'orders.flags must be a JSON array');
END;
--> statement-breakpoint
CREATE TRIGGER `customers_flags_array_ins` BEFORE INSERT ON `customers`
WHEN json_type(NEW.`flags`) IS NOT 'array'
BEGIN
  SELECT RAISE(ABORT, 'customers.flags must be a JSON array');
END;
--> statement-breakpoint
CREATE TRIGGER `customers_flags_array_upd` BEFORE UPDATE OF `flags` ON `customers`
WHEN json_type(NEW.`flags`) IS NOT 'array'
BEGIN
  SELECT RAISE(ABORT, 'customers.flags must be a JSON array');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fee_source_fmt_ins` BEFORE INSERT ON `orders`
WHEN NOT (NEW.`fee_source` = 'table' OR (NEW.`fee_source` GLOB 'courier:?*' AND NEW.`fee_source` NOT GLOB '*[^a-z0-9:_-]*'))
BEGIN
  SELECT RAISE(ABORT, 'orders.fee_source must be table or courier:<name>');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fee_source_fmt_upd` BEFORE UPDATE OF `fee_source` ON `orders`
WHEN NOT (NEW.`fee_source` = 'table' OR (NEW.`fee_source` GLOB 'courier:?*' AND NEW.`fee_source` NOT GLOB '*[^a-z0-9:_-]*'))
BEGIN
  SELECT RAISE(ABORT, 'orders.fee_source must be table or courier:<name>');
END;
