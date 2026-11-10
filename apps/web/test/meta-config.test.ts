// Where Meta server events may go, and that a bad setting only turns them off (META-3).
import { describe, expect, test } from 'vitest';
import { GRAPH_ORIGIN, GRAPH_VERSION, readMetaConfig } from '../src/meta/capi.ts';
import { blockMetaFetch } from './support/no-meta-fetch.ts';

blockMetaFetch();

const PIXEL = '000000000000000';
const base = { META_PIXEL_ID: PIXEL, META_ACCESS_TOKEN: 'FAKE_TEST_TOKEN' };

describe('readMetaConfig', () => {
  test('production always targets Meta, even with META_GRAPH_BASE set', () => {
    const cfg = readMetaConfig({ ENV: 'production', ...base, META_GRAPH_BASE: 'http://127.0.0.1:9' }, 'comptoirdeluxe.com');
    expect(cfg).toMatchObject({ on: true, eventsUrl: `${GRAPH_ORIGIN}/${GRAPH_VERSION}/${PIXEL}/events` });
  });
  test.each(['development', 'test'])('%s with no base: off', (ENV) => {
    expect(readMetaConfig({ ENV, ...base }, 'localhost').on).toBe(false);
  });
  test.each(['https://graph.facebook.com', 'http://example.com', 'http://169.254.0.1', 'nonsense'])('development with non-loopback base %s: off', (b) => {
    expect(readMetaConfig({ ENV: 'development', ...base, META_GRAPH_BASE: b }, 'localhost').on).toBe(false);
  });
  test.each(['http://127.0.0.1:4352', 'http://localhost:4352', 'http://[::1]:4352'])('development with loopback base %s: on', (b) => {
    expect(readMetaConfig({ ENV: 'development', ...base, META_GRAPH_BASE: b }, 'localhost')).toMatchObject({
      on: true,
      eventsUrl: `${new URL(b).origin}/${GRAPH_VERSION}/${PIXEL}/events`,
    });
  });
  test.each([
    ['nothing set', { ENV: 'production' }],
    ['no token', { ENV: 'production', META_PIXEL_ID: PIXEL }],
    ['no pixel', { ENV: 'production', META_ACCESS_TOKEN: 'FAKE_TEST_TOKEN' }],
    ['empty pixel', { ENV: 'production', META_PIXEL_ID: '', META_ACCESS_TOKEN: 'FAKE_TEST_TOKEN' }],
    ['malformed pixel', { ENV: 'production', META_PIXEL_ID: 'abc', META_ACCESS_TOKEN: 'FAKE_TEST_TOKEN' }],
  ])('%s: off, no throw', (_n, env) => {
    expect(readMetaConfig(env, 'comptoirdeluxe.com').on).toBe(false);
  });
  test('test_event_code only when set', () => {
    expect(readMetaConfig({ ENV: 'production', ...base }, 'x.dz')).not.toHaveProperty('testEventCode');
    expect(readMetaConfig({ ENV: 'production', ...base, META_TEST_EVENT_CODE: 'TEST123' }, 'x.dz')).toMatchObject({ testEventCode: 'TEST123' });
  });
});
