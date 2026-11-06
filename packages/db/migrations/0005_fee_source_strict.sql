-- DB-2 review r1 (rev-d nit): fee_source must match @hb/shared /^(table|courier:[a-z0-9_-]+)$/.
-- 0002's version accepted "courier::" and "courier:a:b". Applied migrations are never edited, so the
-- triggers are replaced here.
DROP TRIGGER IF EXISTS `orders_fee_source_fmt_ins`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `orders_fee_source_fmt_upd`;
--> statement-breakpoint
CREATE TRIGGER `orders_fee_source_fmt_ins` BEFORE INSERT ON `orders`
WHEN NOT (NEW.`fee_source` = 'table' OR (length(NEW.`fee_source`) > 8 AND substr(NEW.`fee_source`, 1, 8) = 'courier:' AND substr(NEW.`fee_source`, 9) NOT GLOB '*[^a-z0-9_-]*'))
BEGIN
  SELECT RAISE(ABORT, 'orders.fee_source must be table or courier:<name>');
END;
--> statement-breakpoint
CREATE TRIGGER `orders_fee_source_fmt_upd` BEFORE UPDATE OF `fee_source` ON `orders`
WHEN NOT (NEW.`fee_source` = 'table' OR (length(NEW.`fee_source`) > 8 AND substr(NEW.`fee_source`, 1, 8) = 'courier:' AND substr(NEW.`fee_source`, 9) NOT GLOB '*[^a-z0-9_-]*'))
BEGIN
  SELECT RAISE(ABORT, 'orders.fee_source must be table or courier:<name>');
END;
