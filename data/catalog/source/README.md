# Source dump: hbdestockagedz.com (SEED-1)

Raw scrape of the client's current WooCommerce store, fetched **2026-11-04** (UTC) by `seed`.
Input for the normalised seed catalogue in `data/catalog/` (SEED-2). Nothing here is read at build
time; it is kept so every value in the seed can be traced to what the client published.

- `fetch-log.tsv` — every request: UTC time, URL, HTTP status, content type, bytes, saved file.
  Polite: one request at a time with ≥ 1.1 s between requests, User-Agent
  `Mozilla/5.0 (X11; Linux x86_64) catalogue-import/1.0`. robots.txt allows everything fetched.
  Not in the log: the headless-Chrome visits used for the order-form screenshots (3 page loads of
  `/produit/pack-3-en-1/` and `/`, trackers blocked, form never submitted), see
  `artifacts/SEED-1/order-form.md`.
- `raw/` — responses as received: WooCommerce Store API (`wc-store-*.json`), WP REST
  (`wp-v2-*.json`), sitemaps, product/home HTML, and the quick-order plugin's JS/CSS saved as
  `.txt` (data, never executed).
- `products.json` — the five products extracted from the Store API (prices converted from minor
  units to integer DZD, description HTML + plain text, de-duplicated images, fetch times) and a
  manifest of all 10 media files (largest size available = the unscaled original, dimensions, bytes,
  md5). Image files themselves are stored under `data/photos/` (SEED-3).

## What the store actually contains (2026-11-04)

| WC id | Slug | Name (as published) | Price | Compare-at | Photo |
|---|---|---|---|---|---|
| 4465 | `pack` | Pack | 14 600 | 18 900 | 1 (listed twice by the API) |
| 4440 | `pack-a-et-b` | Pack A et B | 14 600 | 17 900 | 1 |
| 4435 | `sans-titre` | Promotion | 14 600 | 17 900 | 1 |
| 4271 | `pack-3-en-1` | Pack 3 en 1 | 14 600 | 17 900 | 1 (listed twice by the API) |
| 20 | `nouvelle-pack-luxury-4en1-douche-prix-16500-da-livraison-60-alf` | nouvelle pack luxury 4en1 douche — prix 16500 DA — livraison 60 alf | 16 500 | 19 900 | 1 |

Findings that shape SEED-2:

- **Only 5 products, all WooCommerce `simple`, no attributes/variations, no SKUs, no stock
  tracking** (`is_in_stock: true`, `low_stock_remaining: null`), one category "Non classé".
- **Product names and descriptions are French only** (informal, partly lower-case). All Arabic on
  the site is theme/plugin UI copy. ⇒ Arabic product text in the seed is our translation, marked
  `translation_placeholder`.
- All five are **bathroom tap packs**: a "Piano" shower column (digital temperature display + LED;
  "grand modèle" vs "petit modèle"), a basin mixer ("mitigeur lavabo", written "Lavabo"), a toilet
  tap with hand spray ("robinet toilette", written "Toilette"), and in the 16 500 DA pack a kitchen
  mixer. Products 4465 and 4440 both describe **Pack A 14 600 DA / Pack B 13 600 DA** in their text,
  but can only be ordered at 14 600 DA (no variation exists).
- **Prices are burned into every product photo** ("14600 da", "16500 Da"); the photos go stale if a
  price changes.
- 5 media uploads are **not attached to any current product**: two real photos of Pack A + Pack B
  side by side (`IMG_7696`, prices 13 600 / 14 600 on paper signs) and of the two control panels
  (`IMG_7689`), a 13 600 DA pack B photo, and two "14500 Da" photos (an older price / "Pack nova").
- Delivery: the order form charges a flat **600 DA** in every wilaya (see order-form.md).
