// Meta build settings and what the build emits with them (META-4; contract §2.1, §6).
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { ProductProps } from '@hb/catalog';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { metaBuildConfig } from '../src/lib/meta.mjs';
import ProductView from '../src/components/catalog/ProductView.astro';

const PIXEL = '000000000000000';

describe('metaBuildConfig', () => {
  it.each([[{}], [{ META_PIXEL_ID: '' }], [{ META_PIXEL_ID: '   ' }]])('off when unset or empty: %j', (env) => {
    expect(metaBuildConfig(env)).toBeNull();
  });
  it('consent is required by default', () => {
    expect(metaBuildConfig({ META_PIXEL_ID: PIXEL })).toEqual({ pixelId: PIXEL, consent: 'required' });
  });
  it.each(['', '1'])('consent required when %j', (v) => {
    expect(metaBuildConfig({ META_PIXEL_ID: PIXEL, META_CONSENT_REQUIRED: v })?.consent).toBe('required');
  });
  it('only 0 turns consent off', () => {
    expect(metaBuildConfig({ META_PIXEL_ID: PIXEL, META_CONSENT_REQUIRED: '0' })?.consent).toBe('off');
  });
  it.each(['false', 'off', 'no', '2'])('malformed META_CONSENT_REQUIRED %j fails the build', (v) => {
    expect(() => metaBuildConfig({ META_PIXEL_ID: PIXEL, META_CONSENT_REQUIRED: v })).toThrow(/META_CONSENT_REQUIRED/);
  });
  it('a malformed consent value fails even with no Pixel', () => {
    expect(() => metaBuildConfig({ META_CONSENT_REQUIRED: 'off' })).toThrow(/META_CONSENT_REQUIRED/);
  });
  it.each(['abc', '123', '12345678901234567'])('malformed Pixel ID %j fails the build, not echoing the value', (v) => {
    expect(() => metaBuildConfig({ META_PIXEL_ID: v })).toThrow(/META_PIXEL_ID must be/);
    try {
      metaBuildConfig({ META_PIXEL_ID: v });
    } catch (e) {
      expect((e as Error).message).not.toContain(v);
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
    vi.stubEnv('META_PIXEL_ID', '');
    expect(await container.renderToString(ProductView, { props: { ...props } })).not.toContain('data-meta-content');
  });
  it('default variant and its price when configured', async () => {
    vi.stubEnv('META_PIXEL_ID', PIXEL);
    const html = await container.renderToString(ProductView, { props: { ...props } });
    const def = props.variants.find((v) => v.isDefault) ?? props.variants[0]!;
    expect(html).toMatch(/data-meta-content="\d+:\d+"/);
    expect(html).toContain(`data-meta-content="${def.id}:${def.price.amountDzd}"`);
  });
});
