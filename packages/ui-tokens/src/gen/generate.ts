// All generated files of the package, as { absolutePath: content }. The CLI writes them; the
// specimen drift test compares them. Inputs: brand/tokens.json (or the provisional copy), the woff2,
// icons/*.svg, base.css, forms.css.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFont } from './build-font.ts';
import { buildIcons } from './build-icons.ts';
import { buildSpecimen } from './build-specimen.ts';
import { buildTokens } from './build-tokens.ts';
import {
  CSS_OUT, FONT_CSS_OUT, FONT_TS_OUT, ICONS_MANIFEST_OUT, ICONS_TS_OUT, PKG_DIR, SPECIMEN_DIR, TS_OUT,
  readFontInput, readIconFiles, type Source,
} from './source.ts';

export function generateAll(src: Source): Record<string, string> {
  const tok = buildTokens(src);
  const font = buildFont(readFontInput(src));
  const icons = buildIcons(readIconFiles());
  const specimen = {
    brand: src.tokens,
    tokensCss: tok.css,
    fontFaceCss: font.css,
    baseCss: readFileSync(join(PKG_DIR, 'base.css'), 'utf8'),
    formsCss: readFileSync(join(PKG_DIR, 'forms.css'), 'utf8'),
    icons: icons.icons,
    ...tok.model,
  };
  return {
    [CSS_OUT]: tok.css,
    [TS_OUT]: tok.ts,
    [FONT_CSS_OUT]: font.css,
    [FONT_TS_OUT]: font.ts,
    [ICONS_MANIFEST_OUT]: icons.manifest,
    [ICONS_TS_OUT]: icons.ts,
    [join(SPECIMEN_DIR, 'fr.html')]: buildSpecimen('fr', specimen),
    [join(SPECIMEN_DIR, 'ar.html')]: buildSpecimen('ar', specimen),
  };
}
