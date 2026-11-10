// Meta build settings and what the build emits with them (META-4; contract §2.1, §6).
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { ProductProps } from '@hb/catalog';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSnapshot } from '@hb/catalog/sources';
import { isMetaPixelId } from '@hb/shared';
import { metaBuildConfig, metaConfig, snapshotMetaPixel } from '../src/lib/meta.mjs';
import { PIXEL, snapshotFile, useMetaPixel } from './meta-snapshot.ts';
import ProductView from '../src/components/catalog/ProductView.astro';

describe('metaBuildConfig', () => {
  it.each([[null], [undefined]])('off when the snapshot has no Pixel: %j', (metaPixel) => {
    expect(metaBuildConfig(metaPixel)).toBeNull();
  });
  it('consent required', () => {
    expect(metaBuildConfig({ pixelId: PIXEL, consentRequired: true })).toEqual({ pixelId: PIXEL, consent: 'required' });
  });
  it('only consentRequired false turns consent off', () => {
    expect(metaBuildConfig({ pixelId: PIXEL, consentRequired: false })).toEqual({ pixelId: PIXEL, consent: 'off' });
  });
  it.each(['false', 'off', 0, 1, null, undefined])('malformed consentRequired %j fails the build', (v) => {
    expect(() => metaBuildConfig({ pixelId: PIXEL, consentRequired: v })).toThrow(/consentRequired/);
  });
  it.each(['abc', '123', '12345678901234567', '000000000000000', '', 100000000000001])('malformed Pixel ID %j fails the build, not echoing the value', (v) => {
    expect(() => metaBuildConfig({ pixelId: v, consentRequired: true })).toThrow(/pixelId must be/);
    try {
      metaBuildConfig({ pixelId: v, consentRequired: true });
    } catch (e) {
      if (v !== '') expect((e as Error).message).not.toContain(String(v));
    }
  });
  it.each(['100000000000001', '1234567890123456', '000000000000000', '12345', 'abc'])('same Pixel ID rule as @hb/shared isMetaPixelId: %s', (v) => {
    let ok = true;
    try {
      metaBuildConfig({ pixelId: v, consentRequired: true });
    } catch {
      ok = false;
    }
    expect(ok).toBe(isMetaPixelId(v));
  });
});

describe('metaConfig reads the snapshot, and only the snapshot (MSET-4)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each<[string, { pixelId: string; consentRequired: boolean } | null]>([
    ['no Pixel', null],
    ['Pixel, consent required', { pixelId: PIXEL, consentRequired: true }],
    ['Pixel, consent off', { pixelId: PIXEL, consentRequired: false }],
  ])('export file with %s', (_label, metaPixel) => {
    useMetaPixel(metaPixel);
    expect(metaConfig()).toEqual(metaPixel === null ? null : { pixelId: PIXEL, consent: metaPixel.consentRequired ? 'required' : 'off' });
  });

  it('the old environment variables are ignored: set, with a snapshot that has no Pixel', () => {
    useMetaPixel(null);
    vi.stubEnv('META_PIXEL_ID', PIXEL);
    vi.stubEnv('META_CONSENT_REQUIRED', '0');
    expect(metaConfig()).toBeNull();
  });
  it('the old environment variables cannot change a configured snapshot either', () => {
    useMetaPixel({ pixelId: PIXEL, consentRequired: true });
    vi.stubEnv('META_PIXEL_ID', '1234567890123456');
    vi.stubEnv('META_CONSENT_REQUIRED', '0');
    expect(metaConfig()).toEqual({ pixelId: PIXEL, consent: 'required' });
  });

  it.each(['fixture', 'seed'])('HB_SNAPSHOT=%s: same settings.metaPixel as the real loader', async (which) => {
    vi.stubEnv('HB_SNAPSHOT', which);
    const snapshot = await loadSnapshot();
    expect(snapshotMetaPixel(process.env)).toEqual(snapshot.settings.metaPixel);
    expect(metaConfig()).toEqual(metaBuildConfig(snapshot.settings.metaPixel));
  });
  it('a real export file: same settings.metaPixel as the real loader', async () => {
    vi.stubEnv('HB_SNAPSHOT', 'seed');
    const seed = await loadSnapshot();
    const file = snapshotFile(null).replace(/\.json$/, '-full.json');
    writeFileSync(file, JSON.stringify({ ...seed, settings: { ...seed.settings, metaPixel: { pixelId: PIXEL, consentRequired: false } } }));
    vi.stubEnv('HB_SNAPSHOT', file);
    const loaded = await loadSnapshot();
    expect(loaded.settings.metaPixel).toEqual({ pixelId: PIXEL, consentRequired: false });
    expect(metaConfig()).toEqual(metaBuildConfig(loaded.settings.metaPixel));
  }, 60_000);
  it('HB_SNAPSHOT unset: off', () => {
    vi.stubEnv('HB_SNAPSHOT', '');
    expect(metaConfig()).toBeNull();
  });
  it('no code under the storefront, the CSP script or the Worker reads a META_* environment variable', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    for (const f of ['apps/storefront/src/lib/meta.mjs', 'apps/storefront/astro.config.mjs', 'apps/web/scripts/csp.ts', 'apps/web/src/env.ts', 'apps/web/src/meta/capi.ts']) {
      expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/META_(PIXEL_ID|ACCESS_TOKEN|TEST_EVENT_CODE|CONSENT_REQUIRED|GRAPH_BASE)/);
    }
  });
});

describe('product page marker', () => {
  const page = fixturePages('fr')['/fr/p/poele-28-cm/'];
  if (!page || page.template !== 'product') throw new Error('fixture missing');
  const props = page.props as ProductProps;
  let container: AstroContainer;
  beforeAll(async () => {
    container = await AstroContainer.create();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('absent when Meta is off', async () => {
    useMetaPixel(null);
    expect(await container.renderToString(ProductView, { props: { ...props } })).not.toContain('data-meta-content');
  });
  it('default variant and its price when configured', async () => {
    useMetaPixel({ pixelId: PIXEL, consentRequired: true });
    const html = await container.renderToString(ProductView, { props: { ...props } });
    const def = props.variants.find((v) => v.isDefault) ?? props.variants[0]!;
    expect(html).toMatch(/data-meta-content="\d+:\d+"/);
    expect(html).toContain(`data-meta-content="${def.id}:${def.price.amountDzd}"`);
  });
});
