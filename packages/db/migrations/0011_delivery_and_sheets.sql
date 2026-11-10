CREATE TABLE `courier_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`courier` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`credentials_cipher` text,
	`credentials_iv` text,
	`key_version` integer,
	`credentials_hint` text DEFAULT '{}' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`webhook_token_hash` text,
	`poll_lease_until` integer,
	`poll_backoff_until` integer,
	`last_polled_at` integer,
	`last_check_result` text,
	`last_check_at` integer,
	`updated_by` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "courier_accounts_enabled_bool" CHECK("enabled" in (0, 1)),
	CONSTRAINT "courier_accounts_hint_json" CHECK(json_valid("credentials_hint")),
	CONSTRAINT "courier_accounts_config_json" CHECK(json_valid("config")),
	CONSTRAINT "courier_accounts_cipher_pair" CHECK(("credentials_cipher" is null) = ("credentials_iv" is null)),
	CONSTRAINT "courier_accounts_check_enum" CHECK("last_check_result" is null or "last_check_result" in ('valid', 'invalid', 'unavailable', 'rate_limited'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courier_accounts_courier_uq` ON `courier_accounts` (`courier`);--> statement-breakpoint
CREATE UNIQUE INDEX `courier_accounts_webhook_token_uq` ON `courier_accounts` (`webhook_token_hash`);--> statement-breakpoint
CREATE TABLE `courier_directory` (
	`courier` text NOT NULL,
	`kind` text NOT NULL,
	`wilaya_code` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`courier`, `kind`, `wilaya_code`),
	CONSTRAINT "courier_directory_kind_enum" CHECK("kind" in ('wilayas', 'communes', 'stop_desks')),
	CONSTRAINT "courier_directory_payload_json" CHECK(json_valid("payload")),
	CONSTRAINT "courier_directory_payload_size" CHECK(length(cast("payload" as blob)) <= 80000)
);
--> statement-breakpoint
CREATE TABLE `courier_webhook_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`courier` text NOT NULL,
	`body` blob NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`next_attempt_at` integer,
	`received_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `courier_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "courier_webhook_inbox_state_enum" CHECK("state" in ('pending', 'held', 'done', 'rejected', 'poison')),
	CONSTRAINT "courier_webhook_inbox_headers_json" CHECK(json_valid("headers")),
	CONSTRAINT "courier_webhook_inbox_body_size" CHECK(length("body") <= 32768),
	CONSTRAINT "courier_webhook_inbox_headers_size" CHECK(length(cast("headers" as blob)) <= 8192),
	CONSTRAINT "courier_webhook_inbox_attempts_nonneg" CHECK("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `courier_webhook_inbox_work_idx` ON `courier_webhook_inbox` (`state`,`next_attempt_at`) WHERE "state" in ('pending', 'held');--> statement-breakpoint
CREATE INDEX `courier_webhook_inbox_account_open_idx` ON `courier_webhook_inbox` (`account_id`) WHERE "state" in ('pending', 'held');--> statement-breakpoint
CREATE INDEX `courier_webhook_inbox_account_idx` ON `courier_webhook_inbox` (`account_id`);--> statement-breakpoint
CREATE INDEX `courier_webhook_inbox_purge_idx` ON `courier_webhook_inbox` (`processed_at`) WHERE "state" in ('done', 'rejected');--> statement-breakpoint
CREATE TABLE `delivery_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`shipment_id` integer,
	`order_id` integer,
	`courier` text,
	`raw_status` text DEFAULT '' NOT NULL,
	`detail` text,
	`count` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`resolution_note` text,
	`resolved_by` integer,
	`resolved_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resolved_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "delivery_exceptions_kind_enum" CHECK("kind" in ('unknown_status', 'terminal_conflict', 'order_not_applicable', 'unmatched_tracking', 'uncertain_send', 'draft_unvalidated', 'invalid_signature', 'inbox_poison')),
	CONSTRAINT "delivery_exceptions_state_enum" CHECK("state" in ('open', 'resolved')),
	CONSTRAINT "delivery_exceptions_count_pos" CHECK("count" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_exceptions_open_uq` ON `delivery_exceptions` (`kind`,`subject`,`raw_status`) WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX `delivery_exceptions_list_idx` ON `delivery_exceptions` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `delivery_exceptions_shipment_idx` ON `delivery_exceptions` (`shipment_id`);--> statement-breakpoint
