# Brand assets (generated)

Built by `node brand/scripts/build-assets.mjs` from `brand/logo/*.svg`, `brand/tokens.json` and
`brand/copy/strings.*.json` (sharp 0.35.5; Inter and Noto Sans Arabic v2.013 Regular — the same release as
`packages/ui-tokens/fonts/subset.json` — are downloaded and sha256-checked, or passed as `INTER_TTF` /
`NOTO_ARABIC_TTF`, which must match the pinned hashes). With the same sharp build, output is
byte-for-byte deterministic. Do not edit these files by hand.

| File | Size | Use |
|---|---|---|
| `favicon.svg` | 64 viewBox, ~0.9 KB | `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` — inverts on dark browser chrome |
| `favicon.ico` | 16 + 32 px PNG | `<link rel="icon" href="/favicon.ico" sizes="32x32">` (legacy, crawlers) |
| `favicon-32.png` | 32 px | spare PNG favicon |
| `apple-touch-icon.png` | 180 px, opaque, square | `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` |
| `icon-192.png`, `icon-512.png` | rounded tile, transparent corners | web manifest (none planned yet) |
| `icon-maskable-512.png` | full bleed, content in the 80 % safe zone | manifest `purpose: "maskable"` |
| `og-default-ar.jpg`, `og-default-fr.jpg` | 1200×630, ≤ 80 KB | `og:image` per language (WhatsApp/Facebook don't read AVIF) |
| `og-default.jpg` | = Arabic | x-default / fallback |
| `og-category-sample-*.jpg` | 1200×630 | samples of `renderCategoryOg(sharp, {lang, title})` exported by the script, for per-category images |

`shell` copies `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` and `og-default*.jpg` into the
storefront's public directory. `theme-color` = `#ffffff` (`surface`).
