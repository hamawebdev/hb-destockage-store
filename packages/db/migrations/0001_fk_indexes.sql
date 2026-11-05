CREATE INDEX `images_variant_idx` ON `images` (`variant_id`);--> statement-breakpoint
CREATE INDEX `order_items_variant_idx` ON `order_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `order_items_product_idx` ON `order_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `orders_commune_idx` ON `orders` (`commune_id`);