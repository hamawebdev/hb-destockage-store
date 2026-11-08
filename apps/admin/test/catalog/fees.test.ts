// ACAT-4 delivery fees editor: HTTP tests on a real D1 (plan artifacts/ACAT-4/plan.md §3 + §5).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAdminTableFeeProvider } from '@hb/db/fees';
import { createDb, createOrder } from '@hb/db';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { idAndLabelProblems } from './html.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
  const stmts = Array.from({ length: 69 }, (_, i) =>
    h.db.prepare('insert or ignore into wilayas (code, name_fr, name_ar) values (?, ?, ?)').bind(i + 1, `Wilaya ${i + 1}`, `ولاية ${i + 1}`),
  );
  await h.db.batch(stmts);
  await h.db.prepare("insert or ignore into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى')").run();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const one = <T,>(sql: string, ...a: unknown[]) => h.db.prepare(sql).bind(...a).first<T>();
const all = <T,>(sql: string, ...a: unknown[]) => h.db.prepare(sql).bind(...a).all<T>().then((r) => r.results);
const fee = (code: number) => one<{ fee_dzd: number; available: number; placeholder: number; updated_at: number; updated_by: number | null }>('select * from delivery_fees where wilaya_code = ?', code);
let auditFloor = 0;
const audits = () => all<{ entity_id: string; before: string | null; after: string | null }>("select entity_id, before, after from audit_log where action = 'fee.update' and id > ? order by id", auditFloor);

beforeEach(async () => {
  auditFloor = (await one<{ n: number }>('select coalesce(max(id), 0) n from audit_log'))!.n;
  await h.db.prepare('delete from delivery_fees').run();
  await h.db.batch([
    h.db.prepare('insert into delivery_fees (wilaya_code, fee_dzd, available, placeholder) values (16, 600, 1, 0)'),
    h.db.prepare('insert into delivery_fees (wilaya_code, fee_dzd, available, placeholder) values (31, 800, 1, 1)'),
    h.db.prepare('insert into delivery_fees (wilaya_code, fee_dzd, available, placeholder) values (1, 1000, 1, 0)'),
  ]);
});

/** The form exactly as GET /fees renders it for the owner, with overrides. */
async function form(over: Record<string, string | null> = {}): Promise<Record<string, string>> {
  const rows = await all<{ wilaya_code: number; fee_dzd: number; available: number; updated_at: number }>('select * from delivery_fees');
  const out: Record<string, string> = {};
  for (let code = 1; code <= 69; code++) out[`v_${code}`] = '0';
  for (const r of rows) {
    out[`v_${r.wilaya_code}`] = String(r.updated_at);
    out[`fee_${r.wilaya_code}`] = String(r.fee_dzd);
    if (r.available) out[`avail_${r.wilaya_code}`] = '1';
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}
/** preview, then apply with the hidden fields the preview page carries. */
async function previewAndApply(email: string, data: Record<string, string>) {
  const preview = await postAs(h, email, '/fees/preview', data);
  const html = await preview.text();
  if (preview.status !== 200) return { preview, html, apply: null as Response | null };
  const hidden: Record<string, string> = {};
  const applyForm = html.slice(html.indexOf('action="/fees/apply"'));
  for (const m of applyForm.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/?>/g)) if (m[1] !== '_csrf') hidden[m[1]!] = m[2]!;
  const apply = await postAs(h, email, '/fees/apply', hidden);
  return { preview, html, apply };
}

