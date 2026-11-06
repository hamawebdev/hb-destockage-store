// ADMIN-4: owner-only users and roles management.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { removesActiveOwner } from '../src/routes/users/index.tsx';
import { harness, postAs, USERS, type Harness } from './helpers.ts';

// Real D1 (workerd) requests take seconds on the loaded shared machine: explicit budgets instead
// of vitest's 5 s default, so the admin gate is not red at random (lead, 2026-11-06).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

async function user(email: string) {
  return h.db.prepare('select id, email, name, role, active, ui_lang from admin_users where email = ?').bind(email).first<{ id: number; email: string; name: string; role: string; active: number; ui_lang: string }>();
}
async function auditRows(action: string) {
  return (await h.db.prepare('select entity_id, before, after, actor_email from audit_log where action = ? order by id').bind(action).all<Record<string, string | null>>()).results;
}
const base = (over: Record<string, string> = {}) => ({ email: 'new.person@example.dz', name: 'New Person', role: 'confirmer', ui_lang: 'fr', active: '1', ...over });

describe('access: owner only', () => {
  test('every route refuses confirmer, logistics, content (403) and anonymous (401)', async () => {
    const owner = await user(USERS.owner);
    const paths: [string, 'GET' | 'POST'][] = [
      ['/users', 'GET'],
      ['/users/new', 'GET'],
      [`/users/${owner!.id}/edit`, 'GET'],
      ['/users', 'POST'],
      [`/users/${owner!.id}`, 'POST'],
      [`/users/${owner!.id}/delete`, 'POST'],
    ];
    for (const email of [USERS.confirmer, USERS.logistics, USERS.content]) {
      for (const [p, m] of paths) {
        const res = m === 'GET' ? await h.as(email, p) : await postAs(h, email, p, base({ email: 'x@y.dz' }));
        expect(res.status, `${email} ${m} ${p}`).toBe(403);
      }
    }
    expect((await h.as(null, '/users')).status).toBe(401);
    expect(await user('x@y.dz')).toBeNull();
  });
  test('the owner sees the list with every user', async () => {
    const html = await (await h.as(USERS.owner, '/users')).text();
    for (const e of Object.values(USERS)) expect(html).toContain(e);
    expect(html).toContain('href="/users/new"');
  });
});

