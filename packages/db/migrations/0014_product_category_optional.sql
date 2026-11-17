-- products.category_id becomes nullable: a product may be sold with no category. Dropping NOT NULL
-- needs a table rebuild, and `products` is the parent of five tables. HAND-WRITTEN, do not regenerate:
--
-- drizzle-kit's rebuild (CREATE __new, copy, DROP products, RENAME) deletes data on D1. With foreign
-- keys on (D1 cannot turn them off), DROP TABLE runs an implicit DELETE that fires ON DELETE CASCADE:
-- every row of product_options, option_values, variant_option_values, pack_items and every product
-- photo row in images is deleted. Measured on workerd D1 with the generated file.
-- PRAGMA defer_foreign_keys only postpones the checks (and lets the DROP pass the RESTRICT of variants
-- and order_items, whose rows stay and match the renamed table again); it does not stop the cascade.
-- Renaming `products` away first does not help either: SQLite rewrites the children's REFERENCES.
--
-- So: copy the five cascaded tables aside, rebuild, put their rows back, and refuse to finish unless
-- every row count is what it was. All of it runs in the one transaction D1 applies a migration file
-- in. If it is ever run statement by statement, DROP TABLE fails on the RESTRICT (nothing is lost).
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'simple' NOT NULL,
	`category_id` integer,
	`slug_fr` text NOT NULL,
	`slug_ar` text NOT NULL,
	`name_fr` text NOT NULL,
	`name_ar` text NOT NULL,
	`brand_latin` text,
	`summary_fr` text DEFAULT '' NOT NULL,
	`summary_ar` text DEFAULT '' NOT NULL,
	`description_fr` text DEFAULT '' NOT NULL,
	`description_ar` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`placeholder` integer DEFAULT false NOT NULL,
	`translation_placeholder` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "products_translation_placeholder" CHECK("translation_placeholder" in ('[]', '["ar"]', '["fr"]', '["ar","fr"]', '["fr","ar"]')),
	CONSTRAINT "products_slug_fr_fmt" CHECK("slug_fr" <> '' and "slug_fr" not glob '*[^a-z0-9-]*' and "slug_fr" not glob '-*' and "slug_fr" not glob '*-' and "slug_fr" not glob '*--*'),
	CONSTRAINT "products_slug_ar_fmt" CHECK("slug_ar" <> '' and "slug_ar" not glob '*[^a-z0-9-]*' and "slug_ar" not glob '-*' and "slug_ar" not glob '*-' and "slug_ar" not glob '*--*'),
	CONSTRAINT "products_kind_enum" CHECK("kind" in ('simple', 'variable', 'pack')),
	CONSTRAINT "products_status_enum" CHECK("status" in ('draft', 'active', 'archived')),
	CONSTRAINT "products_placeholder_bool" CHECK("placeholder" in (0, 1))
);--> statement-breakpoint
INSERT INTO `__new_products`("id", "kind", "category_id", "slug_fr", "slug_ar", "name_fr", "name_ar", "brand_latin", "summary_fr", "summary_ar", "description_fr", "description_ar", "status", "sort", "placeholder", "translation_placeholder", "created_at", "updated_at") SELECT "id", "kind", "category_id", "slug_fr", "slug_ar", "name_fr", "name_ar", "brand_latin", "summary_fr", "summary_ar", "description_fr", "description_ar", "status", "sort", "placeholder", "translation_placeholder", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
-- Keep the AUTOINCREMENT high-water mark, so the id of a deleted product is never given out again.
UPDATE `sqlite_sequence` SET `seq` = (SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'products') WHERE `name` = '__new_products' AND EXISTS (SELECT 1 FROM `sqlite_sequence` WHERE `name` = 'products');--> statement-breakpoint
CREATE TABLE `__keep_product_options` AS SELECT * FROM `product_options`;--> statement-breakpoint
CREATE TABLE `__keep_option_values` AS SELECT * FROM `option_values`;--> statement-breakpoint
CREATE TABLE `__keep_variant_option_values` AS SELECT * FROM `variant_option_values`;--> statement-breakpoint
CREATE TABLE `__keep_images` AS SELECT * FROM `images`;--> statement-breakpoint
CREATE TABLE `__keep_pack_items` AS SELECT * FROM `pack_items`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
-- Same column order as the live tables (the copies were made with SELECT *). Parents first.
INSERT INTO `product_options` SELECT * FROM `__keep_product_options`;--> statement-breakpoint
INSERT INTO `option_values` SELECT * FROM `__keep_option_values`;--> statement-breakpoint
INSERT INTO `variant_option_values` SELECT * FROM `__keep_variant_option_values`;--> statement-breakpoint
-- Category photos (product_id NULL) were not deleted.
INSERT INTO `images` SELECT * FROM `__keep_images` WHERE `id` NOT IN (SELECT `id` FROM `images`);--> statement-breakpoint
INSERT INTO `pack_items` SELECT * FROM `__keep_pack_items`;--> statement-breakpoint
-- A surviving category photo that pointed at an option value had the link set to NULL by the cascade.
UPDATE `images` SET `option_value_id` = (SELECT k.`option_value_id` FROM `__keep_images` k WHERE k.`id` = `images`.`id`) WHERE `option_value_id` IS NULL AND `id` IN (SELECT `id` FROM `__keep_images` WHERE `option_value_id` IS NOT NULL);--> statement-breakpoint
-- Refuse to commit unless every row is back: a false result breaks the CHECK and rolls everything back.
CREATE TABLE `__migration_0014_check` (`ok` integer NOT NULL, CONSTRAINT "migration_0014_rows_restored" CHECK("ok" = 1));--> statement-breakpoint
INSERT INTO `__migration_0014_check` (`ok`) SELECT (SELECT count(*) FROM `product_options`) = (SELECT count(*) FROM `__keep_product_options`) AND (SELECT count(*) FROM `option_values`) = (SELECT count(*) FROM `__keep_option_values`) AND (SELECT count(*) FROM `variant_option_values`) = (SELECT count(*) FROM `__keep_variant_option_values`) AND (SELECT count(*) FROM `images`) = (SELECT count(*) FROM `__keep_images`) AND (SELECT count(*) FROM `pack_items`) = (SELECT count(*) FROM `__keep_pack_items`);--> statement-breakpoint
DROP TABLE `__migration_0014_check`;--> statement-breakpoint
DROP TABLE `__keep_product_options`;--> statement-breakpoint
DROP TABLE `__keep_option_values`;--> statement-breakpoint
DROP TABLE `__keep_variant_option_values`;--> statement-breakpoint
DROP TABLE `__keep_images`;--> statement-breakpoint
DROP TABLE `__keep_pack_items`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_fr_uq` ON `products` (`slug_fr`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_ar_uq` ON `products` (`slug_ar`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`,`status`,`sort`);
