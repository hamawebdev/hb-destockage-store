/**
 * Guard (lead, SHARED-5): no invisible character may appear literally in packages/shared/src.
 * Bidi marks, zero-width characters, NBSP/NNBSP and similar look like nothing (or like a plain
 * space) in an editor and in a diff, so code points like these must be written as \u escapes.
 * Visible non-ASCII (Arabic and Latin letters in comments, ≠, ×) is fine.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const SRC = new URL('../src/', import.meta.url);

// Format (Cf: bidi marks/embeddings/isolates, ZWSP/ZWNJ/ZWJ/WJ, BOM, soft hyphen…), every space
// separator except U+0020 (NBSP, NNBSP, ideographic…), line/paragraph separators, controls other
// than tab/LF/CR, private use, lone surrogates, and combining marks (invisible on their own).
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Mn}\p{Me}]|(?! )\p{Zs}|(?![\t\n\r])\p{Cc}/u;

test('every src file is free of literal invisible characters', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(10);
  const hits: string[] = [];
  for (const f of files) {
    const lines = readFileSync(new URL(f, SRC), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const ch of line) {
        if (INVISIBLE.test(ch)) {
          const cp = ch.codePointAt(0) ?? 0;
          hits.push(`${f}:${i + 1}: U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
        }
      }
    });
  }
  expect(hits).toEqual([]);
});

test('the guard itself catches what it should', () => {
  for (const cp of [0x200f, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00a0, 0x202f, 0x061c, 0x2066, 0x00ad, 0x0007, 0xe000, 0x064e, 0x0301])
    expect(INVISIBLE.test(String.fromCodePoint(cp)), cp.toString(16)).toBe(true);
  for (const ch of [' ', '\t', 'a', 'é', 'م', '≠', '×', '٠'])
    expect(INVISIBLE.test(ch), ch).toBe(false);
});
