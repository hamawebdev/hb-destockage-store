// SHIP-4 (SHIP-0 contract checks 13b, 21, 22): the webhook route on real workerd D1.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { hashWebhookToken, newWebhookToken } from '@hb/db/webhook-token';
import { startSeeded, type Started } from '../support/harness.ts';

let h: Started;
let token: string;
const path = (courier = 'yalidine', t = token) => `/api/courier-hook/${courier}/${t}`;
const inbox = async () => (await h.env.DB.prepare('select * from courier_webhook_inbox order by id').all()).results as Record<string, unknown>[];
const toBytes = (v: unknown) => new Uint8Array(v as ArrayBuffer | number[]);

beforeAll(async () => {
  h = await startSeeded();
  token = newWebhookToken();
  await h.env.DB.prepare(`insert into courier_accounts (id, courier, webhook_token_hash) values (1, 'yalidine', ?)`).bind(await hashWebhookToken(token)).run();
});
afterAll(async () => h?.server.close());
beforeEach(async () => {
  await h.env.DB.prepare('delete from courier_webhook_inbox').run();
});

test('a valid POST is one inbox row and moves nothing', async () => {
  const body = JSON.stringify({ type: 'parcel_status_updated', events: [] });
  const res = await h.server.fetch(path(), { method: 'POST', body, headers: { 'X-Yalidine-Signature': 'abc', Cookie: 'a=b', Authorization: 'x', 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '1.2.3.4' } });
  expect(res.status).toBe(200);
  const rows = await inbox();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ account_id: 1, courier: 'yalidine', state: 'pending', attempts: 0 });
  const headers = JSON.parse(String(rows[0]!['headers'])) as Record<string, string>;
  expect(headers['x-yalidine-signature']).toBe('abc');
  for (const name of ['cookie', 'authorization', 'cf-connecting-ip', 'x-forwarded-for']) expect(headers[name]).toBeUndefined();
});

test('the stored body is byte-exact, including invalid UTF-8 and a BOM (check 13b)', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0xfe, 0xd8, 0xa8, 0x7d]);
  expect((await h.server.fetch(path(), { method: 'POST', body: bytes })).status).toBe(200);
  expect([...toBytes((await inbox())[0]!['body'])]).toEqual([...bytes]);
  // Stored as a BLOB, so the 32 KiB CHECK counts bytes, not characters (rev-i, SHIP-1 review nit 1).
  expect(await h.env.DB.prepare('select typeof(body) t, length(body) n from courier_webhook_inbox').first()).toEqual({ t: 'blob', n: bytes.length });
});

test('a text body of multi-byte characters is stored as bytes and capped in bytes', async () => {
  const text = 'é'.repeat(16_385); // 32,770 bytes in UTF-8, 16,385 characters
  expect((await h.server.fetch(path(), { method: 'POST', body: text })).status).toBe(413);
  expect((await h.server.fetch(path(), { method: 'POST', body: 'é'.repeat(16_384) })).status).toBe(200);
  expect(await h.env.DB.prepare('select typeof(body) t, length(body) n from courier_webhook_inbox').first()).toEqual({ t: 'blob', n: 32_768 });
});

test('over 32 KiB is refused, exactly 32 KiB is stored', async () => {
  expect((await h.server.fetch(path(), { method: 'POST', body: new Uint8Array(32_769) })).status).toBe(413);
  expect(await inbox()).toHaveLength(0);
  expect((await h.server.fetch(path(), { method: 'POST', body: new Uint8Array(32_768) })).status).toBe(200);
  expect(await inbox()).toHaveLength(1);
});

test('wrong or rotated tokens are 404 and store nothing', async () => {
  expect((await h.server.fetch(path('yalidine', newWebhookToken()), { method: 'POST', body: '{}' })).status).toBe(404);
  expect((await h.server.fetch(path('guepex'), { method: 'POST', body: '{}' })).status).toBe(404);
  expect(await inbox()).toHaveLength(0);
});

test('a disabled account keeps storing while it has a token (rule 13e)', async () => {
  await h.env.DB.prepare('update courier_accounts set enabled = 0 where id = 1').run();
  expect((await h.server.fetch(path(), { method: 'POST', body: '{}' })).status).toBe(200);
  expect(await inbox()).toHaveLength(1);
});

test('the handshake echoes a safe token as text/plain, and refuses a hostile one', async () => {
  const ok = await h.server.fetch(`${path()}?subscribe=x&crc_token=abc.DEF-123_~x`);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe('abc.DEF-123_~x');
  expect(ok.headers.get('content-type')).toContain('text/plain');
  expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  const bad = await h.server.fetch(`${path()}?subscribe=x&crc_token=${encodeURIComponent('<script>alert(1)</script>')}`);
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toContain('<script>');
  expect(await inbox()).toHaveLength(0);
});
