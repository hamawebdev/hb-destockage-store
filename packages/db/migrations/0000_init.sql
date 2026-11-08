CREATE TABLE `admin_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`ui_lang` text DEFAULT 'fr' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer,
	CONSTRAINT "admin_users_email_lower" CHECK("email" = lower("email") and "email" like '%_@_%'),
	CONSTRAINT "admin_users_role_enum" CHECK("role" in ('owner', 'confirmer', 'logistics', 'content')),
	CONSTRAINT "admin_users_active_bool" CHECK("active" in (0, 1)),
	CONSTRAINT "admin_users_ui_lang_enum" CHECK("ui_lang" in ('ar', 'fr'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_email_uq` ON `admin_users` (`email`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_type` text NOT NULL,
	`actor_user_id` integer,
	`actor_email` text,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`before` text,
	`after` text,
	`request_id` text,
	`ip_hash` text,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_log_actor_enum" CHECK("actor_type" in ('customer', 'system', 'admin')),
	CONSTRAINT "audit_log_before_json" CHECK("before" is null or json_valid("before")),
	CONSTRAINT "audit_log_after_json" CHECK("after" is null or json_valid("after"))
);
--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`slug_fr` text NOT NULL,
	`slug_ar` text NOT NULL,
	`name_fr` text NOT NULL,
	`name_ar` text NOT NULL,
	`description_fr` text,
	`description_ar` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`placeholder` integer DEFAULT false NOT NULL,
	`translation_placeholder` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "categories_translation_placeholder" CHECK("translation_placeholder" in ('[]', '["ar"]', '["fr"]', '["ar","fr"]', '["fr","ar"]')),
	CONSTRAINT "categories_slug_fr_fmt" CHECK("slug_fr" <> '' and "slug_fr" not glob '*[^a-z0-9-]*' and "slug_fr" not glob '-*' and "slug_fr" not glob '*-' and "slug_fr" not glob '*--*'),
	CONSTRAINT "categories_slug_ar_fmt" CHECK("slug_ar" <> '' and "slug_ar" not glob '*[^a-z0-9-]*' and "slug_ar" not glob '-*' and "slug_ar" not glob '*-' and "slug_ar" not glob '*--*'),
	CONSTRAINT "categories_active_bool" CHECK("active" in (0, 1)),
	CONSTRAINT "categories_placeholder_bool" CHECK("placeholder" in (0, 1)),
	CONSTRAINT "categories_not_own_parent" CHECK("parent_id" is null or "parent_id" <> "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_fr_uq` ON `categories` (`slug_fr`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_ar_uq` ON `categories` (`slug_ar`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`,`sort`);--> statement-breakpoint
CREATE TABLE `communes` (
	`id` integer PRIMARY KEY NOT NULL,
	`wilaya_code` integer NOT NULL,
	`name_fr` text NOT NULL,
	`name_ar` text NOT NULL,
	`postal_code` text,
	FOREIGN KEY (`wilaya_code`) REFERENCES `wilayas`(`code`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `communes_wilaya_idx` ON `communes` (`wilaya_code`);--> statement-breakpoint
CREATE TABLE `content_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`slug_fr` text NOT NULL,
	`slug_ar` text NOT NULL,
	`title_fr` text NOT NULL,
	`title_ar` text NOT NULL,
	`summary_fr` text DEFAULT '' NOT NULL,
	`summary_ar` text DEFAULT '' NOT NULL,
	`body_fr` text DEFAULT '[]' NOT NULL,
	`body_ar` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`placeholder` integer DEFAULT false NOT NULL,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content_pages_key_enum" CHECK("key" in ('about', 'delivery', 'returns', 'contact', 'legal', 'privacy')),
	CONSTRAINT "content_pages_slug_fr_fmt" CHECK("slug_fr" <> '' and "slug_fr" not glob '*[^a-z0-9-]*' and "slug_fr" not glob '-*' and "slug_fr" not glob '*-' and "slug_fr" not glob '*--*'),
	CONSTRAINT "content_pages_slug_ar_fmt" CHECK("slug_ar" <> '' and "slug_ar" not glob '*[^a-z0-9-]*' and "slug_ar" not glob '-*' and "slug_ar" not glob '*-' and "slug_ar" not glob '*--*'),
	CONSTRAINT "content_pages_body_fr_json" CHECK(json_valid("body_fr") and json_type("body_fr") = 'array'),
	CONSTRAINT "content_pages_body_ar_json" CHECK(json_valid("body_ar") and json_type("body_ar") = 'array'),
	CONSTRAINT "content_pages_active_bool" CHECK("active" in (0, 1)),
	CONSTRAINT "content_pages_placeholder_bool" CHECK("placeholder" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_pages_key_uq` ON `content_pages` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_pages_slug_fr_uq` ON `content_pages` (`slug_fr`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_pages_slug_ar_uq` ON `content_pages` (`slug_ar`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`phone_e164` text NOT NULL,
	`name` text NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`delivered_count` integer DEFAULT 0 NOT NULL,
	`returned_count` integer DEFAULT 0 NOT NULL,
	`cancelled_count` integer DEFAULT 0 NOT NULL,
	`flags` text DEFAULT '[]' NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`notes` text,
	`last_order_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT "customers_phone_e164" CHECK(length("phone_e164") = 13 and "phone_e164" glob '+213[567][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "customers_counts_nonneg" CHECK("order_count" >= 0 and "delivered_count" >= 0 and "returned_count" >= 0 and "cancelled_count" >= 0),
	CONSTRAINT "customers_flags_json" CHECK(json_valid("flags")),
	CONSTRAINT "customers_blocked_bool" CHECK("blocked" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_uq` ON `customers` (`phone_e164`);--> statement-breakpoint
CREATE TABLE `delivery_fees` (
	`wilaya_code` integer PRIMARY KEY NOT NULL,
	`fee_dzd` integer NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`updated_by` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`wilaya_code`) REFERENCES `wilayas`(`code`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "delivery_fees_fee_nonneg" CHECK("fee_dzd" >= 0),
	CONSTRAINT "delivery_fees_available_bool" CHECK("available" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer,
	`category_id` integer,
	`variant_id` integer,
	`r2_key` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`alt_fr` text NOT NULL,
	`alt_ar` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`placeholder` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "images_one_owner" CHECK(("product_id" is null) <> ("category_id" is null)),
	CONSTRAINT "images_variant_needs_product" CHECK("variant_id" is null or "product_id" is not null),
	CONSTRAINT "images_dims_pos" CHECK("width" > 0 and "height" > 0),
	CONSTRAINT "images_placeholder_bool" CHECK("placeholder" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `images_r2_key_idx` ON `images` (`r2_key`);--> statement-breakpoint
CREATE INDEX `images_product_idx` ON `images` (`product_id`,`position`);--> statement-breakpoint
CREATE INDEX `images_category_idx` ON `images` (`category_id`,`position`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`order_id` integer NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'sending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`sent_at` integer,
	`last_error` text,
	PRIMARY KEY(`order_id`, `channel`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "notification_deliveries_status_enum" CHECK("status" in ('sending', 'sent')),
	CONSTRAINT "notification_deliveries_attempts_nonneg" CHECK("attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE `option_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`option_id` integer NOT NULL,
	`value_fr` text NOT NULL,
	`value_ar` text NOT NULL,
	`swatch_hex` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`option_id`) REFERENCES `product_options`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "option_values_swatch_hex" CHECK("swatch_hex" is null or (length("swatch_hex") = 7 and "swatch_hex" glob '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'))
);
--> statement-breakpoint
CREATE INDEX `option_values_option_idx` ON `option_values` (`option_id`,`position`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`outcome` text,
	`note` text,
	`actor_type` text NOT NULL,
	`actor_user_id` integer,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_events_type_enum" CHECK("type" in ('created', 'status_change', 'call_attempt', 'note')),
	CONSTRAINT "order_events_from_enum" CHECK("from_status" is null or "from_status" in ('new', 'called', 'confirmed', 'unreachable', 'cancelled', 'shipped', 'delivered', 'returned')),
	CONSTRAINT "order_events_to_enum" CHECK("to_status" is null or "to_status" in ('new', 'called', 'confirmed', 'unreachable', 'cancelled', 'shipped', 'delivered', 'returned')),
	CONSTRAINT "order_events_actor_enum" CHECK("actor_type" in ('customer', 'system', 'admin')),
	CONSTRAINT "order_events_admin_has_user" CHECK(("actor_type" = 'admin') = ("actor_user_id" is not null)),
	CONSTRAINT "order_events_status_change_has_to" CHECK("type" <> 'status_change' or "to_status" is not null)
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`,`at`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`name_fr` text NOT NULL,
	`name_ar` text NOT NULL,
	`variant_label_fr` text,
	`variant_label_ar` text,
	`sku` text NOT NULL,
	`unit_price_dzd` integer NOT NULL,
	`qty` integer NOT NULL,
	`line_total_dzd` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_items_qty_pos" CHECK("qty" > 0),
	CONSTRAINT "order_items_unit_price_nonneg" CHECK("unit_price_dzd" >= 0),
	CONSTRAINT "order_items_line_total" CHECK("line_total_dzd" = "unit_price_dzd" * "qty")
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`customer_id` integer NOT NULL,
	`name` text NOT NULL,
	`phone_e164` text NOT NULL,
	`wilaya_code` integer NOT NULL,
	`commune_id` integer NOT NULL,
	`address` text,
	`lang` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`call_attempts` integer DEFAULT 0 NOT NULL,
	`subtotal_dzd` integer NOT NULL,
	`fee_dzd` integer NOT NULL,
	`total_dzd` integer NOT NULL,
	`fee_source` text NOT NULL,
	`flags` text DEFAULT '[]' NOT NULL,
	`turnstile` text,
	`fill_ms` integer,
	`risk_score` integer,
	`ip_hash` text,
	`courier_name` text,
	`courier_tracking` text,
	`next_call_at` integer,
	`claimed_by_user_id` integer,
	`claimed_until` integer,
	`stock_restored_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`wilaya_code`) REFERENCES `wilayas`(`code`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`commune_id`) REFERENCES `communes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`claimed_by_user_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "orders_phone_e164" CHECK(length("phone_e164") = 13 and "phone_e164" glob '+213[567][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
	CONSTRAINT "orders_lang_enum" CHECK("lang" in ('ar', 'fr')),
	CONSTRAINT "orders_status_enum" CHECK("status" in ('new', 'called', 'confirmed', 'unreachable', 'cancelled', 'shipped', 'delivered', 'returned')),
	CONSTRAINT "orders_turnstile_enum" CHECK("turnstile" is null or "turnstile" in ('ok', 'missing', 'invalid', 'error')),
	CONSTRAINT "orders_call_attempts_nonneg" CHECK("call_attempts" >= 0),
	CONSTRAINT "orders_money_nonneg" CHECK("subtotal_dzd" >= 0 and "fee_dzd" >= 0),
	CONSTRAINT "orders_total_sum" CHECK("total_dzd" = "subtotal_dzd" + "fee_dzd"),
	CONSTRAINT "orders_flags_json" CHECK(json_valid("flags")),
	CONSTRAINT "orders_risk_range" CHECK("risk_score" is null or "risk_score" between 0 and 100),
	CONSTRAINT "orders_fill_ms_nonneg" CHECK("fill_ms" is null or "fill_ms" >= 0),
	CONSTRAINT "orders_version_nonneg" CHECK("version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_ref_uq` ON `orders` (`ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_idempotency_key_uq` ON `orders` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_status_created_idx` ON `orders` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_status_next_call_idx` ON `orders` (`status`,`next_call_at`);--> statement-breakpoint
CREATE INDEX `orders_wilaya_created_idx` ON `orders` (`wilaya_code`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_phone_created_idx` ON `orders` (`phone_e164`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_customer_created_idx` ON `orders` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_flagged_created_idx` ON `orders` (`created_at`,`id`) WHERE "flags" <> '[]';--> statement-breakpoint
CREATE TABLE `pack_items` (
	`pack_product_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`qty` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`pack_product_id`, `variant_id`),
	FOREIGN KEY (`pack_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "pack_items_qty_pos" CHECK("qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `pack_items_variant_idx` ON `pack_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `product_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`kind` text NOT NULL,
	`name_fr` text NOT NULL,
	`name_ar` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_options_kind_enum" CHECK("kind" in ('size', 'colour', 'other'))
);
--> statement-breakpoint
CREATE INDEX `product_options_product_idx` ON `product_options` (`product_id`,`position`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'simple' NOT NULL,
	`category_id` integer NOT NULL,
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_fr_uq` ON `products` (`slug_fr`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_ar_uq` ON `products` (`slug_ar`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`,`status`,`sort`);--> statement-breakpoint
CREATE TABLE `publish_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requested_by` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`snapshot_sha256` text,
	`product_count` integer,
	`build_ms` integer,
	`timings_json` text,
	`budget_ok` integer,
	`error` text,
	`log_tail` text,
	FOREIGN KEY (`requested_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "publish_runs_log_tail_len" CHECK("log_tail" is null or length("log_tail") <= 4096),
	CONSTRAINT "publish_runs_timings_json" CHECK("timings_json" is null or json_valid("timings_json")),
	CONSTRAINT "publish_runs_budget_ok_bool" CHECK("budget_ok" is null or "budget_ok" in (0, 1)),
	CONSTRAINT "publish_runs_status_enum" CHECK("status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_runs_one_active_uq` ON `publish_runs` ((1)) WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `publish_runs_requested_idx` ON `publish_runs` (`requested_at`);--> statement-breakpoint
CREATE TABLE `rum_daily` (
	`day` text NOT NULL,
	`template` text NOT NULL,
	`lang` text NOT NULL,
	`colo` text DEFAULT '' NOT NULL,
	`asn` integer DEFAULT 0 NOT NULL,
	`n` integer NOT NULL,
	`ttfb_p50` real,
	`ttfb_p75` real,
	`lcp_p50` real,
	`lcp_p75` real,
	PRIMARY KEY(`day`, `template`, `lang`, `colo`, `asn`),
	CONSTRAINT "rum_daily_day_fmt" CHECK("day" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "rum_daily_lang_enum" CHECK("lang" in ('ar', 'fr')),
	CONSTRAINT "rum_daily_n_nonneg" CHECK("n" >= 0)
);
--> statement-breakpoint
CREATE TABLE `rum_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`template` text NOT NULL,
	`path` text NOT NULL,
	`lang` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`rating` text,
	`nav_type` text,
	`effective_type` text,
	`colo` text,
	`country` text,
	`asn` integer,
	`proto` text,
	`prerendered` integer DEFAULT false NOT NULL,
	CONSTRAINT "rum_events_lang_enum" CHECK("lang" in ('ar', 'fr')),
	CONSTRAINT "rum_events_metric_enum" CHECK("metric" in ('LCP', 'INP', 'CLS', 'FCP', 'TTFB', 'DNS', 'CONNECT', 'TLS')),
	CONSTRAINT "rum_events_rating_enum" CHECK("rating" is null or "rating" in ('good', 'needs-improvement', 'poor')),
	CONSTRAINT "rum_events_value_nonneg" CHECK("value" >= 0),
	CONSTRAINT "rum_events_prerendered_bool" CHECK("prerendered" in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `rum_events_at_idx` ON `rum_events` (`at`);--> statement-breakpoint
CREATE INDEX `rum_events_metric_idx` ON `rum_events` (`metric`,`template`,`at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "settings_value_json" CHECK(json_valid("value"))
);
--> statement-breakpoint
CREATE TABLE `variant_option_values` (
	`variant_id` integer NOT NULL,
	`option_value_id` integer NOT NULL,
	PRIMARY KEY(`variant_id`, `option_value_id`),
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_value_id`) REFERENCES `option_values`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `variant_option_values_value_idx` ON `variant_option_values` (`option_value_id`);--> statement-breakpoint
CREATE TABLE `variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`sku` text NOT NULL,
	`price_dzd` integer NOT NULL,
	`compare_at_dzd` integer,
	`stock` integer,
	`weight_g` integer,
	`active` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "variants_price_nonneg" CHECK("price_dzd" >= 0),
	CONSTRAINT "variants_compare_at_gt_price" CHECK("compare_at_dzd" is null or "compare_at_dzd" > "price_dzd"),
	CONSTRAINT "variants_stock_nonneg" CHECK("stock" is null or "stock" >= 0),
	CONSTRAINT "variants_weight_nonneg" CHECK("weight_g" is null or "weight_g" >= 0),
	CONSTRAINT "variants_active_bool" CHECK("active" in (0, 1)),
	CONSTRAINT "variants_is_default_bool" CHECK("is_default" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_sku_uq` ON `variants` (`sku`);--> statement-breakpoint
CREATE INDEX `variants_product_idx` ON `variants` (`product_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `variants_one_default_uq` ON `variants` (`product_id`) WHERE "is_default" = 1;--> statement-breakpoint
CREATE TABLE `wilayas` (
	`code` integer PRIMARY KEY NOT NULL,
	`name_fr` text NOT NULL,
	`name_ar` text NOT NULL,
	`courier_code` text,
	CONSTRAINT "wilayas_code_range" CHECK("code" between 1 and 69)
);
