/**
 * CAT-2 — snapshot sources (Node only: import as `@hb/catalog/sources`, never from browser code).
 *
 *  - `fromSeed(repoRoot)`: assembles a snapshot from the repository's `data/`:
 *      data/catalog/categories.json      SnapshotCategory[]               (seed)
 *      data/catalog/settings.json        SnapshotSettings                  (seed)
 *      data/catalog/products/*.json      one SnapshotProduct per file      (seed)
 *      data/geo/index.mjs loadWilayas()  the 69 wilayas (or wilayas.json)  (geo)
 *      data/content/*.json               one SnapshotContentPage per file  (brand)
 *    then runs seed's own checks (`data/catalog/validate.mjs` → `validateSeed`) when present, and
 *    `parseSnapshot` (structure + integrity). Any problem throws `SnapshotError` naming the file.
 *  - `fromExport(file)`: reads the JSON `db`'s `exportCatalogSnapshot` wrote for the publish
 *    pipeline and validates it.
 *  - `loadSnapshot()`: what the storefront build calls. `HB_SNAPSHOT` = `fixture` (default),
 *    `seed`, or a path to an export JSON.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureSnapshot } from './fixtures/snapshot.ts';
import { parseSnapshot, SnapshotError, type SnapshotIssue } from './schema.ts';
import { SNAPSHOT_VERSION, type CatalogSnapshot, type Localized, type SnapshotWilaya, type StringTable } from './types.ts';

export interface SeedOptions {
  /** Epoch ms for `meta.generatedAt`. Default: `SOURCE_DATE_EPOCH` (s) if set, else now. */
  readonly generatedAt?: number;
  /**
   * Allow missing `data/geo/wilayas.json` and `data/content/` (empty lists). For development
   * before those areas land; a production build never sets it.
   */
  readonly partial?: boolean;
  /** Run `data/catalog/validate.mjs` → `validateSeed(repoRoot)` when it exists. Default true. */
  readonly seedValidation?: boolean;
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new SnapshotError([{ path: file, message: `cannot read: ${(e as Error).message}` }], file);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new SnapshotError([{ path: file, message: `invalid JSON: ${(e as Error).message}` }], file);
  }
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => join(dir, n));
}

function defaultGeneratedAt(): number {
  const sde = process.env['SOURCE_DATE_EPOCH'];
  return sde && /^\d+$/.test(sde) ? Number(sde) * 1000 : Date.now();
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Accepts geo's wilaya rows in the shapes we may meet and maps them to `SnapshotWilaya`:
 * `{code, name:{ar,fr}, courierCode}`, `{code, nameAr, nameFr, courierCode}`,
 * `{code, name_ar, name_fr, courier_code}`. Either a bare array or `{wilayas: [...]}`.
 * Anything unrecognised is passed through so the validator reports it precisely.
 */
export function toSnapshotWilayas(input: unknown): unknown {
  const rows = isRecord(input) && Array.isArray(input['wilayas']) ? input['wilayas'] : input;
  if (!Array.isArray(rows)) return rows;
  return rows.map((r: unknown): unknown => {
    if (!isRecord(r)) return r;
    const name = isRecord(r['name'])
      ? r['name']
      : { ar: r['nameAr'] ?? r['name_ar'], fr: r['nameFr'] ?? r['name_fr'] };
    const courier = r['courierCode'] ?? r['courier_code'] ?? null;
    const out: SnapshotWilaya = {
      code: r['code'] as number,
      name: { ar: (name as Record<string, unknown>)['ar'] as string, fr: (name as Record<string, unknown>)['fr'] as string },
      courierCode: courier === null ? null : String(courier),
    };
    return out;
  });
}

/** geo's `data/geo/index.mjs` → `loadWilayas()` when present, else `data/geo/wilayas.json`. */
async function loadGeoWilayas(root: string, partial: boolean): Promise<unknown> {
  const mod = join(root, 'data/geo/index.mjs');
  if (existsSync(mod)) {
    const m = (await import(pathToFileURL(mod).href)) as { loadWilayas?: () => unknown };
    if (typeof m.loadWilayas === 'function') return m.loadWilayas();
  }
  const file = join(root, 'data/geo/wilayas.json');
  if (existsSync(file) || !partial) return readJson(file);
  return [];
}

async function runSeedValidation(repoRoot: string): Promise<void> {
  const file = join(repoRoot, 'data/catalog/validate.mjs');
  if (!existsSync(file)) return;
  const mod = (await import(pathToFileURL(file).href)) as { validateSeed?: (root: string) => unknown };
  if (typeof mod.validateSeed !== 'function') return;
  const raw = await mod.validateSeed(repoRoot);
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0) return;
  const issues: SnapshotIssue[] = list.map((i: unknown) =>
    isRecord(i)
      ? { path: String(i['path'] ?? i['file'] ?? 'data/catalog'), message: String(i['message'] ?? JSON.stringify(i)) }
      : { path: 'data/catalog', message: String(i) },
  );
  throw new SnapshotError(issues, 'data/catalog/validate.mjs');
}

