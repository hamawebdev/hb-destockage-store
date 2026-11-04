# @hb/ui-tokens

Design tokens, base CSS, icons and the Arabic font for the storefront and the admin.
Values come from `brand/tokens.json` (owner `brand`); this package only transcribes them.

## Files

| Path | What | Consumer |
|---|---|---|
| `tokens.css` | CSS custom properties. **Generated**, do not edit. | storefront (inlined), admin |
| `src/tokens.generated.ts` | Same values as a typed object + `tokensCss` string. **Generated**. | admin, build scripts |
| `src/index.ts` | Public TS entry: `tokens`, `tokensCss`, `tokensSource`, `arabicFontFace`, `fontFaceCss`, `icons`, `IconName`, `IconEntry`, `ICON_MIRROR_RULE`. | admin, storefront |
| `src/gen/` | Generator (`build-tokens.ts` pure, `cli.ts` writes files, `source.ts` finds the JSON). | tokens |
| `fonts/` | Noto Sans Arabic 400 subset, OFL, `subset.py` + `subset.json`. | storefront |
| `font-face.css` | The Arabic `@font-face`. **Generated**. | storefront |
| `icons/<name>.svg`, `icons/manifest.json` | Icon set; manifest **generated**. See Icons. | storefront, admin |
| `base.css` | Reset, typography, primitives, components (TOKENS-4). | storefront |

Regenerate after any change to `brand/tokens.json`, the font or `icons/` (also `npm run generate -w @hb/ui-tokens`):

```sh
node packages/ui-tokens/src/gen/cli.ts
```

The test suite rebuilds both outputs and fails if they differ from the committed files, and fails
if they were not built from the current `brand/tokens.json` (a warning only while the outputs still name the provisional copy). Until BRAND-1 is on `main`, the source
is `src/gen/provisional.tokens.json`, a verbatim copy of brand's committed file; it is deleted when
`brand/tokens.json` reaches `main`. The generator rejects a fluid `clamp()` that does not hit
brand's px values at 360 and 1440, an Arabic line-height outside 1.6–1.8 and non-zero Arabic
letter-spacing.

## Custom properties

All on `:root`. Language-dependent ones are re-declared on `:lang(ar)` (every Arabic element), so a
rule written with `var(--lh-heading)`, `var(--ls-caps)`, `var(--fw-emphasis)` gets the Arabic value
when **that rule's element** is Arabic.

Variables do not reach an Arabic *child* of a French element: `letter-spacing`, `line-height` and
`font-weight` inherit as computed values, so `<h1>Promo <span lang="ar">…</span></h1>` on `/fr/`
would hand the span the French values. Therefore `:lang(ar)` in `tokens.css` also sets the three
invariants as real, unlayered `!important` properties — `letter-spacing: 0`, `font-weight: 400`,
`font-synthesis: none` — which no component rule can override. `font-family` and `line-height` are
not forced there (the «العربية» switch must keep `--font-switcher`, headings keep their own
line-height); `base.css` (TOKENS-4) re-applies `--font-body` / `--lh-*` on Arabic elements.

| Group | Names |
|---|---|
| Colour roles | `--color-<role>` (surface, surface-alt, text, text-secondary, accent, accent-text, focus, border, border-control, success, warning, danger, price, sale, …). Use pairs listed in `brand/tokens.json` `contrastPairs` only. Links: `accent-text`. Form outlines: `border-control`. |
| Font stacks | `--font-latin`, `--font-arabic`, `--font-switcher` (the «العربية» label: never names the webfont), `--font-body` (resolved per language) |
| Weight | `--fw-regular`, `--fw-emphasis` (600 Latin, **400 under Arabic**; Arabic elements are forced to 400 with `font-synthesis: none`) |
| Line-height (unitless, per language) | `--lh-body`, `--lh-heading`, `--lh-display`, `--lh-ui` |
| Letter-spacing (per language, **0 under Arabic**) | `--ls-display`, `--ls-heading`, `--ls-body`, `--ls-caps` |
| Type scale (fluid 360→1440) | `--fs-caption`, `--fs-small`, `--fs-body`, `--fs-lead`, `--fs-h3`, `--fs-h2`, `--fs-h1`, `--fs-display`, `--fs-hero`; `--measure` |
| Space (4px base) | `--space-0` … `--space-32` |
| Layout | `--gutter`, `--section-block`, `--container-max`, `--reading-max`, `--grid-gap`, `--tap-min`, `--header-h`, `--bottom-bar-h`, `--scroll-pad-start` (= header + space-2, for `scroll-padding-block-start`), `--scroll-pad-end` |
| Shape | `--radius-{none,sm,md,lg,xl,pill,round}`, `--shadow-{none,hover,sticky,overlay}`, `--bw-{hairline,control}`, `--focus-width`, `--focus-offset` |
| Motion | `--dur-{instant,fast,base,slow}` (0.01ms under `prefers-reduced-motion: reduce`), `--ease-{standard,emphasized,exit}`, `--motion-distance` |
| Stacking | `--z-{base,sticky,overlay,toast,skip}` |
| Icons | `--icon-{sm,md,lg}` (16/20/24px) |

