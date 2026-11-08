// WEB-7: refuses a real `wrangler deploy` of a storefront build whose site origin is not a production
// one: http, localhost, an IP literal, a non-default port, or a reserved/test domain (.example, .test,
// .invalid, .localhost, .local, .internal, …). After the batch merge, root `npm run build` builds
// the seed with HB_SITE_ORIGIN=http://localhost:8787 for clean-checkout checks, so
// apps/storefront/dist can hold localhost canonicals; shipping that would publish them.
//
// Runs as the first step of wrangler's build command (wrangler.jsonc "build.command"), the only
// hook a manual `wrangler deploy` runs. Wrangler tells the build which command started it in
// WRANGLER_COMMAND ("dev", "deploy", "versions upload", …).
//   - dev / unset (script run by hand)              → no check (local work)
//   - deploy --dry-run, versions upload --dry-run    → checked and reported, never fails (local checks, the gate)
//   - deploy, versions upload (real)                 → checked; any problem ⇒ exit 1, wrangler aborts
// `--dry-run` / `--temporary` are read from the wrangler process's own argv (Linux /proc) and count
// only in their unambiguous forms (see flagOn); anything else is a real deploy (fail closed). A
// workers.dev origin passes only with `--temporary`. An `--assets <dir>` override is the build checked.
//
// Origins are read from everything the site publishes: sitemap.xml <loc>/hreflang links,
// robots.txt `Sitemap:`, and every page's canonical, hreflang alternate and og:url.
//
// Usage: node scripts/deploy-guard.ts [distDir]   (default ../storefront/dist)

import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEPLOY_COMMANDS = new Set(['deploy', 'versions upload']);

/** Reserved by RFC 2606 / 6761 / 6762 or conventionally non-public. */
const NON_PRODUCTION_TLDS = ['example', 'test', 'invalid', 'localhost', 'local', 'internal', 'lan', 'home', 'arpa', 'corp', 'onion'];
const NON_PRODUCTION_HOSTS = new Set(['localhost', 'example.com', 'example.net', 'example.org']);

/** Why this origin must not be deployed; empty when it is a plausible production origin. */
export function originProblems(origin: string, opts: { allowWorkersDev?: boolean } = {}): string[] {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return [`not a URL: ${origin}`];
  }
  const out: string[] = [];
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.protocol !== 'https:') out.push(`${origin}: not https`);
  if (u.port !== '') out.push(`${origin}: non-default port ${u.port}`);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) out.push(`${origin}: IP literal`);
  else if (NON_PRODUCTION_HOSTS.has(host)) out.push(`${origin}: ${host} is not a production host`);
  else {
    const tld = host.split('.').pop() ?? '';
    if (!host.includes('.')) out.push(`${origin}: single-label host`);
    else if (NON_PRODUCTION_TLDS.includes(tld)) out.push(`${origin}: .${tld} is a reserved/non-public domain`);
    // A workers.dev host is what a `wrangler deploy --temporary` measurement gets; never production.
    else if ((host === 'workers.dev' || host.endsWith('.workers.dev')) && opts.allowWorkersDev !== true) {
      out.push(`${origin}: workers.dev is allowed only for \`wrangler deploy --temporary\``);
    }
  }
  return out;
}

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full));
    else if (name.endsWith('.html')) out.push(full);
  }
  return out;
}

const PAGE_URL_RE = /<(?:link\b[^>]*\brel\s*=\s*["'](?:canonical|alternate)["'][^>]*\bhref|meta\b[^>]*\bproperty\s*=\s*["']og:url["'][^>]*\bcontent)\s*=\s*["']([^"']+)["']/gi;
const LINK_HREF_FIRST_RE = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["'](?:canonical|alternate)["']/gi;

/** Every absolute origin the build publishes. */
export function publishedOrigins(dist: string): Set<string> {
  const urls: string[] = [];
  const sitemap = join(dist, 'sitemap.xml');
  if (existsSync(sitemap)) {
    const xml = readFileSync(sitemap, 'utf8');
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) urls.push(m[1]!);
    for (const m of xml.matchAll(/\bhref\s*=\s*["']([^"']+)["']/g)) urls.push(m[1]!);
  }
  const robots = join(dist, 'robots.txt');
  if (existsSync(robots)) {
    for (const m of readFileSync(robots, 'utf8').matchAll(/^\s*sitemap:\s*(\S+)/gim)) urls.push(m[1]!);
  }
  for (const f of htmlFiles(dist)) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(PAGE_URL_RE)) urls.push(m[1]!);
    for (const m of html.matchAll(LINK_HREF_FIRST_RE)) urls.push(m[1]!);
  }
  const origins = new Set<string>();
  for (const raw of urls) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue; // relative links carry no origin
    try {
      origins.add(new URL(raw).origin);
    } catch {
      origins.add(raw);
    }
  }
  return origins;
}

/** Problems that make this build undeployable (empty = OK). */
export function checkDist(dist: string, opts: { allowWorkersDev?: boolean } = {}): string[] {
  if (!existsSync(dist)) return [`storefront build not found: ${dist}`];
  const origins = publishedOrigins(dist);
  if (origins.size === 0) return [`no absolute site URL found in ${dist} (sitemap.xml, canonical links): cannot verify the origin`];
  const problems = [...origins].flatMap((o) => originProblems(o, opts));
  if (origins.size > 1) problems.push(`more than one site origin published: ${[...origins].sort().join(', ')}`);
  return problems;
}

export interface Ancestor {
  readonly argv: readonly string[];
  /** The process's working directory (resolves a relative `--assets <dir>`); null when unreadable. */
  readonly cwd: string | null;
}

