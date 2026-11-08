// <Picture>: AVIF srcset/sizes, width/height always; the LCP image is eager + fetchpriority=high,
// every other image lazy + async decoding (lead's BUG-17 ruling: no eager variant).
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, test } from 'vitest';
import Picture from '../src/components/Picture.astro';

const img = (lcp: boolean) => ({
  src: '/img/ab-720.avif',
  srcset: '/img/ab-360.avif 360w, /img/ab-720.avif 720w',
  sizes: '(min-width: 1024px) 560px, 100vw',
  candidates: [],
  width: 720,
  height: 720,
  alt: 'طقم الحمّام',
  type: 'image/avif' as const,
  lcp,
  placeholder: false,
});

describe('Picture', async () => {
  const c = await AstroContainer.create();
  test('LCP image: eager, fetchpriority high, no lazy, sizes as preloaded', async () => {
    const html = await c.renderToString(Picture, { props: { image: img(true) } });
    expect(html).toMatch(/loading="eager"/);
    expect(html).toMatch(/fetchpriority="high"/);
    expect(html).not.toMatch(/loading="lazy"/);
    expect(html).toContain('sizes="(min-width: 1024px) 560px, 100vw"');
    expect(html).toMatch(/width="720"/);
    expect(html).toMatch(/height="720"/);
  });
  test('any other image: lazy and async, never high priority', async () => {
    const html = await c.renderToString(Picture, { props: { image: img(false), sizes: '96px', class: 'thumb' } });
    expect(html).toMatch(/loading="lazy"/);
    expect(html).toMatch(/decoding="async"/);
    expect(html).not.toMatch(/fetchpriority/);
    expect(html).toContain('sizes="96px"');
    expect(html).toContain('alt="طقم الحمّام"');
  });
  test('overriding the LCP image sizes fails (preload must match the <img>)', async () => {
    await expect(c.renderToString(Picture, { props: { image: img(true), sizes: '50vw' } })).rejects.toThrow(/LCP image's sizes/);
  });
});
