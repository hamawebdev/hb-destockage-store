# Seed catalogue

The seed catalogue in the `CatalogSnapshot` shape from CAT-1 (`packages/catalog/src/types.ts`,
validated by `packages/catalog/src/schema.ts`). `packages/catalog` (`fromSeed`) reads it for the
build, and `packages/db` loads it into local D1.

| File | Content |
|---|---|
| `categories.json` | `SnapshotCategory[]`: a flat list, with the tree given by `parentId` |
| `products/<fr-slug>.json` | one `SnapshotProduct` per file, holding its options, variants, pack items and images |
| `settings.json` | `SnapshotSettings`: store name, contact phone, WhatsApp, home featured and hero products |
| `provenance.json` | **not part of the snapshot**: where each real product comes from (see below) |
| `source/` | raw scrape of the client's current site (SEED-1); never read at build time |

Wilayas come from `data/geo/` and content pages from `data/content/`. They are not stored here.

## Ids (integers, fixed so a seeded D1 and the seed snapshot agree)

| Entity | Scheme | Example |
|---|---|---|
| category | top level 1–9, child `parent×10 + n`, grandchild `parent×10 + n` | 1 › 11 |
| product | real 101–199, placeholders 201+ | 101 |
| variant | `product×100 + n` | 10101 |
| option | `product×10 + n` | 1111 |
| option value | `option×100 + n` | 111101 |
| image | `product×10 + n` (≤ 9 images per product) | 1011 |

Each id space is its own D1 table, so equal numbers in different tables do not collide.

Array order matters for `variants` and `packItems`, which have no position field.

## Placeholders and translations

- `placeholder: true` means invented content: a product, category or image the client never
  published, or a real component whose **price** we invented. Text placeholders inside a
  real description are also tagged `[PLACEHOLDER]`.
- `translationPlaceholder: ["ar"]` means the Arabic text (name, summary, description, option
  names/values, alts) is our translation, not the client's. The client publishes product text in
  French only. A value of `["ar","fr"]` means we wrote both languages, for example category names
  the client never had.
- Stock: the client's site does not track stock, so real variants have `stock: null`, meaning
  untracked. That is a known fact, not a placeholder.

## Real products (client's site, fetched 2026-11-04)

The client's five WooCommerce products contained only three distinct offers. They are
**de-duplicated into three packs** (lead decision 2026-11-04, still to be confirmed by the client).
`provenance.json` → `wcProducts` maps every WooCommerce product to the seed ids, so the change can
be undone without losing anything.

| Id | Kind | Status | Price DZD | Compare-at | Note |
|---|---|---|---|---|---|
| 101 Pack A 3 en 1 | pack | active | 14 600 | 17 900 | WC 4271, 4435, 4440, 4465 |
| 102 Pack B 3 en 1 | pack | active | 13 600 | — | only in description text; `needsClientConfirmation` |
| 103 Pack luxe 4 en 1 | pack | active | 16 500 | 19 900 | WC 20 |
| 111 Colonne de douche Piano | variable (Modèle: grand / petit) | draft | placeholder | | pack component |
| 112 Mitigeur de lavabo | simple | draft | placeholder | | pack component |
| 113 Robinet de toilette avec douchette | simple | draft | placeholder | | pack component |
| 114 Mitigeur de cuisine | simple | draft | placeholder | | pack component |

Components exist so that `packItems` can point at real variants. They are `draft`, which means no
page, and they sit in the inactive category 12 "Robinetterie". The client sells them only inside
packs.
