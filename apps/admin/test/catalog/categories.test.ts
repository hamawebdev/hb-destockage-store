// ACAT-1 categories: HTTP-level tests on a real D1 (admin-core's harness: migrations + users).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';

// The shared machine is heavily loaded: real-D1 HTTP tests can take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

async function post(email: string, path: string, data: Record<string, string>): Promise<Response> {
  return postAs(h, email, path, data);
}

interface Row {
  id: number;
  parent_id: number | null;
  slug_fr: string;
  slug_ar: string;
  name_fr: string;
  name_ar: string;
  active: number;
  updated_at: number;
  translation_placeholder: string;
}
const cat = (id: number) => h.db.prepare('select * from categories where id = ?').bind(id).first<Row>();
const auditRows = (action: string, entityId?: number) =>
  h.db
    .prepare(`select * from audit_log where action = ? ${entityId === undefined ? '' : 'and entity_id = ?'} order by id`)
    .bind(...(entityId === undefined ? [action] : [action, String(entityId)]))
    .all<{ actor_email: string; entity_id: string; before: string | null; after: string | null }>()
    .then((r) => r.results);

const base = { name_fr: 'Cuisine', name_ar: 'المطبخ', active: '1', sort: '0' };

/** Creates a category as `content`, returns its id. */
async function create(data: Record<string, string> = {}): Promise<number> {
  const res = await post(USERS.content, '/categories', { ...base, ...data });
  expect(res.status, await res.clone().text()).toBe(303);
  const m = /\/categories\/(\d+)\?m=created/.exec(res.headers.get('Location') ?? '');
  expect(m).not.toBeNull();
  return Number(m![1]);
}

beforeEach(async () => {
  await h.db.prepare('delete from products').run();
  // Parent FK is RESTRICT: delete leaves until the tree is empty.
  for (let i = 0; i < 10; i++) {
    const r = await h.db.prepare('delete from categories where id not in (select parent_id from categories where parent_id is not null)').run();
    if (r.meta.changes === 0) break;
  }
});

