// Fixture catalogue for integration tests and the latency script. Values are test data only.
// Wilayas: 16 served (600 DZD), 31 row present but not served, 59 no fee row.
export const SEED_SQL: readonly string[] = [
  `insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر'), (31, 'Oran', 'وهران'), (59, 'Aflou', 'أفلو')`,
  `insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى'), (1602, 16, 'Bab El Oued', 'باب الوادي'), (3101, 31, 'Oran', 'وهران'), (5901, 59, 'Aflou', 'أفلو')`,
  `insert into categories (id, slug_fr, slug_ar, name_fr, name_ar) values (1, 'cuisine', 'matbakh', 'Cuisine', 'مطبخ')`,
  `insert into products (id, kind, category_id, slug_fr, slug_ar, name_fr, name_ar, status) values
     (1, 'simple',   1, 'pack-cuisine', 'hizmat-matbakh', 'Pack cuisine', 'حزمة المطبخ', 'active'),
     (2, 'variable', 1, 'pack-bain',    'hizmat-hammam', 'Pack bain',    'حزمة الحمام', 'active'),
     (3, 'simple',   1, 'brouillon',    'musawwada',     'Brouillon',    'مسودة',       'draft'),
     (4, 'simple',   1, 'archive',      'arshif',     'Archivé',      'مؤرشف',       'archived')`,
  `insert into variants (id, product_id, sku, price_dzd, stock, weight_g, active, is_default) values
     (11, 1, 'PK-CUI',    14600, null, 4000, 1, 1),
     (21, 2, 'PK-BAIN-S', 15500, 3,    3000, 1, 1),
     (22, 2, 'PK-BAIN-M', 16500, 0,    3500, 1, 0),
     (23, 2, 'PK-BAIN-L', 16900, 5,    3900, 0, 0),
     (31, 3, 'DRAFT-1',   9000,  5,    null, 1, 1),
     (41, 4, 'ARCH-1',    9000,  5,    null, 1, 1)`,
  `insert into product_options (id, product_id, kind, name_fr, name_ar, position) values (1, 2, 'size', 'Taille', 'المقاس', 0)`,
  `insert into option_values (id, option_id, value_fr, value_ar, position) values (1, 1, 'S', 'صغير', 0), (2, 1, 'M', 'متوسط', 1), (3, 1, 'L', 'كبير', 2)`,
  `insert into variant_option_values (variant_id, option_value_id) values (21, 1), (22, 2), (23, 3)`,
  `insert into delivery_fees (wilaya_code, fee_dzd, available) values (16, 600, 1), (31, 900, 0)`,
];