/** This process's ancestors (Linux /proc); null when they cannot be read. */
export function ancestors(maxDepth = 12): Ancestor[] | null {
  if (!existsSync('/proc/self/stat')) return null;
  const out: Ancestor[] = [];
  let pid = process.ppid;
  try {
    for (let i = 0; i < maxDepth && pid > 1; i++) {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a !== '');
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        cwd = null;
      }
      out.push({ argv, cwd });
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
  } catch {
    return out.length > 0 ? out : null;
  }
  return out;
}

export type Mode = 'local' | 'dry-run' | 'temporary' | 'deploy';

/**
 * A boolean flag is ON only when it is unambiguous: exactly one occurrence, given as the bare flag
 * (last token, or followed by another `-`-prefixed token), `--flag true` or `--flag=true`. Anything
 * else (`--flag false|0|no|…`, `--flag=false`, `--no-flag`, the camelCase alias, repeats, conflicts)
 * is OFF, so a dry-run or temporary request that wrangler might read differently is treated as a
 * real deploy and fully checked (fail safe; rev-d WEB-7 r1: yargs reads `--dry-run false` as false).
 */
export function flagOn(argv: readonly string[], kebab: string): boolean {
  const camel = kebab.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
  const names = new Set([`--${kebab}`, `--${camel}`, `--no-${kebab}`, `--no${camel[0]!.toUpperCase()}${camel.slice(1)}`]);
  const hits: boolean[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const [name, value] = tok.includes('=') ? [tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)] : [tok, undefined];
    if (!names.has(name)) continue;
    if (name.startsWith('--no')) {
      hits.push(false);
      continue;
    }
    if (name !== `--${kebab}`) {
      hits.push(false); // camelCase alias: possible, but not a form we rely on
      continue;
    }
    if (value !== undefined) {
      hits.push(value === 'true');
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) hits.push(true);
    else if (next === 'true') {
      hits.push(true);
      i++;
    } else hits.push(false); // `--dry-run false`, `--dry-run 0`, `--dry-run no`, `--dry-run <anything>`
  }
  return hits.length === 1 && hits[0] === true;
}

/** `--assets <dir>` / `--assets=<dir>` on the wrangler command line, if any. */
export function assetsOverride(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith('--assets=')) return tok.slice('--assets='.length);
    if (tok === '--assets') return argv[i + 1] ?? '';
  }
  return undefined;
}

/** The wrangler process that started this build (the nearest ancestor running the command). */
export function findWrangler(env: { WRANGLER_COMMAND?: string | undefined }, chain: Ancestor[] | null): Ancestor | null {
  const cmd = env.WRANGLER_COMMAND;
  if (cmd === undefined || chain === null) return null;
  return chain.find((a) => a.argv.some((x) => /wrangler/.test(x)) && a.argv.includes(cmd.split(' ')[0]!)) ?? null;
}

/** What kind of wrangler run started this build. Unknown ⇒ 'deploy' (fail closed). */
export function runMode(env: { WRANGLER_COMMAND?: string | undefined }, chain: Ancestor[] | null): Mode {
  const cmd = env.WRANGLER_COMMAND;
  if (cmd === undefined || !DEPLOY_COMMANDS.has(cmd)) return 'local';
  const w = findWrangler(env, chain);
  if (w === null) return 'deploy';
  if (flagOn(w.argv, 'dry-run')) return 'dry-run';
  if (flagOn(w.argv, 'temporary')) return 'temporary';
  return 'deploy';
}

/** The storefront build this deploy would ship: `--assets` override (resolved), else the default. */
export function distFor(defaultDist: string, w: Ancestor | null): { dist: string } | { error: string } {
  const override = w === null ? undefined : assetsOverride(w.argv);
  if (override === undefined) return { dist: defaultDist };
  if (override === '') return { error: '--assets given without a directory' };
  if (isAbsolute(override)) return { dist: override };
  if (w?.cwd == null) return { error: `cannot resolve --assets ${override}: wrangler's working directory is unreadable` };
  return { dist: resolve(w.cwd, override) };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const defaultDist = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../../storefront/dist'));
  const chain = ancestors();
  const mode = runMode(process.env, chain);
  if (mode === 'local') {
    console.log(`deploy-guard: WRANGLER_COMMAND=${process.env['WRANGLER_COMMAND'] ?? '(unset)'}: local run, site-origin check skipped`);
  } else {
    const target = distFor(defaultDist, findWrangler(process.env, chain));
    const dist = 'dist' in target ? target.dist : defaultDist;
    const problems = 'error' in target ? [target.error] : checkDist(dist, { allowWorkersDev: mode === 'temporary' });
    if (problems.length === 0) {
      console.log(`deploy-guard: ${mode}: site origin OK (${[...publishedOrigins(dist)].join(', ')})`);
    } else if (mode === 'dry-run') {
      console.log(`deploy-guard: dry-run: this build could NOT be deployed for real:\n  ${problems.join('\n  ')}`);
    } else {
      console.error(
        `deploy-guard: REFUSING to ${mode === 'temporary' ? 'deploy --temporary' : 'deploy'} ${dist}: it was not built for the production origin.\n  ${problems.join('\n  ')}\n` +
          (mode === 'temporary'
            ? '  For a temporary deploy, build the storefront with HB_SITE_ORIGIN=https://<name>.workers.dev (the host it will get).'
            : '  Rebuild the storefront with HB_SITE_ORIGIN=https://<production domain> (and the production snapshot), then deploy again.'),
      );
      process.exit(1);
    }
  }
}
