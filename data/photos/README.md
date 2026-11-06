# Product photos (originals)

These are the original image files that the seed catalogue refers to. `images[].key` in
`data/catalog/products/*.json` is a path relative to this folder. The derived sizes (AVIF
360–1200 w) are produced by `packages/catalog`'s image pipeline. They are never stored here.

Layout: `<product fr-slug>/<n>.<ext>`. A single file can be referenced by more than one product.
For example, `colonne-de-douche-piano/1.jpg` is used by product 111 and by Pack B. Duplicates are
stored once. `manifest.json` lists **every** photo file here with its source (`client_own`,
`supplier_render` or `generated`), the prices printed in it and the products using it. Real
entries are written by `data/catalog/source/build_real.py`, generated ones by
`data/catalog/placeholders/build.py`. A file without an entry fails the validator.

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

| File | WP media | Source | Printed prices (`manifest.json`) | Used by |
|---|---|---|---|---|
| `pack-a-3-en-1-colonne-piano-led/1.jpg` | 497 `IMG_7696` | **client_own** | 13600, 14600 (paper signs) | **none** (BUG-14) |
| `pack-a-3-en-1-colonne-piano-led/2.jpg` | 4272 | supplier_render ⚠ | 14600 | 101 (1st) |
| `pack-a-3-en-1-colonne-piano-led/3.jpg` | 4436 | supplier_render ⚠ | 14600 | 101 |
| `pack-a-3-en-1-colonne-piano-led/4.jpg` | 4441 | supplier_render ⚠ | 14600 | 101 |
| `pack-a-3-en-1-colonne-piano-led/5.jpg` | 4466 | supplier_render ⚠ | 14600 | 101 |
| `pack-b-3-en-1-colonne-piano/1.jpg` | 150 | **client_own** | 13600 | 102 (1st) |
| `colonne-de-douche-piano/1.jpg` | 498 `IMG_7689` | **client_own** | none | 111 (draft), 102 (2nd) |
| `pack-luxe-4-en-1/1.jpg` | 147 | supplier_render ⚠ | 16500 | 103 (only image) |
| `_unreferenced/wp-media-409.jpg` | 409 "Pack nova 14500 DA" | supplier_render ⚠ | **14500**: matches no current price | none |
| `_unreferenced/wp-media-410.jpg` | 410 | supplier_render ⚠ | **14500**: matches no current price | none |

- **client_own** means the client's own photograph (iPhone EXIF before stripping).
- **supplier_render ⚠** means an Instagram screenshot of a collage of product renders, probably
  supplier or marketplace material. Each one is marked `needsClientConfirmation: true` in
  `provenance.json`. The client still has to confirm that they hold the rights to use them.

### Rules applied (lead, 2026-11-04; printed prices tightened by BUG-14, 2026-11-06)

- **Printed prices, enforced:** most real photos have a price printed on them. Each one's
  printed prices are recorded in `manifest.json` → `printedPrices` (`[]` = none; audited by eye
  2026-11-06). A product may show a photo **in any position** only if every price printed on it
  is a price of one of that product's variants. `data/catalog/validate.mjs` fails otherwise, so a
  price change that makes a photo stale fails the build until the photos are fixed. Current
  prices: 101 = 14 600, 102 = 13 600, 103 = 16 500.
- **A photo is real if `manifest.json` lists it as `client_own` or `supplier_render`**, whatever
  the `placeholder` flag on its image row says. A real photo's image row may not be
  `placeholder: true`, and `placeholder: true` is accepted only on a `generated` entry. Invented
  (placeholder) products may only show generated placeholders. The price and provenance checks run
  on every real photo. Every file under `data/photos/` must have an entry, so a new photo can't
  slip in unlisted.
- **BUG-14:** `pack-a-3-en-1-colonne-piano-led/1.jpg` (Pack A and Pack B with paper signs 13 600
  and 14 600) was 101's first image and 102's second. It prints a price each of them doesn't
  sell at, so it is now in no gallery. The file stays here with its provenance. 101 now opens
  with `2.jpg` (prints 14 600 only; supplier render, rights still a client question).
- **Client photos first:** wherever a usable photo of the client's own exists, it is image 1
  (102). Pack A and the 4-en-1 pack now only have supplier renders.
- **Files in no gallery:** `pack-a…/1.jpg` (above) and `_unreferenced/` (two uploads printing
  14 500, which matches nothing on sale). They are kept so that nothing the client published is
  lost.
- Alt text (ar/fr) describes what is actually in each picture, including any printed price. The
  Arabic alt text is our translation (`translationPlaceholder: ["ar"]` on the product).

## Placeholder photos (SEED-4)

All the other folders (`ecouteurs-sans-fil/`, `t-shirt-coton-homme/`, …) hold **generated
placeholders**, not photographs. Each is a 1200×1200 sRGB JPEG with a flat shape on a light surface,
labelled "PLACEHOLDER" at the top, with the product name (ar/fr) and "not a real product" at the
bottom. They come from `data/catalog/placeholders/build.py` + `render.mjs`, and nothing in them is
copied from another website. Every one has `placeholder: true` in its image row and a
`source: "generated"` entry in `manifest.json`.