describe('access', () => {
  test('owner edits; confirmer/logistics read-only; content none', async () => {
    const owner = await (await h.as(USERS.owner, '/fees')).text();
    expect(owner).toContain('action="/fees/preview"');
    for (const user of [USERS.confirmer, USERS.logistics]) {
      const res = await h.as(user, '/fees');
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('action="/fees/preview"');
      expect((await postAs(h, user, '/fees/preview', await form())).status).toBe(403);
      expect((await postAs(h, user, '/fees/apply', await form({ fee_16: '700' }))).status).toBe(403);
    }
    expect((await h.as(USERS.content, '/fees')).status).toBe(403);
    expect((await postAs(h, USERS.content, '/fees/apply', await form({ fee_16: '700' }))).status).toBe(403);
    expect((await fee(16))!.fee_dzd).toBe(600);
  });

  test('69 rows; banner and badge for placeholder fees; no repeated id; Arabic uses د.ج.', async () => {
    for (const user of [USERS.owner, USERS.ownerAr]) {
      const html = await (await h.as(user, '/fees')).text();
      expect(html.match(/<tr data-key="\d+">/g)?.length).toBe(69);
      expect(idAndLabelProblems(html, /<tr data-key="\d+">[\s\S]*?<\/tr>/)).toEqual([]);
      if (user === USERS.ownerAr) expect(html).toContain('د.ج.');
    }
    const fr = await (await h.as(USERS.owner, '/fees')).text();
    expect(fr).toContain('Provisoire, non confirmé');
    expect(fr).toContain('1 wilaya a encore un tarif provisoire');
  });
});

describe('preview and apply', () => {
  test('preview writes nothing; apply writes one audit row per changed wilaya, sets updated_by', async () => {
    const { html, apply } = await previewAndApply(USERS.owner, await form({ fee_16: '650', fee_49: '900' }));
    expect(html).toContain('2 wilayas vont changer');
    expect(apply!.status).toBe(303);
    expect((await fee(16))!.fee_dzd).toBe(650);
    expect((await fee(49))).toMatchObject({ fee_dzd: 900, available: 0, placeholder: 0 });
    const owner = (await one<{ id: number }>('select id from admin_users where email = ?', USERS.owner))!.id;
    expect((await fee(16))!.updated_by).toBe(owner);
    const rows = await audits();
    expect(rows.map((r) => r.entity_id).sort()).toEqual(['16', '49']);
    const r16 = rows.find((r) => r.entity_id === '16')!;
    expect(JSON.parse(r16.before!)).toEqual({ feeDzd: 600, available: true, placeholder: false });
    expect(JSON.parse(r16.after!)).toEqual({ feeDzd: 650, available: true, placeholder: false });
    expect(rows.find((r) => r.entity_id === '49')!.before).toBeNull();
  });

  test('availability-only save keeps the placeholder; only the explicit confirm clears it', async () => {
    await previewAndApply(USERS.owner, await form({ avail_31: null }));
    expect(await fee(31)).toMatchObject({ available: 0, placeholder: 1 });
    await previewAndApply(USERS.owner, await form({ fee_31: '850' }));
    expect(await fee(31)).toMatchObject({ fee_dzd: 850, placeholder: 1 });
    const { html } = await previewAndApply(USERS.owner, await form({ confirm_31: '1' }));
    expect(html).toContain('Tarifs provisoires que vous confirmez');
    expect(await fee(31)).toMatchObject({ placeholder: 0 });
  });

  test('fee 0 allowed with a warning; a > 3× rise is flagged', async () => {
    const res = await postAs(h, USERS.owner, '/fees/preview', await form({ fee_16: '0', fee_1: '3500' }));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('livraison gratuite');
    expect(html).toContain('plus que triplé');
  });

  test('bulk: fee + available + confirm on a range and on ticked rows', async () => {
    await previewAndApply(USERS.owner, await form({ range: '59-61', sel_31: '1', bulk_fee: '1 200', bulk_avail: 'on', bulk_confirm: '1' }));
    for (const code of [59, 60, 61]) expect(await fee(code)).toMatchObject({ fee_dzd: 1200, available: 1 });
    expect(await fee(31)).toMatchObject({ fee_dzd: 1200, placeholder: 0 });
    expect((await fee(16))!.fee_dzd).toBe(600);
  });

  test.each([['1.5'], ['-1'], ['1e3'], ['1,500'], ['100001']])('refuses fee %j (422, nothing written)', async (value) => {
    const res = await postAs(h, USERS.owner, '/fees/preview', await form({ fee_16: value }));
    expect(res.status).toBe(422);
    expect((await fee(16))!.fee_dzd).toBe(600);
  });

  test('Eastern-Arabic digits and zero centimes are accepted', async () => {
    await previewAndApply(USERS.owner, await form({ fee_16: '٧٠٠' }));
    expect((await fee(16))!.fee_dzd).toBe(700);
    await previewAndApply(USERS.owner, await form({ fee_16: '650,00' }));
    expect((await fee(16))!.fee_dzd).toBe(650);
  });

  test('an existing fee cannot be blanked; a bad range is refused', async () => {
    expect((await postAs(h, USERS.owner, '/fees/preview', await form({ fee_16: '' }))).status).toBe(422);
    expect((await postAs(h, USERS.owner, '/fees/preview', await form({ range: '70' }))).status).toBe(422);
  });

  test('stale: a row changed (or created) after the form was rendered → 409, nothing written', async () => {
    const data = await form({ fee_16: '700', fee_1: '1100' });
    await h.db.prepare('update delivery_fees set fee_dzd = 610, updated_at = updated_at + 1 where wilaya_code = 16').run();
    const res = await postAs(h, USERS.owner, '/fees/apply', data);
    expect(res.status).toBe(409);
    expect((await fee(16))!.fee_dzd).toBe(610);
    expect((await fee(1))!.fee_dzd).toBe(1000);
    expect(await audits()).toHaveLength(0);
    const data2 = await form({ fee_49: '900' });
    await h.db.prepare('insert into delivery_fees (wilaya_code, fee_dzd) values (49, 500)').run();
    expect((await postAs(h, USERS.owner, '/fees/apply', data2)).status).toBe(409);
    expect((await fee(49))!.fee_dzd).toBe(500);
  });

  test('no change → no audit, 303', async () => {
    expect((await postAs(h, USERS.owner, '/fees/apply', await form())).status).toBe(303);
    expect(await audits()).toHaveLength(0);
  });
});

