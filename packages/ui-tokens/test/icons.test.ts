import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ICON_MAX_BYTES, MIRRORED, buildIcons } from '../src/gen/build-icons.ts';
import { ICONS_MANIFEST_OUT, ICONS_TS_OUT, readIconFiles } from '../src/gen/source.ts';
import { ICON_MIRROR_RULE, icons, type IconName } from '../src/index.ts';

const REQUIRED: IconName[] = [
  'search', 'menu', 'close', 'bag', 'chevron-start', 'chevron-end', 'arrow-start', 'arrow-end', 'phone', 'whatsapp',
  'truck', 'check', 'plus', 'minus', 'info', 'alert', 'filter', 'home', 'grid', 'user', 'star',
];
const files = readIconFiles();
const std = files.find((f) => f.name === 'check')!;

describe('icon set', () => {
  test('manifest and icons.generated.ts equal a fresh build', () => {
    const out = buildIcons(files);
    expect(readFileSync(ICONS_MANIFEST_OUT, 'utf8')).toBe(out.manifest);
    expect(readFileSync(ICONS_TS_OUT, 'utf8')).toBe(out.ts);
  });

  test('the full TOKENS-3 set is present', () => {
    expect(Object.keys(icons).sort()).toEqual([...REQUIRED].sort());
  });

  test(`every icon ≤ ${ICON_MAX_BYTES} B as a file and inline; 24 grid, 1.5 stroke, currentColor`, () => {
    for (const f of files) expect(Buffer.byteLength(f.svg), f.name).toBeLessThanOrEqual(ICON_MAX_BYTES);
    for (const [name, i] of Object.entries(icons)) {
      expect(Buffer.byteLength(i.svg), name).toBeLessThanOrEqual(ICON_MAX_BYTES);
      expect(i.svg, name).toMatch(/^<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" /);
      expect(i.svg, name).not.toContain('xmlns');
    }
  });

  test('exactly the directional icons mirror, flagged with data-mirror, flipped by :dir(rtl)', () => {
    const mirrored = Object.entries(icons).filter(([, i]) => i.mirror).map(([n]) => n).sort();
    expect(mirrored).toEqual([...MIRRORED].sort());
    for (const [name, i] of Object.entries(icons)) expect(i.svg.includes(' data-mirror>'), name).toBe(i.mirror);
    expect(ICON_MIRROR_RULE).toBe(':dir(rtl) [data-mirror]{transform:scaleX(-1)}');
  });

  test('rejects contract violations', () => {
    const bad = (svg: string, name = 'x'): (() => unknown) => () => buildIcons([...files, { name, svg }]);
    expect(bad(std.svg.replace('stroke-width="1.5"', 'stroke-width="2"'))).toThrow(/standard/);
    expect(bad(std.svg.replace('currentColor', '#000'))).toThrow(/standard/);
    expect(bad(std.svg.replace('</svg>', `<path d="${'M1 1'.repeat(40)}"/></svg>`))).toThrow(/> 300 B/);
    expect(bad(std.svg.replace('<path ', '<path fill="red" '))).toThrow(/geometry/);
    expect(bad(std.svg.replace('</svg>', '<script/></svg>'))).toThrow(/shape elements/);
    expect(bad(std.svg.replace('stroke-linejoin="round">', 'stroke-linejoin="round" data-mirror>'))).toThrow(/data-mirror must be false/);
    expect(() => buildIcons(files.filter((f) => f.name !== 'arrow-end'))).toThrow(/arrow-end missing/);
  });
});