export async function fromSeed(repoRoot: string, opts: SeedOptions = {}): Promise<CatalogSnapshot> {
  const root = resolve(repoRoot);
  const at = (p: string): string => join(root, p);
  if (opts.seedValidation !== false) await runSeedValidation(root);

  const categories = await readJson(at('data/catalog/categories.json'));
  const settings = await readJson(at('data/catalog/settings.json'));
  const productFiles = await jsonFilesIn(at('data/catalog/products'));
  const products = await Promise.all(productFiles.map(readJson));

  const contentDir = at('data/content');
  const wilayas = toSnapshotWilayas(await loadGeoWilayas(root, opts.partial === true));
  let contentPages: unknown[] = [];
  if (existsSync(contentDir)) contentPages = await Promise.all((await jsonFilesIn(contentDir)).map(readJson));
  else if (!opts.partial) throw new SnapshotError([{ path: contentDir, message: 'missing directory' }], 'data/content');

  const assembled = {
    meta: { version: SNAPSHOT_VERSION, source: 'seed', generatedAt: opts.generatedAt ?? defaultGeneratedAt(), publishRunId: null },
    categories,
    products,
    contentPages,
    settings,
    wilayas,
  };
  try {
    return parseSnapshot(assembled, 'data/', { requireAllWilayas: opts.partial !== true });
  } catch (e) {
    if (!(e instanceof SnapshotError)) throw e;
    // Point issues at the file they came from: products[3] → data/catalog/products/<file>.json.
    const issues = e.issues.map((i) => {
      const m = /^products\.(\d+)(.*)$/.exec(i.path) ?? /^products\[(\d+)\](.*)$/.exec(i.path);
      const f = m ? productFiles[Number(m[1])] : undefined;
      return f ? { path: `${f.slice(root.length + 1)}${m?.[2] ?? ''}`, message: i.message } : i;
    });
    throw new SnapshotError(issues, 'data/');
  }
}

export async function fromExport(file: string): Promise<CatalogSnapshot> {
  return parseSnapshot(await readJson(file), file);
}

/**
 * Storefront entry point. `HB_SNAPSHOT`:
 *  - unset or `fixture` → the CAT-1 fixture (fast, deterministic; CI default until seed lands);
 *  - `seed` → `fromSeed(repoRoot)` (`HB_SNAPSHOT_PARTIAL=1` allows missing geo/content);
 *  - anything else → a path (absolute, or relative to `repoRoot`) to an export JSON.
 */
export async function loadSnapshot(
  opts: { readonly repoRoot?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<CatalogSnapshot> {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? findRepoRoot(process.cwd());
  const which = env['HB_SNAPSHOT'] ?? 'fixture';
  if (which === 'fixture') return parseSnapshot(fixtureSnapshot, 'fixture', { requireAllWilayas: false });
  if (which === 'seed') return fromSeed(repoRoot, { partial: env['HB_SNAPSHOT_PARTIAL'] === '1' });
  return fromExport(isAbsolute(which) ? which : join(repoRoot, which));
}

/** Nearest ancestor holding a `package.json` with `workspaces` (the monorepo root). */
export function findRepoRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && existsSync(join(dir, 'packages')) && existsSync(join(dir, 'apps'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/**
 * Brand UI strings: `brand/copy/strings.{ar,fr}.json`, flat dotted keys → string. Keys starting
 * with `_meta.` are notes and are dropped. Throws if a file is missing or a value is not a string.
 */
export async function loadStrings(repoRoot: string): Promise<Localized<StringTable>> {
  const one = async (lang: 'ar' | 'fr'): Promise<StringTable> => {
    const file = join(resolve(repoRoot), `brand/copy/strings.${lang}.json`);
    const raw = await readJson(file);
    if (!isRecord(raw)) throw new SnapshotError([{ path: file, message: 'expected a flat object' }], file);
    const issues: SnapshotIssue[] = [];
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(raw)) {
      if (k.startsWith('_meta.')) continue;
      if (typeof val !== 'string') issues.push({ path: `${file}#${k}`, message: 'value must be a string' });
      else out[k] = val;
    }
    if (issues.length) throw new SnapshotError(issues, file);
    return out;
  };
  return { ar: await one('ar'), fr: await one('fr') };
}
