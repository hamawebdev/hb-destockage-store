# Logo usage — Comptoir de Luxe

All files are outlined paths: they render with **zero font downloads**. Regenerate with
`python3 -I brand/scripts/build-logo.py` (Inter, SIL OFL 1.1, pinned by sha256; output is deterministic).
Never retype the logo in a font, never stretch, recolour outside the variants below, add effects,
or mirror it in RTL: the logo is a Latin brand name and reads left-to-right on `/ar/` pages too.

## The marks

| File | What | Use |
|---|---|---|
| `wordmark.svg` | **COMPTOIR** (Inter Bold, −0.01 em) · blue dot · **DE LUXE** (Inter Regular, tracked +0.06 em) | Default on white / `surface-alt` |
| `wordmark-inverse.svg` | Same, `#f5f5f7` letters, `#2997ff` dot | On `surface-inverse` (#1d1d1f) or dark photos |
| `wordmark-mono.svg` | Everything `currentColor` | One-colour print, stamps, embossing, fax |
| `wordmark-header-static.svg` | Integer-precision paths, literal `#1d1d1f` letters and `#0071e3` dot | **Storefront header (current use)**, as a same-origin, content-hashed, cached decorative `<img alt="">` inside the home link (the link carries the name, `chrome.homeLink`): fetched once instead of adding ~1.3 KiB brotli to every HTML page (SHELL-2 measurement). ≤ 2 KB brotli, checked by test. |
| `wordmark-header.svg` | Same paths; letters `currentColor`, dot `var(--color-accent, #0071e3)`, `aria-hidden` | Inline alternative, only where the mark must follow the text colour. In an `<img>` `currentColor` turns black (#000), so never use this file as an image. The surrounding `<a>` carries the label (`chrome.homeLink`). |
| `monogram.svg` | **CL** in a #1d1d1f rounded tile (radius 22 %), blue "tag eyelet" dot top-right | Favicon, app icon, avatar (WhatsApp, Facebook), social images |
| `monogram-inverse.svg` | White tile, dark letters | On dark backgrounds |
| `monogram-accent.svg` | Blue tile, white letters + eyelet | Promotional stickers; never next to the blue order button |
| `monogram-mono.svg` | Tile in `currentColor`, letters knocked out | One-colour use |
| `lockup.svg` | Monogram tile + wordmark | Brand guide, social images, invoices, packaging labels |

**The idea.** The blue dot is a price-tag eyelet: on the tile it sits where a tag's hole is; in the
wordmark it separates the trade (*comptoir*, the shop counter) from its promise (*de luxe*). It is the only colour in the logo, the same blue
as the storefront's order button (`accent`). A bold word + light tracked capitals give the calm,
premium contrast of the reference without a webfont.

## Clear space

Let **x = the cap height** of the wordmark (height of the H).

- Wordmark and lockup: keep **0.5 x** free on every side (header minimum). Preferred: **1 x**.
- Monogram: keep **25 %** of the tile width free around the tile.
- Nothing (text, icons, photo edges, other logos) enters the clear space.

## Minimum size

| Mark | Digital | Print |
|---|---|---|
| Wordmark | cap height **10 px** (≈ 135 px wide). Header exception: **14 px** cap (189 × 14 px) at 360 px viewports, **18 px** (243 × 18 px) from 768 px | cap height 2.5 mm (≈ 34 mm wide) |
| Monogram | **16 px** (favicon). Below 24 px the eyelet may be dropped by the favicon export | 8 mm |
| Lockup | tile 24 px | tile 8 mm |

Aspect: wordmark width = **13.48 ×** cap height. Lockup width = 9.78 × tile height.

## Colour

Only on the brand surfaces: `surface` #ffffff, `surface-alt` #f5f5f7 → default; `surface-inverse`
#1d1d1f → inverse. On photos, place the wordmark only over a calm area with ≥ 4.5:1 contrast to the
letters; otherwise use the monogram on its own tile.

## Don't

- Don't set "COMPTOIR DE LUXE" in a live font as a logo (the HTML `<title>`/text name is fine).
- Don't draw the wordmark in Arabic or swap its words. Arabic pages show the same Latin wordmark; in
  running Arabic text the name is written كونتوار دو لوكس (live text, no `<bdi>` needed).
- Don't use the CL monogram as a written abbreviation of the name ("CL", "CDL"): it is a mark only.
- Don't move the dot, change its colour to anything but the variants above, or remove it from the wordmark.
- Don't put the monogram tile inside another rounded box or add a shadow.

## The name

| | Written exactly |
|---|---|
| French / Latin | **Comptoir de Luxe** (accessible name of every mark: `aria-label`/`<title>`) |
| Arabic | **كونتوار دو لوكس** |
| Domain | **comptoirdeluxe.com** |

## Arabic name with the logo

There is no drawn Arabic logo. The client's Arabic name is كونتوار دو لوكس; where it has to appear next
to the logo (shop sign, packaging, the guide's cover), set it under the wordmark as live text in Noto Sans
Arabic 400, `text-secondary`, at about the wordmark's cap height, under it and aligned with it. Never draw it
into the SVG, never letter-space it.
