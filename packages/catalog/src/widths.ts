import { IMAGE_WIDTHS } from './types.ts';

/**
 * Candidate widths for an original `width` px wide: never upscale. Every step of `steps` that is
 * ≤ the original, plus the original width itself when it is below the largest step and not a step
 * (e.g. 800 → 360/480/720/800; 300 → 300; 1100 → 360/480/720/960/1100; 1600 → the five steps).
 */
export function candidateWidths(width: number, steps: readonly number[] = IMAGE_WIDTHS): number[] {
  const fit = steps.filter((w) => w <= width);
  const top = Math.max(...steps);
  return width < top && !fit.includes(width) ? [...fit, width] : fit;
}
