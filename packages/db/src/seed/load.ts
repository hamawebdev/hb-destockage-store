// DB-3: read the repo's data/ directories into a SeedInput. Node only (fs).
//   data/geo/{wilayas,communes,fees.seed}.json     (geo)
//   data/catalog/** via data/catalog/validate.mjs   (seed: validateSeed, loadSeed, toSnapshot)
//   data/content/<key>.json                         (brand)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SeedCategory, SeedCommune, SeedContentPage, SeedFee, SeedInput, SeedProduct, SeedWilaya } from './build.ts';
import { DEV_ADMIN_USERS } from './dev-users.ts';

// No parameter properties: `node src/seed/cli.ts` runs with Node's strip-only TypeScript.
export class SeedValidationError extends Error {
  readonly issues: readonly { path: string; message: string }[];
  constructor(issues: readonly { path: string; message: string }[]) {
    super(`seed catalogue has ${issues.length} issue(s):\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
    this.issues = issues;
  }
}

interface CatalogModule {
  validateSeed(root: string): { path: string; message: string }[];
  loadSeed(root: string): unknown;
  toSnapshot(seed: unknown): { categories: SeedCategory[]; products: SeedProduct[]; settings: Record<string, unknown> };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export async function loadSeedInput(root: string): Promise<{ input: SeedInput; photosDir: string }> {
  const geo = join(root, 'data', 'geo');
  const wilayas = readJson<SeedWilaya[]>(join(geo, 'wilayas.json'));
  const communes = readJson<SeedCommune[]>(join(geo, 'communes.json'));
  const fees = readJson<SeedFee[]>(join(geo, 'fees.seed.json'));

  const catalog = (await import(pathToFileURL(join(root, 'data', 'catalog', 'validate.mjs')).href)) as CatalogModule;
  const issues = catalog.validateSeed(root);
  if (issues.length > 0) throw new SeedValidationError(issues);
  const snapshot = catalog.toSnapshot(catalog.loadSeed(root));

  const contentDir = join(root, 'data', 'content');
  const contentPages = readdirSync(contentDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<SeedContentPage>(join(contentDir, f)));

  return {
    input: {
      wilayas,
      communes,
      fees,
      categories: snapshot.categories,
      products: snapshot.products,
      settings: snapshot.settings,
      contentPages,
      adminUsers: DEV_ADMIN_USERS,
    },
    photosDir: join(root, 'data', 'photos'),
  };
}