CREATE INDEX `delivery_exceptions_order_idx` ON `delivery_exceptions` (`order_id`);--> statement-breakpoint
CREATE INDEX `delivery_exceptions_subject_idx` ON `delivery_exceptions` (`kind`,`subject`);--> statement-breakpoint
CREATE INDEX `delivery_exceptions_resolved_by_idx` ON `delivery_exceptions` (`resolved_by`);--> statement-breakpoint
CREATE TABLE `sheets_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`google_email` text,
	`google_sub` text,
	`connected_by` integer,
	`refresh_token_enc` text,
	`create_key` text,
	`spreadsheet_id` text,
	`tab_id` integer,
	`lang` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`lease_owner` text,
	`lease_until` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_success_at` integer,
	`last_error_code` text,
	`last_error_at` integer,
	`layout_note` text,
	`scan_fingerprint` text,
	`last_scan_at` integer,
	`connected_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connected_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sheets_connection_singleton" CHECK("id" = 1),
	CONSTRAINT "sheets_connection_status_enum" CHECK("status" in ('disconnected', 'connected', 'needs_reconnect', 'sheet_lost', 'layout_changed')),
	CONSTRAINT "sheets_connection_lang_enum" CHECK("lang" is null or "lang" in ('ar', 'fr')),
	CONSTRAINT "sheets_connection_failure_nonneg" CHECK("failure_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `sheets_revocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_enc` text NOT NULL,
	`google_sub` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "sheets_revocations_attempts_nonneg" CHECK("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `sheets_revocations_next_idx` ON `sheets_revocations` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `sheets_rows` (
	`order_id` integer PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`source_version` integer NOT NULL,
	`shipment_stamp` integer,
	`row_hash` text NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `shipment_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shipment_id` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`raw_status` text NOT NULL,
	`mapped` text NOT NULL,
	`reason` text,
	`occurred_at` integer,
	`received_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`source` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shipment_events_mapped_enum" CHECK("mapped" in ('pending', 'in_transit', 'delivered', 'returning', 'returned', 'exception', 'unknown')),
	CONSTRAINT "shipment_events_source_enum" CHECK("source" in ('webhook', 'poll')),
	CONSTRAINT "shipment_events_state_enum" CHECK("state" in ('pending', 'applied', 'ignored', 'exception'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_events_dedupe_uq` ON `shipment_events` (`shipment_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `shipment_events_pending_idx` ON `shipment_events` (`shipment_id`,`id`) WHERE "state" = 'pending';--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`courier` text NOT NULL,
	`account_id` integer NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`reference` text NOT NULL,
	`tracking` text,
	`label_url` text,
	`courier_status` text,
	`courier_status_raw` text,
	`courier_status_at` integer,
	`delivery_type` text DEFAULT 'home' NOT NULL,
	`stop_desk_id` text,
	`stop_desk_name` text,
	`address` text,
	`cod_amount_dzd` integer NOT NULL,
	`fee_dzd` integer NOT NULL,
	`wilaya_code` integer NOT NULL,
	`commune_id` integer NOT NULL,
	`error_code` text,
	`error_detail` text,
	`attempted_at` integer,
	`attempt_ended_at` integer,
	`validate_attempted_at` integer,
	`accepted_at` integer,
	`applied_at` integer,
	`verify_next_at` integer,
	`verify_inconclusive_since` integer,
	`verify_lease_until` integer,
	`first_absent_at` integer,
	`last_polled_at` integer,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `courier_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shipments_state_enum" CHECK("state" in ('reserved', 'sending', 'draft', 'accepted', 'uncertain', 'failed')),
	CONSTRAINT "shipments_courier_status_enum" CHECK("courier_status" is null or "courier_status" in ('pending', 'in_transit', 'delivered', 'returning', 'returned', 'exception', 'unknown')),
	CONSTRAINT "shipments_delivery_type_enum" CHECK("delivery_type" in ('home', 'stop_desk')),
	CONSTRAINT "shipments_stop_desk_has_id" CHECK("delivery_type" <> 'stop_desk' or "stop_desk_id" is not null),
	CONSTRAINT "shipments_money_nonneg" CHECK("cod_amount_dzd" >= 0 and "fee_dzd" >= 0),
	CONSTRAINT "shipments_accepted_has_tracking" CHECK("state" not in ('draft', 'accepted') or "tracking" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_one_live_uq` ON `shipments` (`order_id`) WHERE "state" in ('reserved', 'sending', 'draft', 'accepted', 'uncertain');--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_tracking_uq` ON `shipments` (`courier`,`tracking`) WHERE "tracking" is not null;--> statement-breakpoint
CREATE INDEX `shipments_order_idx` ON `shipments` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `shipments_account_idx` ON `shipments` (`account_id`);--> statement-breakpoint
CREATE INDEX `shipments_state_idx` ON `shipments` (`state`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `shipments_poll_idx` ON `shipments` (`account_id`,`last_polled_at`) WHERE "state" in ('draft', 'accepted') and "tracking" is not null;--> statement-breakpoint
CREATE INDEX `shipments_unapplied_idx` ON `shipments` (`state`) WHERE "state" = 'accepted' and "applied_at" is null;--> statement-breakpoint
CREATE INDEX `shipments_updated_at_idx` ON `shipments` (`updated_at`);--> statement-breakpoint
CREATE INDEX `orders_updated_at_idx` ON `orders` (`updated_at`);