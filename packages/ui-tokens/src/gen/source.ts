// Locates the brand token source. brand/tokens.json is the source of truth; until BRAND-1 is on
// main this package carries a verbatim copy of brand's committed file (provisional.tokens.json).
// Once brand/tokens.json exists in the checkout the provisional copy is ignored (and deleted).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrandTokens } from './build-tokens.ts';

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = join(PKG_DIR, '..', '..');
export const BRAND_PATH = join(REPO_DIR, 'brand', 'tokens.json');
export const PROVISIONAL_PATH = join(PKG_DIR, 'src', 'gen', 'provisional.tokens.json');
export const CSS_OUT = join(PKG_DIR, 'tokens.css');
export const TS_OUT = join(PKG_DIR, 'src', 'tokens.generated.ts');

export interface Source {
  tokens: BrandTokens;
  sourcePath: string;
  sourceSha256: string;
}

export function readSource(path: string): Source {
  const bytes = readFileSync(path);
  return {
    tokens: JSON.parse(bytes.toString('utf8')) as BrandTokens,
    sourcePath: relative(REPO_DIR, path).split('\\').join('/'),
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function resolveSource(): Source {
  return readSource(existsSync(BRAND_PATH) ? BRAND_PATH : PROVISIONAL_PATH);
}
