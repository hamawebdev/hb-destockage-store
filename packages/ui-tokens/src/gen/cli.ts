// Regenerate the package's generated files:
//   tokens.css + src/tokens.generated.ts   from brand/tokens.json
//   font-face.css + src/font.generated.ts  from fonts/noto-sans-arabic-400.woff2 (built by fonts/subset.py)
// Usage: node packages/ui-tokens/src/gen/cli.ts
import { writeFileSync } from 'node:fs';
import { buildFont } from './build-font.ts';
import { buildTokens } from './build-tokens.ts';
import { CSS_OUT, FONT_CSS_OUT, FONT_TS_OUT, TS_OUT, readFontInput, resolveSource } from './source.ts';

const src = resolveSource();
const { css, ts } = buildTokens(src);
writeFileSync(CSS_OUT, css);
writeFileSync(TS_OUT, ts);
console.log(`ui-tokens: tokens from ${src.sourcePath} (sha256 ${src.sourceSha256.slice(0, 12)}…)`);

const font = buildFont(readFontInput(src));
writeFileSync(FONT_CSS_OUT, font.css);
writeFileSync(FONT_TS_OUT, font.ts);
console.log('ui-tokens: font-face from fonts/');
