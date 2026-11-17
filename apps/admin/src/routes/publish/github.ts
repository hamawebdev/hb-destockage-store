// GitHub Actions client for "Publier" (BOOT-41, D-028). Two calls only: list the pipeline's latest runs on
// main, and start the pipeline in `publish` mode (export production D1 → build the storefront → deploy
// hb-web, docs/DEPLOY.md). Repository, workflow, branch and inputs are fixed here, never taken from the
// request. The token (Worker secret GITHUB_PUBLISH_TOKEN) is used for the Authorization header only: it
// is never rendered, logged, audited or put in an error; errors carry a code.

export const PUBLISH_REPO = 'hamawebdev/hb-destockage-store';
export const PUBLISH_WORKFLOW = 'pipeline.yml';
export const PUBLISH_REF = 'main';
const API = 'https://api.github.com';
/** Outbound call from a page request. */
const TIMEOUT_MS = 8_000;

// Test seam: the admin tests replace the outbound fetch for this module only (never globalThis).
let fetchOverride: typeof fetch | undefined;
export function setGithubFetchForTests(f: typeof fetch | undefined): void {
  fetchOverride = f;
}

/** waiting = not started yet (it will export the catalogue when it starts). */
export type RunState = 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface PipelineRun {
  id: number;
  state: RunState;
  /** manual = started by hand or from this page; push = a code change by the developer. */
  origin: 'manual' | 'push' | 'other';
  createdAt: number;
  updatedAt: number;
}
/** auth = token refused, expired or without access to the repository; unreachable = network/timeout/5xx. */
export type GithubError = 'auth' | 'unreachable' | 'unexpected';
export type GithubResult<T> = { ok: true; value: T } | { ok: false; error: GithubError };

/** The configured token, or null (feature off). */
export function publishToken(env: { GITHUB_PUBLISH_TOKEN?: string | undefined }): string | null {
  const t = env.GITHUB_PUBLISH_TOKEN?.trim() ?? '';
  return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : null;
}

async function call(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<GithubResult<{ status: number; json: unknown }>> {
  const f = fetchOverride ?? fetch;
  let res: Response;
  try {
    res = await f(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'comptoirdeluxe-admin',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, error: 'auth' };
  if (res.status >= 500 || res.status === 429) return { ok: false, error: 'unreachable' };
  if (res.status < 200 || res.status >= 300) return { ok: false, error: 'unexpected' };
  const text = await res.text();
  let json: unknown = null;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: 'unexpected' };
    }
  }
  return { ok: true, value: { status: res.status, json } };
}

const WAITING = new Set(['queued', 'waiting', 'pending', 'requested']);

function stateOf(status: unknown, conclusion: unknown): RunState {
  if (typeof status === 'string' && WAITING.has(status)) return 'waiting';
  if (status === 'in_progress') return 'running';
  if (conclusion === 'success') return 'succeeded';
  if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral' || conclusion === 'stale') return 'cancelled';
  return 'failed';
}

const ms = (s: unknown): number => {
  const n = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** The pipeline's latest runs on main, newest first. */
export async function listRuns(token: string, count = 5): Promise<GithubResult<PipelineRun[]>> {
  const r = await call(token, 'GET', `/repos/${PUBLISH_REPO}/actions/workflows/${PUBLISH_WORKFLOW}/runs?branch=${PUBLISH_REF}&per_page=${count}`);
  if (!r.ok) return r;
  const list = (r.value.json as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(list)) return { ok: false, error: 'unexpected' };
  const runs: PipelineRun[] = [];
  for (const x of list as Record<string, unknown>[]) {
    if (typeof x?.['id'] !== 'number') continue;
    runs.push({
      id: x['id'],
      state: stateOf(x['status'], x['conclusion']),
      origin: x['event'] === 'workflow_dispatch' ? 'manual' : x['event'] === 'push' ? 'push' : 'other',
      createdAt: ms(x['created_at']),
      updatedAt: ms(x['updated_at']),
    });
  }
  return { ok: true, value: runs };
}

/** Starts the pipeline in publish mode on main. GitHub answers 204 with no body. */
export async function dispatchPublish(token: string): Promise<GithubResult<null>> {
  const r = await call(token, 'POST', `/repos/${PUBLISH_REPO}/actions/workflows/${PUBLISH_WORKFLOW}/dispatches`, { ref: PUBLISH_REF, inputs: { mode: 'publish' } });
  return r.ok ? { ok: true, value: null } : r;
}
