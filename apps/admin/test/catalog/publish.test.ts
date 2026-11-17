// /publish (BOOT-41, D-028): start the pipeline's publish mode on GitHub from the admin. A fake GitHub API
// behind the module's fetch seam: no network, and the only "token" is the stand-in below.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { setGithubFetchForTests } from '../../src/routes/publish/github.ts';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { idAndLabelProblems } from './html.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const TOKEN = 'github_pat_TESTONLY_0000000000aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd';
const RUNS = '/repos/hamawebdev/hb-destockage-store/actions/workflows/pipeline.yml/runs';
const DISPATCH = '/repos/hamawebdev/hb-destockage-store/actions/workflows/pipeline.yml/dispatches';

interface Fake {
  runs: { id: number; status: string; conclusion: string | null; event: string; display_title: string; created_at: string; updated_at: string }[];
  calls: { method: string; path: string; auth: string | null; body: unknown }[];
  /** Status the API answers with (200/204 when unset). */
  failWith: number | null;
  /** Status the dispatch alone answers with; 'hang' = never answers (timeout). */
  dispatchFails: number | 'drop' | null;
  down: boolean;
}
let gh: Fake;
let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h?.close());
beforeEach(async () => {
  await h.db.prepare("delete from settings where key = 'admin.publish_last_request'").run();
  gh = { runs: [], calls: [], failWith: null, dispatchFails: null, down: false };
  setGithubFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    gh.calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (gh.down) throw new TypeError('network down');
    if (gh.failWith !== null) return new Response('{"message":"x"}', { status: gh.failWith });
    if (url.host !== 'api.github.com') return new Response('', { status: 404 });
    if ((init?.method ?? 'GET') === 'GET' && url.pathname === RUNS) return Response.json({ total_count: gh.runs.length, workflow_runs: gh.runs });
    if (init?.method === 'POST' && url.pathname === DISPATCH) {
      if (gh.dispatchFails === 'drop') throw new DOMException('timed out', 'TimeoutError');
      if (gh.dispatchFails !== null) return new Response('{"message":"x"}', { status: gh.dispatchFails });
      gh.runs.unshift({ id: 900 + gh.runs.length, status: 'queued', conclusion: null, event: 'workflow_dispatch', display_title: 'pipeline · publish', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch);
  h.env.GITHUB_PUBLISH_TOKEN = TOKEN;
});
afterEach(() => setGithubFetchForTests(undefined));

const run = (id: number, status: string, conclusion: string | null, event = 'workflow_dispatch', title = event === 'workflow_dispatch' ? 'pipeline · publish' : 'BOOT-1: a commit') =>
  ({ id, status, conclusion, event, display_title: title, created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:08:00Z' });
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

describe('review BOOT-41 r1', () => {
  const dispatches = () => gh.calls.filter((x) => x.method === 'POST').length;

  test('a second request within two minutes is refused (cooldown), even while no run shows yet', async () => {
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(303);
    gh.runs = []; // GitHub does not list the new run yet
    const res = await postAs(h, USERS.content, '/publish', {});
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('Attendez deux minutes');
    expect(dispatches()).toBe(1);
  });

  test('simultaneous requests (two tabs, a script): exactly one reaches GitHub, exactly one audit row', async () => {
    const before = (await requests()).length;
    const res = await Promise.all([1, 2, 3, 4].map(() => postAs(h, USERS.owner, '/publish', {})));
    expect(res.map((r) => r.status).sort()).toEqual([303, 429, 429, 429]);
    expect(dispatches()).toBe(1);
    expect((await requests()).length).toBe(before + 1);
  });

  test('after the cooldown a new request goes through', async () => {
    await h.db.prepare("insert into settings (key, value) values ('admin.publish_last_request', ?)").bind(JSON.stringify({ at: Date.now() - 2 * 60_000 - 1 })).run();
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(303);
  });

  test('a refused dispatch gives the claim back (retry allowed) and is audited as failed', async () => {
    gh.dispatchFails = 422;
    const res = await postAs(h, USERS.owner, '/publish', {});
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('Réponse inattendue de GitHub');
    const failed = await h.db.prepare("select after from audit_log where action = 'publish.requestFailed' order by id desc").first<{ after: string }>();
    expect(JSON.parse(failed!.after)).toEqual({ error: 'unexpected' });
    expect(await (await h.as(USERS.owner, '/dashboard')).text()).toMatch(/data-tile="publish"[\s\S]*?Échec/);
    gh.dispatchFails = null;
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(303);
  });

  test('a dispatch that times out keeps the claim and says the run may have started', async () => {
    gh.dispatchFails = 'drop';
    const res = await postAs(h, USERS.owner, '/publish', {});
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('a peut-être démarré');
    expect(await h.db.prepare("select count(*) n from audit_log where action = 'publish.requestUncertain'").first<{ n: number }>()).toMatchObject({ n: expect.any(Number) });
    gh.dispatchFails = null;
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(429);
  });

  test.each([
    ['a gh login token', 'gho_' + 'a'.repeat(36)],
    ['a classic token', 'ghp_' + 'a'.repeat(36)],
    ['garbage with a newline', 'github_pat_' + 'a'.repeat(50) + '\nX-Evil: 1'],
  ])('only fine-grained tokens are used: %s means "not enabled", no GitHub call', async (_n, token) => {
    h.env.GITHUB_PUBLISH_TOKEN = token;
    expect(await page()).toContain('pas encore activée');
    expect(gh.calls).toEqual([]);
  });

  test('a waiting pull-request run does not count as a waiting publication', async () => {
    gh.runs = [run(7, 'queued', null, 'pull_request')];
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(303);
    expect(dispatches()).toBe(1);
  });

  test('D-028: an online product the site cannot show is listed with the reason and a link', async () => {
    await h.db.prepare("insert into products (id, slug_fr, slug_ar, name_fr, name_ar, status) values (7001, 'sans-photo', 'sans-photo', 'Produit sans photo', 'منتج بلا صورة', 'active')").run();
    await h.db.prepare("insert into variants (product_id, sku, price_dzd, is_default) values (7001, 'NOPHOTO-1', 1000, 1)").run();
    try {
      const html = await page();
      expect(html).toContain('data-publish-aside');
      expect(html).toContain('<a href="/products/7001">Produit sans photo</a>');
      expect(html).toContain('aucune photo générale');
    } finally {
      await h.db.prepare('delete from variants where product_id = 7001').run();
      await h.db.prepare('delete from products where id = 7001').run();
    }
    expect(await page()).not.toContain('data-publish-aside');
  });
});

describe('review BOOT-41 r2', () => {
  const dispatches = () => gh.calls.filter((x) => x.method === 'POST').length;

  test.each([
    ['a queued backoffice run (it rebuilds no storefront)', run(8, 'queued', null, 'workflow_dispatch', 'pipeline · backoffice')],
    ['a publication held for approval (it may never start)', run(9, 'waiting', null, 'workflow_dispatch', 'pipeline · publish')],
    ['a queued deploy started by hand (held by the approval gate)', run(10, 'waiting', null, 'workflow_dispatch', 'pipeline · deploy')],
  ])('%s does not count as covering the changes: the request goes through', async (_n, r) => {
    gh.runs = [r];
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(303);
    expect(dispatches()).toBe(1);
  });

  test('a queued push deploy covers the changes (it exports and rebuilds the storefront)', async () => {
    gh.runs = [run(11, 'queued', null, 'push')];
    expect((await postAs(h, USERS.owner, '/publish', {})).status).toBe(409);
    expect(dispatches()).toBe(0);
  });

  test('a manual run that is not a publication is shown as a technical update, not as a publication', async () => {
    gh.runs = [run(12, 'completed', 'success', 'workflow_dispatch', 'pipeline · backoffice')];
    const html = await page();
    expect(html).toContain('Mise à jour technique');
  });

  test('an online product that would still break a rule as a draft is listed as blocking the publication', async () => {
    await h.db.prepare("insert into products (id, slug_fr, slug_ar, name_fr, name_ar, status) values (7002, 'bloquant', 'bloquant', 'Produit bloquant', 'منتج', 'active')").run();
    await h.db.prepare("insert into variants (product_id, sku, price_dzd, is_default, active) values (7002, 'BLOCK-1', 1000, 1, 0)").run();
    try {
      const html = await page();
      expect(html).toContain('<a href="/products/7002">Produit bloquant</a>');
      expect(html).toContain('data-publish-blocking');
      expect(html).toContain('bloque toute la publication');
    } finally {
      await h.db.prepare('delete from variants where product_id = 7002').run();
      await h.db.prepare('delete from products where id = 7002').run();
    }
  });
});
