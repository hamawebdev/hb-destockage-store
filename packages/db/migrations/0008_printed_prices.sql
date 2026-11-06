-- DB-8 (lead ruling, admin-catalog request, seed BUG-14): prices printed on a photo, as a JSON array of
-- integer DZD ([] = none; one photo can print several). The admin blocks activating a product whose
-- photo prints a price none of its variants has. Filled by the seed from data/photos/manifest.json.
ALTER TABLE `images` ADD `printed_prices_dzd` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `images_printed_prices_ins` BEFORE INSERT ON `images`
WHEN NOT (json_valid(NEW.`printed_prices_dzd`) AND json_type(NEW.`printed_prices_dzd`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.`printed_prices_dzd`) WHERE type <> 'integer' OR value < 0))
BEGIN
  SELECT RAISE(ABORT, 'images.printed_prices_dzd must be a JSON array of non-negative integers');
END;
--> statement-breakpoint
CREATE TRIGGER `images_printed_prices_upd` BEFORE UPDATE OF `printed_prices_dzd` ON `images`
WHEN NOT (json_valid(NEW.`printed_prices_dzd`) AND json_type(NEW.`printed_prices_dzd`) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.`printed_prices_dzd`) WHERE type <> 'integer' OR value < 0))
BEGIN
  SELECT RAISE(ABORT, 'images.printed_prices_dzd must be a JSON array of non-negative integers');
END;
