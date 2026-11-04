# data/geo — wilayas, communes, delivery fees (owner: geo)

| File | What | Consumers |
|---|---|---|
| `wilayas.json` | 69 × `{code, name_ar, name_fr}`, code order. Codes 59–69 per Decree 26-206. No courier code (D-001). | `db` seed, `pagedata` (via `index.mjs`) |
| `communes.json` | 1,541 × `{id, wilaya_code, name_ar, name_fr}`; `id` is stable. No postal codes (not in the source). | `db` seed, `pagedata` |
| `index.mjs` | `loadWilayas()`, `loadCommunes()` (types: `index.d.mts`) | Node build steps |
| `build.mjs` | `buildGeoAssets(outDir, {lang})` → `geo/communes/<lang>/<code>.json` = `[[id,"name"],…]` collator-sorted; returns wilaya options `{code, label}` (types: `build.d.mts`). Sizes: `artifacts/GEO-3/sizes.md`. | `pagedata` → storefront; `orderform` fetches after LCP |
| `fees.seed.json` | 69 × `{wilaya_code, fee_dzd, available, placeholder: true}` | `db` seed |
| `search.mjs` | `normalizeForSearch(s, lang)` (types: `search.d.mts`), 521 B minified; match with `key.includes(query)`. Parity corpus for ports: `search.corpus.json` (regenerate: `node data/geo/scripts/make-search-corpus.mjs`). | `pages`, `orderform`, `pagedata` |
| `source/` | Pinned upstream dataset, Journal officiel lists, `corrections.json` (see `source/README.md`) | `scripts/normalize.mjs` |

Regenerate `wilayas.json`/`communes.json` after editing `source/corrections.json`:
`node data/geo/scripts/normalize.mjs` (`--check` fails when they are stale). Tests:
`node --test 'data/geo/**/*.test.mjs'`.

## fees.seed.json — [PLACEHOLDER]

Every fee is a **placeholder** (`placeholder: true`) until the client's admin sets real fees in the
admin (`delivery_fees`). These are not courier quotes. The scheme follows distance from Algiers:

| DZD | Zone | Wilayas |
|---|---|---|
| 400 | Algiers and its ring | 9, 16, 35, 42 |
| 600 | Northern Tell | 2, 6, 10, 13, 15, 18, 19, 21–27, 29, 31, 34, 36, 41, 43, 44, 46, 48 |
| 800 | Highlands / steppe, incl. the 2026 wilayas 59–69 | 3, 4, 5, 12, 14, 17, 20, 28, 32, 38, 40, 45, 59, 60, 62–69 |
| 900 | Biskra gateway | 7, 51, 61 |
| 1000 | Northern Sahara | 8, 30, 39, 47, 52, 55, 57, 58 |
| 1400 | Far south | 1, 11, 33, 37, 49, 53, 56 |
| 1600, `available: false` | Border wilayas many COD couriers do not serve (client to confirm) | 50, 54 |
