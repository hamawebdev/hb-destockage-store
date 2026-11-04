# Product photos (originals)

These are the original image files that the seed catalogue refers to. `images[].key` in
`data/catalog/products/*.json` is a path relative to this folder. The derived sizes (AVIF
360–1200 w) are produced by `packages/catalog`'s image pipeline. They are never stored here.

Layout: `<product fr-slug>/<n>.<ext>`. A single file can be referenced by more than one product.
For example, `pack-a-3-en-1-colonne-piano-led/1.jpg` is also used by Pack B, because it shows both
packs. Duplicates are stored once.

## Real product photos: source and fetch date

- **Source:** the client's own site, https://hbdestockagedz.com/wp-content/uploads/…, largest size
  available (the unscaled original). Fetched **2026-11-04** (UTC). The full URL of each file is in
  `data/catalog/provenance.json` → `images[]`, and the request log is in
  `data/catalog/source/fetch-log.tsv`.
- **Processing:** EXIF/XMP stripped losslessly with `jpegtran -copy icc -optimize`. The pixels are
  identical to the download (ImageMagick `compare -metric AE` = 0). None of the files had GPS data.
  Every file **keeps its Display P3 ICC profile**, so the pipeline must convert to sRGB when it
  encodes AVIF.
- The md5 of each original download is in `data/catalog/source/products.json` → `media[]`. Those
  hashes are for the original files. The stripped files here have different hashes.

| File | WP media | Source | Burned-in price | Used by |
|---|---|---|---|---|
| `pack-a-3-en-1-colonne-piano-led/1.jpg` | 497 `IMG_7696` | **client_own** | 13600 / 14600 (paper signs) | 101 (1st), 102 (2nd) |
| `pack-a-3-en-1-colonne-piano-led/2.jpg` | 4272 | supplier_render ⚠ | 14600 | 101 |
| `pack-a-3-en-1-colonne-piano-led/3.jpg` | 4436 | supplier_render ⚠ | 14600 | 101 |
| `pack-a-3-en-1-colonne-piano-led/4.jpg` | 4441 | supplier_render ⚠ | 14600 | 101 |
| `pack-a-3-en-1-colonne-piano-led/5.jpg` | 4466 | supplier_render ⚠ | 14600 | 101 |
| `pack-b-3-en-1-colonne-piano/1.jpg` | 150 | **client_own** | 13600 | 102 (1st) |
| `colonne-de-douche-piano/1.jpg` | 498 `IMG_7689` | **client_own** | none | 111 (draft), 102 (3rd) |
| `pack-luxe-4-en-1/1.jpg` | 147 | supplier_render ⚠ | 16500 | 103 (only image) |
| `_unreferenced/wp-media-409.jpg` | 409 "Pack nova 14500 DA" | supplier_render ⚠ | **14500**: matches no current price | none |
| `_unreferenced/wp-media-410.jpg` | 410 | supplier_render ⚠ | **14500**: matches no current price | none |

- **client_own** means the client's own photograph (iPhone EXIF before stripping).
- **supplier_render ⚠** means an Instagram screenshot of a collage of product renders, probably
  supplier or marketplace material. Each one is marked `needsClientConfirmation: true` in
  `provenance.json`. The client still has to confirm that they hold the rights to use them.

### Rules applied (lead, 2026-11-04)

- **Burned-in prices:** almost every real photo has a price printed on it, so it goes stale when
  the price changes. No product uses a photo as its first (LCP) image if the burned-in price
  differs from the product's price: 101 = 14 600 (its first photo shows both 13600 and 14600
  signs), 102 = 13 600, 103 = 16 500. If a price changes, re-order or replace that product's photos.
- **Client photos first:** wherever one of the client's own photos exists, it is image 1. The
  4-en-1 pack only has a supplier render.
- **`_unreferenced/`:** two uploads from the client's media library that no product uses, because
  the price printed on them (14 500) matches nothing on sale. They are kept so that nothing the
  client published is lost. The catalogue never references them.
- Alt text (ar/fr) describes what is actually in each picture, including any printed price. The
  Arabic alt text is our translation (`translationPlaceholder: ["ar"]` on the product).