describe('create', () => {
  test('content creates; slugs suggested from the names (Arabic transliterated); audited with the new id', async () => {
    const id = await create({ name_fr: 'Salle de bain', name_ar: 'الحمام', tp_ar: '1' });
    const row = await cat(id);
    expect(row).toMatchObject({ slug_fr: 'salle-de-bain', slug_ar: 'el-hmam', active: 1, translation_placeholder: '["ar"]' });
    const [a] = await auditRows('category.create', id);
    expect(a).toBeDefined();
    expect(a!.actor_email).toBe(USERS.content);
    expect(JSON.parse(a!.after!)).toMatchObject({ slugFr: 'salle-de-bain', nameAr: 'الحمام' });
  });

  test('suggested slugs avoid taken ones', async () => {
    await create();
    const id2 = await create();
    expect(await cat(id2)).toMatchObject({ slug_fr: 'cuisine-2', slug_ar: 'el-mtbkh-2' });
  });

  test.each([
    ['slug_fr', '../x'],
    ['slug_fr', 'a/b'],
    ['slug_fr', 'Cuisine Moderne'],
    ['slug_ar', 'مطبخ'],
    ['slug_fr', 'search'],
  ])('rejects %s=%j with 422 and writes nothing', async (field, value) => {
    const res = await post(USERS.content, '/categories', { ...base, [field]: value });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('error-summary');
    expect((await h.db.prepare('select count(*) n from categories').first<{ n: number }>())!.n).toBe(0);
  });

  test('duplicate slug → 422 field error, not 500', async () => {
    await create({ slug_fr: 'cuisine' });
    const res = await post(USERS.content, '/categories', { ...base, slug_fr: 'cuisine', slug_ar: 'autre' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('déjà utilisé');
  });

  test('bidi override / control characters in names are refused', async () => {
    for (const name of ['abc‮def', 'a\u0000b', 'x⁦y']) {
      expect((await post(USERS.content, '/categories', { ...base, name_fr: name })).status).toBe(422);
    }
  });

  test('unknown fields are refused (no mass assignment)', async () => {
    for (const extra of [{ id: '99' }, { updated_at: '1' }, { created_at: '1' }]) {
      expect((await post(USERS.content, '/categories', { ...base, ...extra })).status).toBe(422);
    }
  });

  test('stored XSS payloads are escaped on render', async () => {
    const payload = '"><svg onload=alert(1)></script><script>alert(1)</script>';
    const id = await create({ name_fr: payload, slug_fr: 'xss' });
    for (const path of ['/categories', `/categories/${id}`]) {
      const html = await (await h.as(USERS.owner, path)).text();
      expect(html).not.toContain('<svg onload');
      expect(html).not.toContain('<script>alert(1)');
    }
  });
});

describe('roles', () => {
  test('confirmer and logistics read (list + read-only view) but cannot write', async () => {
    const id = await create();
    for (const user of [USERS.confirmer, USERS.logistics]) {
      expect((await h.as(user, '/categories')).status).toBe(200);
      const view = await h.as(user, `/categories/${id}`);
      expect(view.status).toBe(200);
      expect(await view.text()).not.toContain(`action="/categories/${id}"`);
      expect((await h.as(user, '/categories/new')).status).toBe(403);
      for (const path of ['/categories', `/categories/${id}`, `/categories/${id}/archive`, `/categories/${id}/delete`]) {
        expect((await postAs(h, user, path, { ...base })).status, `${user} ${path}`).toBe(403);
      }
    }
    expect((await cat(id))!.active).toBe(1);
  });

  test('no identity → 401', async () => {
    expect((await h.as(null, '/categories')).status).toBe(401);
  });

  test('ids that are not positive integers → 404', async () => {
    for (const p of ['/categories/0', '/categories/-1', '/categories/abc', '/categories/99999999999999999999', '/categories/424242']) {
      expect((await h.as(USERS.owner, p)).status, p).toBe(404);
    }
  });
});

describe('update', () => {
  const edit = async (id: number, data: Record<string, string>) => {
    const row = (await cat(id))!;
    return post(USERS.owner, `/categories/${id}`, {
      name_fr: row.name_fr,
      name_ar: row.name_ar,
      slug_fr: row.slug_fr,
      slug_ar: row.slug_ar,
      sort: '0',
      ...(row.active ? { active: '1' } : {}),
      v: String(row.updated_at),
      ...data,
    });
  };

  test('saves, bumps updated_at, audits only the changed fields', async () => {
    const id = await create();
    const before = (await cat(id))!;
    const res = await edit(id, { name_fr: 'Cuisine & arts de la table' });
    expect(res.status).toBe(303);
    const after = (await cat(id))!;
    expect(after.name_fr).toBe('Cuisine & arts de la table');
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    const [a] = await auditRows('category.update', id);
    expect(JSON.parse(a!.before!)).toEqual({ nameFr: 'Cuisine' });
    expect(JSON.parse(a!.after!)).toEqual({ nameFr: 'Cuisine & arts de la table' });
  });

  test('no change → no audit row', async () => {
    const id = await create();
    expect((await edit(id, {})).status).toBe(303);
    expect(await auditRows('category.update', id)).toHaveLength(0);
  });

  test('stale version → 409, nothing written', async () => {
    const id = await create();
    const row = (await cat(id))!;
    const res = await edit(id, { name_fr: 'Autre', v: String(row.updated_at - 1) });
    expect(res.status).toBe(409);
    expect((await cat(id))!.name_fr).toBe('Cuisine');
    expect(await auditRows('category.update', id)).toHaveLength(0);
  });

  test('two edits from the same form version: the second is refused', async () => {
    const id = await create();
    const v = String((await cat(id))!.updated_at);
    expect((await edit(id, { name_fr: 'Premier', v })).status).toBe(303);
    expect((await edit(id, { name_fr: 'Second', v })).status).toBe(409);
    expect((await cat(id))!.name_fr).toBe('Premier');
  });

  test('cannot become its own descendant; depth limit 3', async () => {
    const a = await create({ name_fr: 'A', name_ar: 'أ' });
    const b = await create({ name_fr: 'B', name_ar: 'ب', parent_id: String(a) });
    const c = await create({ name_fr: 'C', name_ar: 'ج', parent_id: String(b) });
    expect((await edit(a, { parent_id: String(c) })).status).toBe(422);
    expect((await edit(a, { parent_id: String(a) })).status).toBe(422);
    expect((await post(USERS.content, '/categories', { ...base, name_fr: 'D', slug_fr: 'd', slug_ar: 'd', parent_id: String(c) })).status).toBe(422);
    expect((await cat(a))!.parent_id).toBeNull();
  });

  test('slug change on a visible category: warning naming the URLs, then explicit confirmation', async () => {
    const id = await create();
    const res = await edit(id, { slug_fr: 'cuisine-moderne' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('/fr/c/cuisine/');
    expect(html).toContain('confirm_slug_change');
    expect((await cat(id))!.slug_fr).toBe('cuisine');
    const ok = await edit(id, { slug_fr: 'cuisine-moderne', confirm_slug_change: '1' });
    expect(ok.status).toBe(303);
    const [a] = await auditRows('category.update', id);
    expect(JSON.parse(a!.before!)).toEqual({ slugFr: 'cuisine' });
    expect(JSON.parse(a!.after!)).toEqual({ slugFr: 'cuisine-moderne' });
  });

  test('slug change on an archived category needs no confirmation', async () => {
    const id = await create({ active: '' });
    await h.db.prepare('update categories set active = 0 where id = ?').bind(id).run();
    expect((await edit(id, { slug_fr: 'ailleurs' })).status).toBe(303);
  });
});

describe('archive / restore / delete', () => {
  test('archive and restore are audited once each; repeating is a no-op', async () => {
    const id = await create();
    expect((await post(USERS.content, `/categories/${id}/archive`, {})).status).toBe(303);
    expect((await post(USERS.content, `/categories/${id}/archive`, {})).status).toBe(303);
    expect((await cat(id))!.active).toBe(0);
    expect(await auditRows('category.archive', id)).toHaveLength(1);
    expect((await post(USERS.content, `/categories/${id}/restore`, {})).status).toBe(303);
    expect((await cat(id))!.active).toBe(1);
    expect(await auditRows('category.restore', id)).toHaveLength(1);
  });

  test('action forms accept no extra fields', async () => {
    const id = await create();
    expect((await post(USERS.content, `/categories/${id}/archive`, { active: '1' })).status).toBe(400);
  });

  test('delete is refused with products or sub-categories, allowed when empty (audited)', async () => {
    const parent = await create({ name_fr: 'Parent', slug_fr: 'parent', slug_ar: 'parent' });
    const child = await create({ name_fr: 'Enfant', slug_fr: 'enfant', slug_ar: 'enfant', parent_id: String(parent) });
    expect((await post(USERS.content, `/categories/${parent}/delete`, {})).status).toBe(409);
    await h.db
      .prepare("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('simple', ?, 'p', 'p', 'P', 'ب')")
      .bind(child)
      .run();
    const page = await (await h.as(USERS.content, `/categories/${child}/delete`)).text();
    expect(page).not.toContain(`action="/categories/${child}/delete"`);
    expect((await post(USERS.content, `/categories/${child}/delete`, {})).status).toBe(409);
    await h.db.prepare('delete from products').run();
    expect((await post(USERS.content, `/categories/${child}/delete`, {})).status).toBe(303);
    expect(await cat(child)).toBeNull();
    const [a] = await auditRows('category.delete', child);
    expect(JSON.parse(a!.before!)).toMatchObject({ slugFr: 'enfant' });
    expect(a!.after).toBeNull();
  });
});
