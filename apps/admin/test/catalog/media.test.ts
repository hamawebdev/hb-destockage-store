// ACAT-3 media: uploads to a real local R2 (wrangler's platform proxy) and D1.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, postAs, tokenFor, TEST_USER_HEADER, USERS, type Harness } from '../helpers.ts';
import { idAndLabelProblems } from './html.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
let media: R2Bucket;
beforeAll(async () => {
  h = await harness();
  media = (h.proxy.env as unknown as { MEDIA: R2Bucket }).MEDIA;
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const env = () => ({ ...h.env, MEDIA: media });
const one = <T,>(sql: string, ...a: unknown[]) => h.db.prepare(sql).bind(...a).first<T>();
const all = <T,>(sql: string, ...a: unknown[]) => h.db.prepare(sql).bind(...a).all<T>().then((r) => r.results);

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const png = (w: number, h2: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(w), ...u32(h2), 8, 6, 0, 0, 0]);
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

async function upload(email: string, owner: string, files: { name: string; bytes: Uint8Array; type?: string }[], extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('_csrf', await tokenFor(h.db, email));
  fd.set('owner', owner);
  fd.set('alt_fr', 'Poêle rouge');
  fd.set('alt_ar', 'مقلاة حمراء');
  for (const [k, val] of Object.entries(extra)) fd.set(k, val);
  for (const f of files) fd.append('files', new File([f.bytes], f.name, { type: f.type ?? 'image/png' }));
  return h.app.request('/media/upload', { method: 'POST', body: fd, headers: { [TEST_USER_HEADER]: email, Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' } }, env());
}
const get = (email: string, path: string) => h.app.request(path, { headers: { [TEST_USER_HEADER]: email } }, env());
const postMedia = async (email: string, path: string, data: Record<string, string>) =>
  h.app.request(path, { method: 'POST', body: new URLSearchParams({ _csrf: await tokenFor(h.db, email), ...data }).toString(), headers: { [TEST_USER_HEADER]: email, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' } }, env());
const objectCount = async () => (await media.list()).objects.length;
const images = (pid: number) => all<{ id: number; r2_key: string; width: number; height: number; position: number; variant_id: number | null; option_value_id: number | null; alt_fr: string }>('select * from images where product_id = ? order by position', pid);
let auditFloor = 0;
const audits = (action: string) => all<{ before: string | null; after: string | null }>('select before, after from audit_log where action = ? and id > ? order by id', action, auditFloor);

let pid = 0;
let other = 0;
let vid = 0;
let otherVid = 0;
let valueId = 0;
let catId = 0;
beforeEach(async () => {
  auditFloor = (await one<{ n: number }>('select coalesce(max(id), 0) n from audit_log'))!.n;
  for (const sql of ['delete from images', 'delete from variants', 'delete from product_options', 'delete from products', 'delete from categories']) await h.db.prepare(sql).run();
  for (const o of (await media.list()).objects) await media.delete(o.key);
  catId = (await one<{ id: number }>("insert into categories (slug_fr, slug_ar, name_fr, name_ar) values ('c', 'c', 'C', 'ص') returning id"))!.id;
  pid = (await one<{ id: number }>("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('variable', ?, 'p', 'p', 'Poêle', 'مقلاة') returning id", catId))!.id;
  other = (await one<{ id: number }>("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('simple', ?, 'o', 'o', 'Autre', 'آخر') returning id", catId))!.id;
  vid = (await one<{ id: number }>("insert into variants (product_id, sku, price_dzd, is_default) values (?, 'P-R', 2500, 1) returning id", pid))!.id;
  otherVid = (await one<{ id: number }>("insert into variants (product_id, sku, price_dzd, is_default) values (?, 'O-1', 100, 1) returning id", other))!.id;
  const opt = (await one<{ id: number }>("insert into product_options (product_id, kind, name_fr, name_ar) values (?, 'colour', 'Couleur', 'اللون') returning id", pid))!.id;
  valueId = (await one<{ id: number }>("insert into option_values (option_id, value_fr, value_ar, swatch_hex) values (?, 'Rouge', 'أحمر', '#c00000') returning id", opt))!.id;
});

describe('upload', () => {
  test('stores the original in R2 under a server key, records dims from the bytes, audits', async () => {
    const res = await upload(USERS.content, `product:${pid}`, [{ name: '../../evil.svg', bytes: png(1200, 800), type: 'text/html' }]);
    expect(res.status).toBe(303);
    const [img] = await images(pid);
    expect(img).toMatchObject({ width: 1200, height: 800, alt_fr: 'Poêle rouge', position: 0 });
    expect(img!.r2_key).toMatch(new RegExp(`^products/${pid}/[0-9a-f-]{36}\\.png$`));
    const obj = await media.head(img!.r2_key);
    expect(obj?.httpMetadata?.contentType).toBe('image/png');
    expect(obj?.customMetadata?.['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(await audits('image.upload')).toHaveLength(1);
  });

  test('type comes from the bytes: SVG/HTML refused even when named .png; a bad file refuses the whole batch', async () => {
    expect((await upload(USERS.content, `product:${pid}`, [{ name: 'x.png', bytes: svg }])).status).toBe(415);
    expect((await upload(USERS.content, `product:${pid}`, [{ name: 'ok.png', bytes: png(1200, 800) }, { name: 'bad.png', bytes: svg }])).status).toBe(415);
    expect(await images(pid)).toHaveLength(0);
    expect(await objectCount()).toBe(0);
  });

  test('size, dimension and count limits', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(png(1200, 800));
    expect((await upload(USERS.content, `product:${pid}`, [{ name: 'big.png', bytes: big }])).status).toBe(413);
    expect((await upload(USERS.content, `product:${pid}`, [{ name: 'tiny.png', bytes: png(300, 200) }])).status).toBe(415);
    expect((await upload(USERS.content, `product:${pid}`, [{ name: 'huge.png', bytes: png(8000, 8000) }])).status).toBe(415);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png`, bytes: png(1200, 800) }));
    expect((await upload(USERS.content, `product:${pid}`, eleven)).status).toBe(413);
    expect((await upload(USERS.content, `product:${pid}`, [])).status).toBe(422);
    expect(await objectCount()).toBe(0);
  });

  test('owner must exist; roles; CSRF', async () => {
    expect((await upload(USERS.content, 'product:999999', [{ name: 'a.png', bytes: png(1200, 800) }])).status).toBe(404);
    expect((await upload(USERS.content, 'evil:1', [{ name: 'a.png', bytes: png(1200, 800) }])).status).toBe(404);
    expect((await upload(USERS.logistics, `product:${pid}`, [{ name: 'a.png', bytes: png(1200, 800) }])).status).toBe(403);
    expect((await upload(USERS.confirmer, `product:${pid}`, [{ name: 'a.png', bytes: png(1200, 800) }])).status).toBe(403);
    const fd = new FormData();
    fd.set('owner', `product:${pid}`);
    fd.append('files', new File([png(1200, 800)], 'a.png'));
    const noToken = await h.app.request('/media/upload', { method: 'POST', body: fd, headers: { [TEST_USER_HEADER]: USERS.content, Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' } }, env());
    expect(noToken.status).toBe(403);
    expect(await objectCount()).toBe(0);
  });

  test('category photos', async () => {
    expect((await upload(USERS.owner, `category:${catId}`, [{ name: 'c.png', bytes: png(1200, 600) }])).status).toBe(303);
    const row = await one<{ r2_key: string; product_id: number | null }>('select r2_key, product_id from images where category_id = ?', catId);
    expect(row!.product_id).toBeNull();
    expect(row!.r2_key.startsWith(`categories/${catId}/`)).toBe(true);
  });
});

describe('serve, edit, reorder, delete', () => {
  async function two(): Promise<[number, number]> {
    await upload(USERS.content, `product:${pid}`, [{ name: 'a.png', bytes: png(1200, 800) }, { name: 'b.png', bytes: png(1600, 1200) }]);
    const [a, b] = await images(pid);
    return [a!.id, b!.id];
  }

  test('original is served with its stored type to every catalogue reader; unknown id 404', async () => {
    const [a] = await two();
    for (const user of [USERS.owner, USERS.confirmer, USERS.logistics]) {
      const res = await get(user, `/media/${a}/original`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(res.headers.get('Content-Disposition')).toBe(`inline; filename="${a}.png"`);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(new Uint8Array(await res.arrayBuffer()).length).toBeGreaterThan(20);
    }
    expect((await get(USERS.owner, '/media/999999/original')).status).toBe(404);
  });

  test('edit alt and binding (whole product / option value / variant); foreign ids refused', async () => {
    const [a] = await two();
    const base = { alt_fr: 'Rouge', alt_ar: 'أحمر' };
    expect((await postMedia(USERS.content, `/media/${a}`, { ...base, bind: `o:${valueId}` })).status).toBe(303);
    expect((await images(pid))[0]).toMatchObject({ option_value_id: valueId, variant_id: null, alt_fr: 'Rouge' });
    expect((await postMedia(USERS.content, `/media/${a}`, { ...base, bind: `v:${vid}` })).status).toBe(303);
    expect((await images(pid))[0]).toMatchObject({ option_value_id: null, variant_id: vid });
    expect((await postMedia(USERS.content, `/media/${a}`, { ...base, bind: `v:${otherVid}` })).status).toBe(422);
    expect((await postMedia(USERS.content, `/media/${a}`, { ...base, bind: 'x:1' })).status).toBe(422);
    expect((await postMedia(USERS.content, `/media/${a}`, { ...base, bind: '', alt_fr: 'a‮b' })).status).toBe(422);
    expect((await postMedia(USERS.content, `/media/${a}`, { ...base, bind: `v:${vid}` })).status).toBe(303); // no change: noAudit
    expect(await audits('image.update')).toHaveLength(2);
  });

  test('reorder with up/down, audited', async () => {
    const [a, b] = await two();
    expect((await postMedia(USERS.content, `/media/${b}/move`, { dir: 'up' })).status).toBe(303);
    expect((await images(pid)).map((x) => x.id)).toEqual([b, a]);
    expect((await postMedia(USERS.content, `/media/${b}/move`, { dir: 'up' })).status).toBe(303); // already first
    expect(await audits('image.reorder')).toHaveLength(1);
  });

  test('delete removes the row and the R2 object, unless another row still uses the key', async () => {
    const [a, b] = await two();
    const keyA = (await images(pid))[0]!.r2_key;
    const keyB = (await images(pid))[1]!.r2_key;
    // A second row sharing B's original (seed reuses photos).
    await h.db.prepare("insert into images (product_id, r2_key, width, height, alt_fr, alt_ar) values (?, ?, 10, 10, 'x', 'س')").bind(other, keyB).run();
    expect((await postMedia(USERS.content, `/media/${a}/delete`, {})).status).toBe(303);
    expect((await postMedia(USERS.content, `/media/${b}/delete`, {})).status).toBe(303);
    expect(await images(pid)).toHaveLength(0);
    expect(await media.head(keyA)).toBeNull();
    expect(await media.head(keyB)).not.toBeNull();
    expect(await audits('image.delete')).toHaveLength(2);
    expect((await postAs(h, USERS.logistics, `/media/${b}/delete`, {})).status).toBe(403);
  });

  test('photo cards on product and category pages: no repeated id, labels inside their card', async () => {
    await two();
    await upload(USERS.owner, `category:${catId}`, [{ name: 'c.png', bytes: png(1200, 600) }, { name: 'd.png', bytes: png(1200, 600) }]);
    for (const user of [USERS.owner, USERS.ownerAr]) {
      for (const path of [`/products/${pid}`, `/categories/${catId}`]) {
        const html = await (await get(user, path)).text();
        const photos = html.slice(html.indexOf('id="sec-photos"'));
        expect(idAndLabelProblems(html), path).toEqual([]);
        expect(idAndLabelProblems(photos.slice(0, photos.indexOf('</ol>')), /<li>[\s\S]*?<\/li>/), path).toEqual([]);
      }
    }
  });
});
