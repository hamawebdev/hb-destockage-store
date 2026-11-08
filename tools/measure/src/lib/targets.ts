/** Shared option handling for the browser tools (shots, axe): which URLs, which server. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DIST } from './paths.ts';
import { discover, targetsFromUrls, type TemplateTarget } from '../templates.ts';
import { externalServer, startServer, type ServeMode, type Server } from '../serve.ts';

export const TARGET_OPTIONS = {
  'dist': { type: 'string' }, 'base-url': { type: 'string' }, 'serve': { type: 'string' }, 'port': { type: 'string' },
  'url': { type: 'string', multiple: true }, 'urls': { type: 'string' }, 'template': { type: 'string', multiple: true },
  'out': { type: 'string' }, 'help': { type: 'boolean', short: 'h' },
} as const;

export const TARGET_USAGE = `  --dist <dir>        built site (default apps/storefront/dist); templates are discovered from it
  --base-url <url>    use an already running server instead of starting one
  --serve <mode>      auto (wrangler dev of apps/web if present, else static) | static | wrangler
  --port <n>          port for the server it starts
  --url <path>        only this path (repeatable); --urls <file> one path per line
  --template <name>   only this template (repeatable)
  --out <dir>         output directory`;

export interface TargetArgs {
  dist?: string | undefined; 'base-url'?: string | undefined; serve?: string | undefined; port?: string | undefined;
  url?: string[] | undefined; urls?: string | undefined; template?: string[] | undefined;
}

export function resolveTargets(a: TargetArgs): { dist: string; targets: TemplateTarget[]; skipped: Array<{ url: string; reason: string }>; errors: string[] } {
  const dist = path.resolve(a.dist ?? DEFAULT_DIST);
  const errors: string[] = [];
  let targets: TemplateTarget[];
  let skipped: Array<{ url: string; reason: string }> = [];
  if (a.url?.length || a.urls) {
    const list = [...(a.url ?? []), ...(a.urls ? readFileSync(a.urls, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean) : [])];
    targets = targetsFromUrls(list);
  } else if (!existsSync(dist)) {
    return { dist, targets: [], skipped, errors: [`dist not found: ${dist} (build first, or pass --url/--urls with --base-url)`] };
  } else {
    const reg = discover(dist);
    targets = reg.targets;
    skipped = reg.skipped;
    errors.push(...reg.errors);
  }
  if (a.template?.length) targets = targets.filter((t) => a.template?.includes(t.template));
  if (!targets.length) errors.push('no URL to visit');
  return { dist, targets, skipped, errors };
}

export async function serverFor(a: TargetArgs, dist: string, defaultPort: number, logFile?: string): Promise<Server> {
  if (a['base-url']) return externalServer(a['base-url']);
  const mode = (a.serve ?? 'auto') as ServeMode;
  if (!['auto', 'static', 'wrangler'].includes(mode)) throw new Error(`bad --serve ${mode}`);
  return startServer({ mode, dist, port: Number(a.port ?? defaultPort), ...(logFile ? { logFile } : {}) });
}
