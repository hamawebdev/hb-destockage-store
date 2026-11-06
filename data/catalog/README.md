# Seed catalogue

The seed catalogue in the `CatalogSnapshot` shape from CAT-1 (`packages/catalog/src/types.ts`,
validated by `packages/catalog/src/schema.ts`). `packages/catalog` (`fromSeed`) reads it for the
build, and `packages/db` loads it into local D1.

| File | Content |
|---|---|
| `categories.json` | `SnapshotCategory[]`: a flat list, with the tree given by `parentId` |
| `products/<fr-slug>.json` | one `SnapshotProduct` per file, holding its options, variants, pack items and images |
| `settings.json` | `SnapshotSettings`: store name, contact phone, WhatsApp, home featured products. `homeHeroProductId` is `null` (no image hero) until the client supplies hero photography: every real photo has prices printed on it (lead ruling, 2026-11-05) |
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

Each id space is its own D1 table, so equal numbers in different tables do not collide. `validate.mjs` enforces this scheme.

Array order matters for `variants` and `packItems`, which have no position field.

## Placeholders and translations

- `placeholder: true` means invented content: a product, category or image the client never
  published, or a real component whose **price** we invented. Text placeholders inside a
  real description are also tagged `[PLACEHOLDER]`.
- **Every category is `placeholder: true`** and its description starts with `[PLACEHOLDER]`.
  That includes Salle de bain › Packs salle de bain / Robinetterie: the client's site has a single
  "Non classé" category, so the category tree and its names are our proposal. A category becomes
  real only when `provenance.json` → `categories` lists it (empty today). Even then it stays a
  placeholder while it holds a placeholder product. Nothing marked `placeholder: false` may contain
  `[PLACEHOLDER]` text.
- A product is **real** if, and only if, `provenance.json` → `products` lists it. Any other
  product is invented, so it must be `placeholder: true` and so must all its images. The validator
  enforces this.
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

## Placeholder catalogue (SEED-4)

Placeholder content shows that the store can sell any kind of product. Every placeholder category,
product and image has `placeholder: true`. Every placeholder description ends with a `[PLACEHOLDER]`
paragraph, and every placeholder photo carries a visible "PLACEHOLDER" label. Brands are fictional
(`DemoSound`, `DemoCare`).

| Top level | Sub-categories | Products |
|---|---|---|
| 2 Électronique & accessoires | 21 Téléphonie › **211 Chargeurs & câbles, 212 Coques & protections** (3 levels); 22 Audio | earbuds (colour; *Bleu nuit out of stock*), speaker (colour), 20 W charger, USB-C cable (length; *stock untracked*), phone case (colour) |
| 3 Mode | 31 Homme, 32 Femme, 33 Chaussures | t-shirt (**size × colour, 12 variants**; *M/Noir low stock = 2*), hoodie (size × colour, XL costs more), summer dress (size), scarf (colour), sneakers (shoe size 38–44 × colour, 14 variants) |
| 4 Beauté & soins | 41 Visage, 42 Cheveux, 43 Coffrets | face cream, vitamin C serum, cleansing gel, shampoo (250/500 ml), argan oil (*low stock = 4*), **Coffret soin visage = pack** of the cream, serum and gel |
| 5 Jouets & enfants | 51 Construction, 52 Peluches, 53 Véhicules | building blocks (*stock untracked*), puzzle, teddy bear (3 sizes), RC car (colour) |

That makes 17 categories, 20 products, 65 variants and 50 photos (2–4 per product, with
per-colour photos linked by `variantId`). Generated by `placeholders/build.py` (JSON + photo SVGs)
and `placeholders/render.mjs` (SVG → JPEG with system Chrome):

```sh
python3 -I data/catalog/placeholders/build.py . /tmp/ph-svg
node data/catalog/placeholders/render.mjs /tmp/ph-svg data/photos
```

## Validation (SEED-5)

```sh
node data/catalog/validate.mjs              # exits 1 and lists issues as products/<file>.json.<path>: message
node --test 'data/catalog/test/*.test.mjs'
```

`validate.mjs` exports `loadSeed(repoRoot)`, `toSnapshot(seed)`, `validateLoadedSeed(seed)`,
`validateSeed(repoRoot)` (→ `{path, message}[]`, empty = valid) and `imageSize(buffer)`.
`db` runs it before seeding D1 and `pagedata` runs it in `fromSeed` before the build. It applies
CAT-1's own schema and integrity checks (`@hb/catalog/schema`), then the seed-only rules listed at the
top of the file: image files, sizes and keys, placeholder marking, and provenance.
