// Regenerate the package's generated files:
//   tokens.css + src/tokens.generated.ts          from brand/tokens.json
//   font-face.css + src/font.generated.ts         from fonts/noto-sans-arabic-400.woff2 (built by fonts/subset.py)
//   icons/manifest.json + src/icons.generated.ts  from icons/*.svg
//   specimen/{fr,ar}.html                         from all of the above + base.css/forms.css
// Usage: node packages/ui-tokens/src/gen/cli.ts   (or npm run generate -w @hb/ui-tokens)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { generateAll } from './generate.ts';
import { PKG_DIR, resolveSource } from './source.ts';

const src = resolveSource();
for (const [path, content] of Object.entries(generateAll(src))) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`ui-tokens: ${relative(PKG_DIR, path)}`);
}
console.log(`ui-tokens: source ${src.sourcePath} (sha256 ${src.sourceSha256.slice(0, 12)}…)`);
