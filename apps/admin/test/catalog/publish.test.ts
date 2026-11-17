// /publish (BOOT-41, D-028): start the pipeline's publish mode on GitHub from the admin. A fake GitHub API
// behind the module's fetch seam: no network, and the only "token" is the stand-in below.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { setGithubFetchForTests } from '../../src/routes/publish/github.ts';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { idAndLabelProblems } from './html.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const TOKEN = 'github_pat_TESTONLY_0000000000aaaaaaaaaabbbbbbbbbb';
const RUNS = '/repos/hamawebdev/hb-destockage-store/actions/workflows/pipeline.yml/runs';
const DISPATCH = '/repos/hamawebdev/hb-destockage-store/actions/workflows/pipeline.yml/dispatches';

interface Fake {
  runs: { id: number; status: string; conclusion: string | null; event: string; created_at: string; updated_at: string }[];
  calls: { method: string; path: string; auth: string | null; body: unknown }[];
  /** Status the API answers with (200/204 when unset). */
  failWith: number | null;
  down: boolean;
}
let gh: Fake;
let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h?.close());
beforeEach(() => {
  gh = { runs: [], calls: [], failWith: null, down: false };
  setGithubFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    gh.calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (gh.down) throw new TypeError('network down');
    if (gh.failWith !== null) return new Response('{"message":"x"}', { status: gh.failWith });
    if (url.host !== 'api.github.com') return new Response('', { status: 404 });
    if ((init?.method ?? 'GET') === 'GET' && url.pathname === RUNS) return Response.json({ total_count: gh.runs.length, workflow_runs: gh.runs });
    if (init?.method === 'POST' && url.pathname === DISPATCH) {
      gh.runs.unshift({ id: 900 + gh.runs.length, status: 'queued', conclusion: null, event: 'workflow_dispatch', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch);
  h.env.GITHUB_PUBLISH_TOKEN = TOKEN;
});
afterEach(() => setGithubFetchForTests(undefined));

const run = (id: number, status: string, conclusion: string | null, event = 'workflow_dispatch') =>
  ({ id, status, conclusion, event, created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:08:00Z' });
const requests = () => h.db.prepare("select actor_email, entity, after from audit_log where action = 'publish.request' order by id").all<{ actor_email: string; entity: string; after: string }>().then((x) => x.results);
const page = async (email: string = USERS.owner) => (await h.as(email, '/publish')).text();

describe('publish page', () => {
  test('explains, offers the button and lists the latest runs (FR); valid labels and ids', async () => {
    gh.runs = [run(3, 'completed', 'success'), run(2, 'completed', 'failure', 'push'), run(1, 'in_progress', null)];
    const html = await page();
    expect(html).toContain('Publier la boutique');
    expect(html).toContain('environ 10 minutes');
    expect(html).toMatch(/<form[^>]*action="\/publish"/);
    expect(html).toContain('Terminée');
    expect(html).toContain('Mise à jour technique');
    expect(html).toContain('data-publish-busy');
    expect(html).not.toContain(TOKEN.slice(12));
    expect(idAndLabelProblems(html)).toEqual([]);
    expect(gh.calls[0]).toMatchObject({ method: 'GET', path: `${RUNS}?branch=main&per_page=5`, auth: `Bearer ${TOKEN}` });
  });

  test('Arabic page', async () => {
    await h.db.prepare("update admin_users set ui_lang = 'ar' where email = ?").bind(USERS.content).run();
    try {
      const html = await page(USERS.content);
      expect(html).toContain('نشر المتجر');
    } finally {
      await h.db.prepare("update admin_users set ui_lang = 'fr' where email = ?").bind(USERS.content).run();
    }
  });

  test('no token: the page says publishing is not enabled, no button, no GitHub call', async () => {
    delete h.env.GITHUB_PUBLISH_TOKEN;
    const html = await page();
    expect(html).toContain('pas encore activée');
    expect(html).not.toMatch(/<form[^>]*action="\/publish"/);
    expect(gh.calls).toEqual([]);
  });

  test('a refused token says so without breaking the page', async () => {
    gh.failWith = 401;
    const res = await h.as(USERS.owner, '/publish');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('GitHub refuse la clé de publication');
  });
});

describe('publish request', () => {
  test('starts the pipeline in publish mode on main, audited, then shows "demandée"', async () => {
    gh.runs = [run(1, 'completed', 'success')];
    const res = await postAs(h, USERS.content, '/publish', {});
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/publish?m=requested');
    const post = gh.calls.find((x) => x.method === 'POST')!;
    expect(post).toMatchObject({ path: DISPATCH, auth: `Bearer ${TOKEN}`, body: { ref: 'main', inputs: { mode: 'publish' } } });
    const rows = await requests();
    expect(rows.at(-1)).toMatchObject({ actor_email: USERS.content, entity: 'publish_runs' });
    expect(JSON.parse(rows.at(-1)!.after)).toEqual({ workflow: 'pipeline.yml', ref: 'main', mode: 'publish' });
    expect(JSON.stringify(rows)).not.toContain(TOKEN.slice(12));
    expect(await (await h.as(USERS.content, '/publish?m=requested')).text()).toContain('Publication demandée');
    // The dashboard tile shows it.
    expect(await (await h.as(USERS.owner, '/dashboard')).text()).toContain('Demandée');
  });

  test('a second click while that run waits to start sends nothing (it already covers every change)', async () => {
    gh.runs = [run(5, 'queued', null)];
    const before = (await requests()).length;
    const res = await postAs(h, USERS.owner, '/publish', {});
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('déjà en attente');
    expect(gh.calls.some((x) => x.method === 'POST')).toBe(false);
    expect((await requests()).length).toBe(before);
  });

  test('while a run is in progress, a new request is queued behind it', async () => {
    gh.runs = [run(6, 'in_progress', null)];
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(303);
    expect(gh.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
  });

  test.each([
    [401, 503, 'GitHub refuse la clé'],
    [500, 502, 'GitHub ne répond pas'],
  ])('GitHub %i: nothing requested, nothing audited, a clear message', async (code, status, text) => {
    gh.failWith = code;
    const before = (await requests()).length;
    const res = await postAs(h, USERS.owner, '/publish', {});
    expect(res.status).toBe(status);
    expect(await res.text()).toContain(text);
    expect((await requests()).length).toBe(before);
  });

  test('network down: nothing requested', async () => {
    gh.down = true;
    const res = await postAs(h, USERS.owner, '/publish', {});
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('GitHub ne répond pas');
  });

  test('no token: refused with the explanation, no GitHub call', async () => {
    delete h.env.GITHUB_PUBLISH_TOKEN;
    const res = await postAs(h, USERS.owner, '/publish', {});
    expect(res.status).toBe(503);
    expect(gh.calls).toEqual([]);
  });

  test('roles without publish.run cannot see or use it', async () => {
    for (const email of [USERS.confirmer, USERS.logistics]) {
      expect((await h.as(email, '/publish')).status).toBe(403);
      expect((await postAs(h, email, '/publish', {})).status).toBe(403);
    }
    expect(gh.calls.some((x) => x.method === 'POST')).toBe(false);
  });

  test('without a CSRF token the POST is refused and nothing is sent', async () => {
    const res = await h.as(USERS.owner, '/publish', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' }, body: '' });
    expect(res.status).toBe(403);
    expect(gh.calls).toEqual([]);
  });

  test('extra fields (repository, ref, mode) are rejected: the request is fixed', async () => {
    const res = await postAs(h, USERS.owner, '/publish', { mode: 'deploy' });
    expect(res.status).toBe(400);
    expect(gh.calls).toEqual([]);
  });
});
