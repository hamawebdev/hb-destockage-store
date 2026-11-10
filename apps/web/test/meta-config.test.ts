// Where Meta server events may go, and that a bad or missing setting only turns them off (META-3,
// MSET-3: the values come from D1, the destination rule is unchanged).
import { describe, expect, test } from 'vitest';
import { importSettingsKey, sealMetaToken, type MetaServerSettings } from '@hb/db/meta-settings';
import { GRAPH_ORIGIN, GRAPH_VERSION, readMetaConfig } from '../src/meta/capi.ts';
import { blockMetaFetch } from './support/no-meta-fetch.ts';
import { FAKE_PIXEL, FAKE_TOKEN, OTHER_SETTINGS_KEY, TEST_SETTINGS_KEY } from './support/meta-settings.ts';

blockMetaFetch();

const PIXEL = FAKE_PIXEL;
const KEY = { SETTINGS_ENCRYPTION_KEY: TEST_SETTINGS_KEY };
const sealed = async (key = TEST_SETTINGS_KEY) => sealMetaToken(await importSettingsKey(key), FAKE_TOKEN);
const stored = async (over: Partial<MetaServerSettings> = {}): Promise<MetaServerSettings> => ({ pixelId: PIXEL, tokenEnc: await sealed(), testEventCode: null, ...over });

describe('readMetaConfig', () => {
  test('production always targets Meta, even with CAPI_STANDIN_URL set', async () => {
    const cfg = await readMetaConfig({ ENV: 'production', ...KEY, CAPI_STANDIN_URL: 'http://127.0.0.1:9' }, await stored(), PIXEL, 'comptoirdeluxe.com');
    expect(cfg).toMatchObject({ on: true, eventsUrl: `${GRAPH_ORIGIN}/${GRAPH_VERSION}/${PIXEL}/events`, token: FAKE_TOKEN });
  });
  test.each(['development', 'test'])('%s with no stand-in URL: off', async (ENV) => {
    expect((await readMetaConfig({ ENV, ...KEY }, await stored(), PIXEL, 'localhost')).on).toBe(false);
  });
  test.each(['https://graph.facebook.com', 'http://example.com', 'http://169.254.0.1', 'nonsense'])('development with non-loopback stand-in URL %s: off', async (b) => {
    expect((await readMetaConfig({ ENV: 'development', ...KEY, CAPI_STANDIN_URL: b }, await stored(), PIXEL, 'localhost')).on).toBe(false);
  });
  test.each(['http://127.0.0.1:4352', 'http://localhost:4352', 'http://[::1]:4352'])('development with loopback stand-in URL %s: on', async (b) => {
    expect(await readMetaConfig({ ENV: 'development', ...KEY, CAPI_STANDIN_URL: b }, await stored(), PIXEL, 'localhost')).toMatchObject({
      on: true,
      eventsUrl: `${new URL(b).origin}/${GRAPH_VERSION}/${PIXEL}/events`,
    });
  });
  test.each<[string, Partial<MetaServerSettings>, string, Record<string, string | undefined>, string]>([
    ['nothing stored', { pixelId: null, tokenEnc: null }, PIXEL, KEY, 'no_pixel'],
    ['no token', { tokenEnc: null }, PIXEL, KEY, 'no_token'],
    ['no Pixel ID', { pixelId: null }, PIXEL, KEY, 'no_pixel'],
    ['page carried another Pixel', {}, '1234567890123456', KEY, 'pixel_mismatch'],
    ['page carried no Pixel', {}, '', KEY, 'pixel_mismatch'],
    ['no key', {}, PIXEL, {}, 'no_key'],
    ['malformed key', {}, PIXEL, { SETTINGS_ENCRYPTION_KEY: 'short' }, 'no_key'],
    ['unreadable token', { tokenEnc: 'AQ==' }, PIXEL, KEY, 'token_unreadable'],
  ])('%s: off with a reason, no throw', async (_n, over, page, key, reason) => {
    expect(await readMetaConfig({ ENV: 'production', ...key }, await stored(over), page, 'comptoirdeluxe.com')).toEqual({ on: false, reason });
  });
  test('a token sealed with another key: token_unreadable', async () => {
    const cfg = await readMetaConfig({ ENV: 'production', ...KEY }, await stored({ tokenEnc: await sealed(OTHER_SETTINGS_KEY) }), PIXEL, 'x.dz');
    expect(cfg).toEqual({ on: false, reason: 'token_unreadable' });
  });
  test('test_event_code only when stored', async () => {
    expect(await readMetaConfig({ ENV: 'production', ...KEY }, await stored(), PIXEL, 'x.dz')).not.toHaveProperty('testEventCode');
    expect(await readMetaConfig({ ENV: 'production', ...KEY }, await stored({ testEventCode: 'TEST123' }), PIXEL, 'x.dz')).toMatchObject({ testEventCode: 'TEST123' });
  });
  test('the old environment variables are not read', async () => {
    const env = { ENV: 'production', ...KEY, META_PIXEL_ID: PIXEL, META_ACCESS_TOKEN: FAKE_TOKEN, META_TEST_EVENT_CODE: 'TEST123' } as never;
    expect(await readMetaConfig(env, { pixelId: null, tokenEnc: null, testEventCode: null }, PIXEL, 'x.dz')).toEqual({ on: false, reason: 'no_pixel' });
  });
});