**Breakpoints** cannot be custom properties inside `@media`; write the literal min-width:
base 360 (no query), `md` 768px, `lg` 1024px, `xl` 1440px (`tokens.breakpoint` in TS; also in the
`tokens.css` header comment).

## Arabic font

`fonts/noto-sans-arabic-400.woff2` — Noto Sans Arabic 400 (notofonts NotoSansArabic-v2.013, static,
unhinted) subset to Arabic + ڨ ڢ ڧ ڤ + digits/punctuation, 9,992 B. `font-face.css` (generated):
family `"HB Noto Sans Arabic"` (first entry of brand's `--font-arabic`), `font-display: optional`,
`unicode-range` read from the file's own cmap, `src: url("./fonts/noto-sans-arabic-400.woff2")`
relative so the bundler hashes it. TS: `arabicFontFace` (`file`, `bytes`, `sha256`,
`unicodeRange`), `fontFaceCss`. The storefront preloads it on `/ar/` only. On `/fr/` no element's
font-family names it, so it is never fetched.

Rebuild: `python3 -I packages/ui-tokens/fonts/subset.py` (pinned URL + sha256s and fontTools/brotli
versions in `fonts/subset.json`; byte-identical output), then `node packages/ui-tokens/src/gen/cli.ts`.
Licence: `fonts/OFL.txt`.

## Icons

21 outline icons in `icons/<name>.svg`: search, menu, close, bag, chevron-start, chevron-end,
arrow-start, arrow-end, phone, whatsapp, truck, check, plus, minus, info, alert, filter, home, grid,
user, star. Contract (enforced by the generator and `test/icons.test.ts`): `viewBox="0 0 24 24"`,
`fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, round caps/joins, 2px live-area
padding, only geometry inside, ≤ 300 B as a file and as the inline string.

- **TS:** `icons[name].svg` is the inline-able string (no `xmlns`, `aria-hidden="true"`, 24×24
  default size that CSS overrides), `icons[name].mirror`, `IconName`. `icons/manifest.json` lists
  `{ mirror, fileBytes, inlineBytes }` per icon. Files keep `xmlns` so they also work standalone.
- **Direction:** chevron-start/-end and arrow-start/-end are drawn for LTR ("start" points left),
  carry `data-mirror`, and are flipped by `:dir(rtl) [data-mirror]{transform:scaleX(-1)}`
  (`ICON_MIRROR_RULE`, shipped in `base.css`). Use `-start` for "back/previous" and `-end` for
  "next/forward" in both languages; never pick by physical direction. Everything else never
  mirrors (the truck and the phone keep their orientation in Arabic).

**Usage rules (for the brand guide):**
1. Size with `--icon-sm` (16px, inline in captions), `--icon-md` (20px, next to UI text),
   `--icon-lg` (24px, header and buttons). Do not scale the stroke; don't use other sizes.
2. Colour comes from the text colour (`currentColor`): icon + label share one contrast pair from
   `contrastPairs`. Status icons use the status colour (`--color-danger` with `alert`,
   `--color-success` with `check`), always next to text, never colour alone.
3. Decorative or labelled-by-adjacent-text icons keep `aria-hidden="true"`. An icon-only control
   (menu, close, search, plus/minus steppers) is a `<button>`/`<a>` with an accessible name
   (`aria-label` in the page language or visually-hidden text) and a ≥ 44×44px hit area (`--tap-min`)
   even though the glyph is 20–24px.
4. `whatsapp` is a simple outline glyph for the plain `https://wa.me/213779942022` link only — never
   a widget, never the official green logo lockup. `phone` goes with `tel:` links (number in `<bdi>`).
5. `star` is outline only (no filled/half rating states in this set). `info` and `alert` head notes;
   `truck` heads delivery info; `bag` is the order/cart affordance; `grid` = categories;
   `filter` = listing filters; `home` = home.
6. New icons follow the same grid/stroke and go through `node packages/ui-tokens/src/gen/cli.ts`.

## CSS approach

Hand-written CSS in cascade layers, one sheet for both directions, inlined:
`tokens.css` (unlayered custom properties) → `base.css` (`@layer base`) → page/component CSS.
Logical properties only (a test fails on any physical property). `tokens.css` alone is about
1.1 KiB brotli; unused custom properties should be dropped at build so the inlined sheet stays
near 4 KiB br total.
