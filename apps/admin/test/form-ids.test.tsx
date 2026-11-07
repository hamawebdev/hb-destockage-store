/** @jsxImportSource hono/jsx */
// Repeated forms (one per row/card) need unique element ids: idSuffix + a dev/test guard.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { requirePerm } from '../src/auth/require-role.ts';
import { Checkbox, ErrorSummary, Form, LocalizedField, NumberInput, Select, fieldId } from '../src/ui/form.tsx';
import { duplicateIds } from '../src/ui/layout.tsx';
import { harness, testIdentify, USERS, type Harness } from './helpers.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

function Card(props: { variantId?: number }) {
  return (
    <Form action={`/stock/${props.variantId ?? 0}`}>
      <NumberInput name="stock" label="Stock" value="3" idSuffix={props.variantId} />
      <Select name="reason" label="Motif" options={[{ value: 'count', label: 'Inventaire' }]} idSuffix={props.variantId} />
      <Checkbox name="active" label="Actif" checked idSuffix={props.variantId} />
      <LocalizedField name="note" label="Note" values={{}} idSuffix={props.variantId} />
    </Form>
  );
}

describe('idSuffix', () => {
  test('default ids are unchanged; suffixes are sanitised', () => {
    expect(fieldId('stock')).toBe('f-stock');
    expect(fieldId('stock', 12)).toBe('f-stock-12');
    expect(fieldId('stock', 'a b"<')).toBe('f-stock-a_b__');
  });
  test('two cards with the same fields: unique ids, each label points at its own input', async () => {
    const html = String(await (<div>{[<Card variantId={7} />, <Card variantId={8} />]}</div>).toString());
    expect(duplicateIds(html)).toEqual([]);
    for (const id of ['f-stock-7', 'f-stock-8', 'f-reason-7', 'f-reason-8', 'f-active-7', 'f-active-8', 'f-note_fr-7', 'f-note_ar-8']) {
      expect(html, id).toContain(`id="${id}"`);
      expect(html, id).toContain(`for="${id}"`);
    }
    // name (the submitted key) is unchanged
    expect(html.match(/name="stock"/g)).toHaveLength(2);
  });
  test('ErrorSummary links to the suffixed id', async () => {
    const html = String(await (<ErrorSummary errors={{ stock: 'Trop grand' }} idSuffix={8} />).toString());
    expect(html).toContain('href="#f-stock-8"');
  });
});

describe('duplicate-id guard in the layout (dev/test only)', () => {
  function app() {
    const a = createApp({ identify: testIdentify });
    a.get('/t/cards/:mode', requirePerm('dashboard.view'), (c) =>
      c.render(c.req.param('mode') === 'bad' ? <>{[<Card />, <Card />]}</> : <>{[<Card variantId={1} />, <Card variantId={2} />]}</>, { title: 'cards' }),
    );
    return a;
  }
  test('repeated fields without idSuffix → 500 in test and development', async () => {
    for (const ENV of ['test', 'development'] as const) {
      const res = await app().request('/t/cards/bad', { headers: { 'x-test-user': USERS.owner } }, { ...h.env, ENV, DEV_SESSION_SECRET: 'x'.repeat(40) });
      expect(res.status, ENV).toBe(500);
    }
  });
  test('with idSuffix → 200', async () => {
    const res = await app().request('/t/cards/good', { headers: { 'x-test-user': USERS.owner } }, h.env);
    expect(res.status).toBe(200);
  });
  test('production renders without the check (no extra cost)', async () => {
    const env = { ...h.env, ENV: 'production' as const, ACCESS_TEAM_DOMAIN: 'https://t.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64) };
    const res = await app().request('/t/cards/bad', { headers: { 'x-test-user': USERS.owner } }, env);
    expect(res.status).toBe(200);
  });
  test('every existing admin page has unique ids', async () => {
    for (const p of ['/dashboard', '/users', '/users/new', '/settings', '/audit', '/orders', '/products']) {
      expect((await h.as(USERS.owner, p)).status, p).toBe(200);
    }
  });
});
