// DB-3 (lead ruling via rev-e): the seed writes invented data (placeholder fees, placeholder
// products, dev admin users). It must never reach a remote or production database. In production
// every wilaya starts with no fee row (= unavailable) until the owner sets a real fee.

/** The local-only database_id shared by every wrangler config in this repo. */
export const LOCAL_DATABASE_ID = '00000000-0000-4000-8000-000000000d1b';

export interface SeedTarget {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `database_id` of the D1 binding in the wrangler config the seed will use. */
  readonly databaseId: string | undefined;
  /** Raw text of that wrangler config (JSONC), to refuse bindings marked `"remote": true`. */
  readonly configText?: string;
}

/** Returns the reasons the seed must refuse to run; empty = local development target. */
export function seedRefusals(t: SeedTarget): string[] {
  const out: string[] = [];
  if (t.argv.some((a) => a === '--remote' || a.startsWith('--remote='))) {
    out.push('--remote given: the seed only writes the LOCAL D1');
  }
  // DB-3 r1 (rev-b): an environment can carry remote bindings; the seed never selects one.
  if (t.argv.some((a) => a === '--env' || a === '-e' || a.startsWith('--env=') || a.startsWith('-e='))) {
    out.push('--env given: the seed uses only the local top-level bindings');
  }
  if (t.configText !== undefined && /"remote"\s*:\s*true/.test(stripJsonComments(t.configText))) {
    out.push('the wrangler config marks a binding "remote": true (D1 or R2 would be the real one)');
  }
  if (t.databaseId !== LOCAL_DATABASE_ID) {
    out.push(`database_id is ${JSON.stringify(t.databaseId)}, not the local placeholder ${LOCAL_DATABASE_ID}`);
  }
  if (t.env.ENV !== undefined && t.env.ENV !== 'development') {
    out.push(`ENV=${t.env.ENV}: the seed runs only when ENV is unset or "development"`);
  }
  if (t.env.NODE_ENV === 'production') out.push('NODE_ENV=production');
  if (t.env.CLOUDFLARE_ENV !== undefined && t.env.CLOUDFLARE_ENV !== '' && t.env.CLOUDFLARE_ENV !== 'development') {
    out.push(`CLOUDFLARE_ENV=${t.env.CLOUDFLARE_ENV}`);
  }
  return out;
}

/** Reads `database_id` of the first d1_databases entry from a wrangler.jsonc text (comments allowed). */
export function databaseIdFromWranglerJsonc(text: string): string | undefined {
  const m = /"d1_databases"\s*:\s*\[[\s\S]*?"database_id"\s*:\s*"([^"]*)"/.exec(stripJsonComments(text));
  return m?.[1];
}

function stripJsonComments(text: string): string {
  // Line comments outside strings only (wrangler.jsonc here has no block comments in values).
  return text
    .split('\n')
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== '\\') inStr = !inStr;
        if (!inStr && ch === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}