describe('create', () => {
  test('valid → 303, stored lowercased, one audit row with the after snapshot', async () => {
    const res = await postAs(h, USERS.owner, '/users', base({ email: '  New.Person@Example.DZ ' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/users?m=created');
    const u = await user('new.person@example.dz');
    expect(u).toMatchObject({ name: 'New Person', role: 'confirmer', active: 1, ui_lang: 'fr' });
    const a = await auditRows('adminUser.create');
    expect(a).toHaveLength(1);
    expect(a[0]!.entity_id).toBe(String(u!.id));
    expect(a[0]!.before).toBeNull();
    expect(JSON.parse(a[0]!.after!)).toEqual({ email: 'new.person@example.dz', name: 'New Person', role: 'confirmer', active: true, uiLang: 'fr' });
    expect(a[0]!.actor_email).toBe(USERS.owner);
  });
  test('duplicate email (any case) → 422, nothing written', async () => {
    const before = (await auditRows('adminUser.create')).length;
    const res = await postAs(h, USERS.owner, '/users', base({ email: 'NEW.PERSON@example.dz' }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('déjà utilisée');
    expect((await auditRows('adminUser.create')).length).toBe(before);
  });
  test('invalid input → 422 with errors, values kept, nothing written', async () => {
    for (const bad of [base({ email: 'not-an-email' }), base({ role: 'admin' }), base({ name: '' }), base({ ui_lang: 'en' }), base({ email: 'b@c.dz', name: 'x'.repeat(121) })]) {
      const res = await postAs(h, USERS.owner, '/users', bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
      const html = await res.text();
      expect(html).toContain('error-summary');
    }
    expect(await user('b@c.dz')).toBeNull();
  });
  test('unticked "active" creates an inactive user (checkbox absent → false)', async () => {
    const { active: _a, ...rest } = base({ email: 'inactive.new@example.dz' });
    void _a;
    expect((await postAs(h, USERS.owner, '/users', rest)).status).toBe(303);
    expect((await user('inactive.new@example.dz'))?.active).toBe(0);
  });
});

describe('edit', () => {
  test('changes are written with before/after; unticking deactivates', async () => {
    const u = (await user('new.person@example.dz'))!;
    const res = await postAs(h, USERS.owner, `/users/${u.id}`, { email: u.email, name: 'Renamed', role: 'logistics', ui_lang: 'ar', active: '1' });
    expect(res.status).toBe(303);
    // An unticked checkbox is simply absent from the body.
    const res2 = await postAs(h, USERS.owner, `/users/${u.id}`, { email: u.email, name: 'Renamed', role: 'logistics', ui_lang: 'ar' });
    expect(res2.status).toBe(303);
    const after = (await user(u.email))!;
    expect(after).toMatchObject({ name: 'Renamed', role: 'logistics', ui_lang: 'ar', active: 0 });
    const a = (await auditRows('adminUser.update')).filter((r) => r.entity_id === String(u.id));
    expect(a.length).toBe(2);
    expect(JSON.parse(a[1]!.before!)).toMatchObject({ active: true });
    expect(JSON.parse(a[1]!.after!)).toMatchObject({ active: false });
  });
  test('a deactivated user is refused on the next request', async () => {
    expect((await h.as('new.person@example.dz', '/dashboard')).status).toBe(403);
  });
  test('saving without changes writes nothing', async () => {
    const u = (await user(USERS.content))!;
    const n = (await auditRows('adminUser.update')).length;
    const res = await postAs(h, USERS.owner, `/users/${u.id}`, { email: u.email, name: u.name, role: u.role, ui_lang: u.ui_lang, active: '1' });
    expect(res.status).toBe(303);
    expect((await auditRows('adminUser.update')).length).toBe(n);
  });
  test('email change to an existing address → 422', async () => {
    const u = (await user(USERS.content))!;
    const res = await postAs(h, USERS.owner, `/users/${u.id}`, { email: USERS.confirmer, name: u.name, role: u.role, ui_lang: 'fr', active: '1' });
    expect(res.status).toBe(422);
  });
  test('unknown or malformed id → 404', async () => {
    expect((await h.as(USERS.owner, '/users/999999/edit')).status).toBe(404);
    expect((await h.as(USERS.owner, '/users/abc/edit')).status).toBe(404);
    expect((await postAs(h, USERS.owner, '/users/999999', base())).status).toBe(404);
  });
});

describe('the last active owner', () => {
  // Seeded: owner@ (active owner), owner-ar@ (active owner), inactive@ (inactive owner).
  async function setActive(email: string, active: 0 | 1) {
    await h.db.prepare('update admin_users set active = ? where email = ?').bind(active, email).run();
  }
  beforeEach(async () => {
    await h.db.prepare("update admin_users set role = 'owner', active = 1 where email in (?, ?)").bind(USERS.owner, USERS.ownerAr).run();
  });

  test('with two active owners, one can be demoted', async () => {
    const ar = (await user(USERS.ownerAr))!;
    const res = await postAs(h, USERS.owner, `/users/${ar.id}`, { email: ar.email, name: ar.name, role: 'confirmer', ui_lang: ar.ui_lang, active: '1' });
    expect(res.status).toBe(303);
    expect((await user(USERS.ownerAr))!.role).toBe('confirmer');
  });

  test('the last active owner cannot be demoted, deactivated or deleted (409, nothing written)', async () => {
    await setActive(USERS.ownerAr, 0); // owner@ is now the only active owner; inactive@ does not count
    const me = (await user(USERS.owner))!;
    const n = (await auditRows('adminUser.update')).length + (await auditRows('adminUser.delete')).length;
    const demote = await postAs(h, USERS.owner, `/users/${me.id}`, { email: me.email, name: me.name, role: 'content', ui_lang: 'fr', active: '1' });
    expect(demote.status).toBe(409);
    expect(await demote.text()).toContain('dernier propriétaire actif');
    const deactivate = await postAs(h, USERS.owner, `/users/${me.id}`, { email: me.email, name: me.name, role: 'owner', ui_lang: 'fr' });
    expect(deactivate.status).toBe(409);
    const del = await postAs(h, USERS.owner, `/users/${me.id}/delete`);
    expect(del.status).toBe(409);
    expect(await user(USERS.owner)).toMatchObject({ role: 'owner', active: 1 });
    expect((await auditRows('adminUser.update')).length + (await auditRows('adminUser.delete')).length).toBe(n);
    // Renaming the last owner is fine.
    const rename = await postAs(h, USERS.owner, `/users/${me.id}`, { email: me.email, name: 'Boss', role: 'owner', ui_lang: 'fr', active: '1' });
    expect(rename.status).toBe(303);
  });

  test('two concurrent demotions of the last two owners: exactly one succeeds', async () => {
    const a = (await user(USERS.owner))!;
    const b = (await user(USERS.ownerAr))!;
    const [r1, r2] = await Promise.all([
      postAs(h, USERS.owner, `/users/${a.id}`, { email: a.email, name: a.name, role: 'confirmer', ui_lang: 'fr', active: '1' }),
      postAs(h, USERS.ownerAr, `/users/${b.id}`, { email: b.email, name: b.name, role: 'confirmer', ui_lang: 'ar', active: '1' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([303, 409]);
    const owners = await h.db.prepare("select count(*) as n from admin_users where role = 'owner' and active = 1").first<{ n: number }>();
    expect(owners!.n).toBe(1);
  });

  test('removesActiveOwner()', () => {
    expect(removesActiveOwner({ role: 'owner', active: true }, { role: 'owner', active: true })).toBe(false);
    expect(removesActiveOwner({ role: 'owner', active: true }, { role: 'content', active: true })).toBe(true);
    expect(removesActiveOwner({ role: 'owner', active: true }, { role: 'owner', active: false })).toBe(true);
    expect(removesActiveOwner({ role: 'owner', active: true }, null)).toBe(true);
    expect(removesActiveOwner({ role: 'owner', active: false }, null)).toBe(false);
    expect(removesActiveOwner({ role: 'confirmer', active: true }, null)).toBe(false);
  });
});

describe('delete', () => {
  test('a user who never acted can be deleted; the deletion is audited', async () => {
    expect((await postAs(h, USERS.owner, '/users', base({ email: 'temp@example.dz' }))).status).toBe(303);
    const t = (await user('temp@example.dz'))!;
    const res = await postAs(h, USERS.owner, `/users/${t.id}/delete`);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/users?m=deleted');
    expect(await user('temp@example.dz')).toBeNull();
    const a = (await auditRows('adminUser.delete')).filter((r) => r.entity_id === String(t.id));
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]!.before!)).toMatchObject({ email: 'temp@example.dz' });
    expect(a[0]!.after).toBeNull();
  });
  test('a user with history (audit rows) cannot be deleted: 409, nothing written', async () => {
    const lg = (await user(USERS.logistics))!;
    // Give logistics some history: toggling its own language writes an audit row as actor.
    expect((await postAs(h, USERS.logistics, '/settings/language', { lang: 'ar' })).status).toBe(303);
    const n = (await auditRows('adminUser.delete')).length;
    const res = await postAs(h, USERS.owner, `/users/${lg.id}/delete`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('désactivez-le');
    expect(await user(USERS.logistics)).not.toBeNull();
    expect((await auditRows('adminUser.delete')).length).toBe(n);
  });
});
