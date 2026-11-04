// @hb/ui-tokens — TS entry for the admin and build scripts. The storefront inlines tokens.css.
export { tokens, tokensCss, tokensSource, type Tokens } from './tokens.generated.ts';

export const PACKAGE = '@hb/ui-tokens';

/**
 * The Arabic webfont (Noto Sans Arabic 400 subset): family, file, bytes, unicode-range.
 * Only elements whose font-family names `family` can download it: on /fr/ pages that is nobody,
 * because `--font-body` is the Latin system stack and the «العربية» switch uses `--font-switcher`.
 */
export { arabicFontFace, arabicFontFace as arabicFont, fontFaceCss } from './font.generated.ts';

/** Icon folder convention: icons/<name>.svg, 24×24 viewBox, stroke="currentColor", 1.5 stroke. */
export interface IconEntry {
  /** Inline-able SVG markup. */
  svg: string;
  /** Directional icon: carries data-mirror and is flipped by `:dir(rtl) [data-mirror]` in base.css. */
  mirror: boolean;
}
