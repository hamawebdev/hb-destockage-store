-- DB-8 r1 (rev-c nit): a printed price is a real price, so > 0, matching seed's manifest rule
-- (data/catalog/validate.mjs). Applied migrations are never edited: the 0008 triggers are replaced.
-- No table rebuild: only triggers change, so every index and trigger on images (and every other
-- table) is untouched. Existing rows that break the new rule are REFUSED, not kept or dropped:
-- the count of violating rows must be 0, or this CHECK aborts the migration.
CREATE TABLE `_db8_printed_prices_check` (`violations` integer NOT NULL CONSTRAINT `printed_prices_positive_existing_rows` CHECK (`violations` = 0));
--> statement-breakpoint
INSERT INTO `_db8_printed_prices_check` SELECT count(*) FROM `images` WHERE EXISTS (SELECT 1 FROM json_each(`images`.`printed_prices_dzd`) WHERE type <> 'integer' OR value <= 0);
--> statement-breakpoint
DROP TABLE `_db8_printed_prices_check`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `images_printed_prices_ins`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `images_printed_prices_upd`;
--> statement-breakpoint
CREATE TRIGGER `images_printed_prices_ins` BEFORE INSERT ON `images`
WHEN NOT (json_valid(NEW.`printed_prices_dzd`) AND json_type(NEW.`printed_prices_dzd`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.`printed_prices_dzd`) WHERE type <> 'integer' OR value <= 0))
BEGIN
  SELECT RAISE(ABORT, 'images.printed_prices_dzd must be a JSON array of positive integers');
END;
--> statement-breakpoint
CREATE TRIGGER `images_printed_prices_upd` BEFORE UPDATE OF `printed_prices_dzd` ON `images`
WHEN NOT (json_valid(NEW.`printed_prices_dzd`) AND json_type(NEW.`printed_prices_dzd`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.`printed_prices_dzd`) WHERE type <> 'integer' OR value <= 0))
BEGIN
  SELECT RAISE(ABORT, 'images.printed_prices_dzd must be a JSON array of positive integers');
END;
