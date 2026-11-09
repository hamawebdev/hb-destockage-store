/**
 * Homepage category tiles (HOME-0): layout per tile, computed at build time from how many categories the admin has, so
 * every row fills whatever the count (no orphan tile), without JS.
 *
 *  - Below 768 px, 2 columns: odd counts lead with one full-width tile, 1 or 2 categories run full width, the rest are halves.
 *  - From 768 px, 6 columns: rows of three (span 2); a remainder of 2 opens with two halves (span 3), a remainder of 1
 *    opens with two rows of two halves (span 3), so a lone tile can never trail. One category spans all 6.
 *
 * The first tile with a photo is the LCP (it sits in the first viewport after the compact hero), so it is eager and
 * preloaded; `sizes` is per tile because each layout renders a different width.
 * Owner: shell.
 */
import type { CategoryLink, ImageProps } from '@hb/catalog';

export type MobileSpan = 'full' | 'half';
export type DesktopSpan = 6 | 3 | 2;

export interface Tile {
  readonly category: CategoryLink;
  readonly mobile: MobileSpan;
  readonly desktop: DesktopSpan;
  readonly image: ImageProps;
}

export function mobileSpans(n: number): MobileSpan[] {
  if (n <= 2) return Array<MobileSpan>(n).fill('full');
  return Array.from({ length: n }, (_, i) => (n % 2 === 1 && i === 0 ? 'full' : 'half'));
}

export function desktopSpans(n: number): DesktopSpan[] {
  if (n === 1) return [6];
  const rem = n % 3;
  const head: DesktopSpan[] = rem === 2 ? [3, 3] : rem === 1 ? [3, 3, 3, 3] : [];
  return [...head, ...Array<DesktopSpan>(n - head.length).fill(2)];
}

/** Real rendered width of a tile: container (max 1200 px, fluid gutter) divided by its span. */
function tileSizes(mobile: MobileSpan, desktop: DesktopSpan): string {
  // A lone category (span 6) renders as a band: its photo takes half the width.
  const fraction = desktop === 6 ? 0.5 : desktop / 6;
  const desk = `(min-width: 1280px) ${Math.round(1200 * fraction)}px, (min-width: 768px) calc((100vw - 5rem) * ${fraction.toFixed(4)})`;
  const phone = mobile === 'full' ? 'calc(100vw - 2rem)' : 'calc(50vw - 1.375rem)';
  return `${desk}, ${phone}`;
}

/**
 * Tiles for the categories that have a photo: a category with no clean photo (no products yet, or only photos with a
 * printed price) stays out of this section, still reachable from the navigation, because every tile is led by a photo.
 */
export function categoryTiles(categories: readonly CategoryLink[]): Tile[] {
  const withPhoto = categories.flatMap((c) => (c.image ? [{ c, img: c.image }] : []));
  const mobile = mobileSpans(withPhoto.length);
  const desktop = desktopSpans(withPhoto.length);
  return withPhoto.map(({ c, img }, i) => {
    const m = mobile[i] ?? 'half';
    const d = desktop[i] ?? 2;
    return { category: c, mobile: m, desktop: d, image: { ...img, sizes: tileSizes(m, d), lcp: i === 0, alt: '' } };
  });
}
