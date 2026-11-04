// Regenerate tokens.css and src/tokens.generated.ts from brand/tokens.json.
// Usage: node packages/ui-tokens/src/gen/cli.ts
import { writeFileSync } from 'node:fs';
import { buildTokens } from './build-tokens.ts';
import { CSS_OUT, TS_OUT, resolveSource } from './source.ts';

const src = resolveSource();
const { css, ts } = buildTokens(src);
writeFileSync(CSS_OUT, css);
writeFileSync(TS_OUT, ts);
console.log(`ui-tokens: generated from ${src.sourcePath} (sha256 ${src.sourceSha256.slice(0, 12)}…)`);
