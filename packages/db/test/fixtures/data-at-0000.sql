-- One row in every table of 0000_init (and only 0000's columns), loaded BEFORE later migrations
-- run, so any table rebuild in a later migration copies real data (test/migrations.test.ts).
-- Statements are separated by ";\n".
INSERT INTO admin_users (id, email, name, role) VALUES (1, 'owner@dev.local', 'Owner', 'owner');
INSERT INTO wilayas (code, name_fr, name_ar, courier_code) VALUES (16, 'Alger', 'الجزائر', '16');
INSERT INTO communes (id, wilaya_code, name_fr, name_ar, postal_code) VALUES (1601, 16, 'Alger Centre', 'الجزائر الوسطى', '16000');
INSERT INTO delivery_fees (wilaya_code, fee_dzd, available, updated_by) VALUES (16, 400, 1, 1);
INSERT INTO categories (id, slug_fr, slug_ar, name_fr, name_ar, description_fr, description_ar) VALUES (1, 'cuisine', 'matbakh', 'Cuisine', 'مطبخ', 'd', 'و');
INSERT INTO products (id, kind, category_id, slug_fr, slug_ar, name_fr, name_ar, brand_latin, summary_fr, summary_ar, description_fr, description_ar, status) VALUES (10, 'variable', 1, 'pack', 'taqm', 'Pack', 'طقم', 'HB', 's', 'م', 'd', 'و', 'active');
INSERT INTO product_options (id, product_id, kind, name_fr, name_ar) VALUES (1, 10, 'colour', 'Couleur', 'اللون');
INSERT INTO option_values (id, option_id, value_fr, value_ar, swatch_hex) VALUES (11, 1, 'Rouge', 'أحمر', '#ff0000');
INSERT INTO variants (id, product_id, sku, price_dzd, compare_at_dzd, stock, weight_g, is_default) VALUES (100, 10, 'SKU-R', 14600, 17900, 5, 1200, 1);
INSERT INTO variant_option_values (variant_id, option_value_id) VALUES (100, 11);
INSERT INTO pack_items (pack_product_id, variant_id, qty) VALUES (10, 100, 1);
INSERT INTO images (id, product_id, variant_id, r2_key, width, height, alt_fr, alt_ar) VALUES (1, 10, 100, 'pack/1.jpg', 800, 600, 'alt', 'بديل');
INSERT INTO customers (id, phone_e164, name, notes) VALUES (1, '+213560417403', 'Amine', 'note');
INSERT INTO orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, address, lang, subtotal_dzd, fee_dzd, total_dzd, fee_source, flags, turnstile, ip_hash, courier_name, courier_tracking) VALUES (1, 'HB-7K2Q9', 'key-1', 1, 'Amine', '+213560417403', 16, 1601, 'rue', 'ar', 14600, 400, 15000, 'table', '["duplicate"]', 'ok', 'abc', 'yalidine', 'TRK');
INSERT INTO order_items (order_id, variant_id, product_id, name_fr, name_ar, variant_label_fr, variant_label_ar, sku, unit_price_dzd, qty, line_total_dzd) VALUES (1, 100, 10, 'Pack', 'طقم', 'Rouge', 'أحمر', 'SKU-R', 14600, 1, 14600);
INSERT INTO order_events (order_id, type, from_status, to_status, outcome, note, actor_type, actor_user_id) VALUES (1, 'status_change', 'new', 'called', 'busy', 'n', 'admin', 1);
INSERT INTO content_pages (id, key, slug_fr, slug_ar, title_fr, title_ar, summary_fr, summary_ar, body_fr, body_ar, updated_by) VALUES (1, 'about', 'qui', 'man', 'Qui', 'من', 's', 'م', '[]', '[]', 1);
INSERT INTO settings (key, value, updated_by) VALUES ('storeName', '{"fr":"HB","ar":"HB"}', 1);
INSERT INTO audit_log (actor_type, actor_user_id, actor_email, action, entity, entity_id, before, after, request_id, ip_hash) VALUES ('admin', 1, 'owner@dev.local', 'product.update', 'products', '10', '{}', '{}', 'ray', 'abc');
INSERT INTO publish_runs (requested_by, status, snapshot_sha256, error, log_tail, timings_json) VALUES (1, 'succeeded', 'sha', 'e', 'tail', '{}');
INSERT INTO rum_events (template, path, lang, metric, value, rating, nav_type, effective_type, colo, country, proto) VALUES ('home', '/ar/', 'ar', 'LCP', 900, 'good', 'navigate', '4g', 'MRS', 'DZ', 'h2');
INSERT INTO rum_daily (day, template, lang, colo, asn, n) VALUES ('2026-11-05', 'home', 'ar', 'MRS', 327931, 1);
INSERT INTO notification_deliveries (order_id, channel, status, attempts, last_error) VALUES (1, 'telegram', 'sending', 1, 'HTTP 500')
