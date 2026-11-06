-- DB-4 r1 (rev-d Important, confirmed by rev-c): record per order line the units actually taken from
-- stock at creation (qty if the variant was tracked, 0 if untracked), so a cancel/return restores
-- exactly that and never adds back units that were never taken. Existing rows get 0: no real orders
-- exist yet (lead ruling).
ALTER TABLE `order_items` ADD `stock_taken` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `order_items_stock_taken_ins` BEFORE INSERT ON `order_items`
WHEN typeof(NEW.`stock_taken`) <> 'integer' OR NEW.`stock_taken` < 0 OR NEW.`stock_taken` > NEW.`qty`
BEGIN
  SELECT RAISE(ABORT, 'order_items.stock_taken must be an integer between 0 and qty');
END;
--> statement-breakpoint
CREATE TRIGGER `order_items_stock_taken_upd` BEFORE UPDATE OF `stock_taken`, `qty` ON `order_items`
WHEN typeof(NEW.`stock_taken`) <> 'integer' OR NEW.`stock_taken` < 0 OR NEW.`stock_taken` > NEW.`qty`
BEGIN
  SELECT RAISE(ABORT, 'order_items.stock_taken must be an integer between 0 and qty');
END;
