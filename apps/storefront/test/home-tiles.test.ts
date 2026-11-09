// HOME-0: the category tile layout fills every row at any category count, and only the first photo is the LCP.
import { describe, expect, test } from 'vitest';
import type { CategoryLink, ImageProps } from '@hb/catalog';
import { categoryTiles, desktopSpans, mobileSpans } from '../src/components/home/tiles.ts';

const image: ImageProps = { src: '/img/a-720.avif', srcset: '/img/a-360.avif 360w', sizes: 'x', candidates: [], width: 720, height: 720, alt: 'photo', type: 'image/avif', lcp: false, placeholder: false };
const cat = (id: number, withImage = true): CategoryLink => ({ id, name: `c${id}`, href: `/fr/c/${id}/`, count: 0, image: withImage ? image : null, placeholder: false });

/** Lay spans out in order and return the used columns of each row (every row must be exactly full). */
function rows(spans: readonly number[], columns: number): number[] {
  const out: number[] = [];
  let used = 0;
  for (const s of spans) {
    used += s;
    if (used === columns) {
      out.push(used);
      used = 0;
    } else if (used > columns) {
      throw new Error(`span ${s} overflows a row (${used}/${columns})`);
    }
  }
  if (used) out.push(used);
  return out;
}

describe('category tile layout', () => {
  const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 24];
  test.each(counts)('%i categories fill every row below 768 px', (n) => {
    const spans = mobileSpans(n).map((s) => (s === 'full' ? 2 : 1));
    expect(spans).toHaveLength(n);
    for (const used of rows(spans, 2)) expect(used).toBe(2);
  });
  test.each(counts)('%i categories fill every row from 768 px', (n) => {
    const spans = desktopSpans(n);
    expect(spans).toHaveLength(n);
    for (const used of rows(spans, 6)) expect(used).toBe(6);
  });
  test('odd count leads with one full-width tile on phones', () => {
    expect(mobileSpans(5)).toEqual(['full', 'half', 'half', 'half', 'half']);
    expect(mobileSpans(1)).toEqual(['full']);
    expect(mobileSpans(2)).toEqual(['full', 'full']);
  });
});

describe('categoryTiles', () => {
  test('marks only the first photo as the LCP, with a sizes attribute for its own layout', () => {
    const tiles = categoryTiles([cat(1), cat(2), cat(3)]);
    expect(tiles.map((t) => t.image?.lcp)).toEqual([true, false, false]);
    expect(tiles[0]!.image!.sizes).toContain('calc(100vw - 2rem)');
    expect(tiles[1]!.image!.sizes).toContain('calc(50vw - 1.375rem)');
    expect(tiles[0]!.image!.alt).toBe('');
  });
  test('a category with no clean photo stays out of the section; the layout counts only the photo tiles', () => {
    const tiles = categoryTiles([cat(1, false), cat(2), cat(3)]);
    expect(tiles.map((t) => [t.category.id, t.image.lcp])).toEqual([[2, true], [3, false]]);
    expect(tiles.map((t) => t.mobile)).toEqual(['full', 'full']);
  });
});