describe('provider and orders', () => {
  test('@hb/db/fees sees the new fee right away; available=0 and placeholder are unavailable', async () => {
    const provider = createAdminTableFeeProvider(createDb(h.db));
    const q = (code: number) => provider.quote({ wilayaCode: code, items: [{ variantId: 1, qty: 1, weightG: null, unitPriceDzd: 100 }] });
    expect(await q(31)).toMatchObject({ available: false }); // placeholder, test env is not development
    await previewAndApply(USERS.owner, await form({ fee_16: '777', avail_1: null, confirm_31: '1' }));
    expect(await q(16)).toMatchObject({ available: true, feeDzd: 777 });
    expect(await q(1)).toMatchObject({ available: false });
    expect(await q(31)).toMatchObject({ available: true, feeDzd: 800 });
  });

  test('an existing order keeps its fee after an apply', async () => {
    const cat = (await one<{ id: number }>("insert into categories (slug_fr, slug_ar, name_fr, name_ar) values ('fees-c', 'fees-c', 'C', 'ص') returning id"))!.id;
    const pid = (await one<{ id: number }>("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('simple', ?, 'fees-p', 'fees-p', 'P', 'ب') returning id", cat))!.id;
    const vid = (await one<{ id: number }>("insert into variants (product_id, sku, price_dzd, is_default) values (?, 'FEES-P', 2000, 1) returning id", pid))!.id;
    const res = await createOrder(createDb(h.db), {
      customer: { phoneE164: '+213555123456', name: 'Test' },
      order: { ref: 'HB-FEES1', idempotencyKey: crypto.randomUUID(), lang: 'fr', wilayaCode: 16, communeId: 1601, subtotalDzd: 2000, feeDzd: 600, totalDzd: 2600, feeSource: 'table', flags: [], turnstile: null, fillMs: null, riskScore: null, ipHash: null },
      lines: [{ variantId: vid, productId: pid, nameFr: 'P', nameAr: 'ب', variantLabelFr: null, variantLabelAr: null, sku: 'FEES-P', unitPriceDzd: 2000, qty: 1, lineTotalDzd: 2000 }],
    });
    expect(res.ok).toBe(true);
    await previewAndApply(USERS.owner, await form({ fee_16: '900' }));
    expect((await fee(16))!.fee_dzd).toBe(900);
    expect(await one<{ fee_dzd: number; total_dzd: number }>("select fee_dzd, total_dzd from orders where ref = 'HB-FEES1'")).toEqual({ fee_dzd: 600, total_dzd: 2600 });
  });

  test('quote simulator uses the same provider', async () => {
    const html = await (await h.as(USERS.confirmer, '/fees/quote')).text();
    expect(html).toContain('action="/fees/quote"');
  });
});
