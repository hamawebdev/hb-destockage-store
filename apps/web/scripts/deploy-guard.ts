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
// `--dry-run` is read from the wrangler process's own argv (Linux /proc). If that cannot be read,
// the run is treated as a real deploy (fail closed).
//
// Origins are read from everything the site publishes: sitemap.xml <loc>/hreflang links,
// robots.txt `Sitemap:`, and every page's canonical, hreflang alternate and og:url.
//
// Usage: node scripts/deploy-guard.ts [distDir]   (default ../storefront/dist)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEPLOY_COMMANDS = new Set(['deploy', 'versions upload']);

/** Reserved by RFC 2606 / 6761 / 6762 or conventionally non-public. */
const NON_PRODUCTION_TLDS = ['example', 'test', 'invalid', 'localhost', 'local', 'internal', 'lan', 'home', 'arpa', 'corp', 'onion'];
const NON_PRODUCTION_HOSTS = new Set(['localhost', 'example.com', 'example.net', 'example.org']);

/** Why this origin must not be deployed; empty when it is a plausible production origin. */
export function originProblems(origin: string): string[] {
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
export function checkDist(dist: string): string[] {
  if (!existsSync(dist)) return [`storefront build not found: ${dist}`];
  const origins = publishedOrigins(dist);
  if (origins.size === 0) return [`no absolute site URL found in ${dist} (sitemap.xml, canonical links): cannot verify the origin`];
  const problems = [...origins].flatMap(originProblems);
  if (origins.size > 1) problems.push(`more than one site origin published: ${[...origins].sort().join(', ')}`);
  return problems;
}

/** Argv of this process's ancestors (Linux /proc); null when it cannot be read. */
export function ancestorArgv(maxDepth = 12): string[][] | null {
  if (!existsSync('/proc/self/stat')) return null;
  const out: string[][] = [];
  let pid = process.ppid;
  try {
    for (let i = 0; i < maxDepth && pid > 1; i++) {
      out.push(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a !== ''));
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
  } catch {
    return out.length > 0 ? out : null;
  }
  return out;
}

export type Mode = 'local' | 'dry-run' | 'deploy';

/** What kind of wrangler run started this build. Unknown dry-run state ⇒ 'deploy' (fail closed). */
export function runMode(env: { WRANGLER_COMMAND?: string | undefined }, ancestors: string[][] | null): Mode {
  const cmd = env.WRANGLER_COMMAND;
  if (cmd === undefined || !DEPLOY_COMMANDS.has(cmd)) return 'local';
  if (ancestors === null) return 'deploy';
  const wrangler = ancestors.find((argv) => argv.some((a) => /wrangler/.test(a)) && argv.includes(cmd.split(' ')[0]!));
  if (wrangler === undefined) return 'deploy';
  return wrangler.some((a) => a === '--dry-run' || a === '--dry-run=true') ? 'dry-run' : 'deploy';
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../../storefront/dist'));
  const mode = runMode(process.env, ancestorArgv());
  if (mode === 'local') {
    console.log(`deploy-guard: WRANGLER_COMMAND=${process.env['WRANGLER_COMMAND'] ?? '(unset)'}: local run, site-origin check skipped`);
  } else {
    const problems = checkDist(dist);
    if (problems.length === 0) {
      console.log(`deploy-guard: ${mode}: site origin OK (${[...publishedOrigins(dist)].join(', ')})`);
    } else if (mode === 'dry-run') {
      console.log(`deploy-guard: dry-run: this build could NOT be deployed for real:\n  ${problems.join('\n  ')}`);
    } else {
      console.error(
        `deploy-guard: REFUSING to deploy apps/storefront/dist: it was not built for the production origin.\n  ${problems.join('\n  ')}\n` +
          '  Rebuild the storefront with HB_SITE_ORIGIN=https://<production domain> (and the production snapshot), then deploy again.',
      );
      process.exit(1);
    }
  }
}
