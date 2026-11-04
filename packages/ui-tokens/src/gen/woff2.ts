// Minimal WOFF2 reader: decompresses the table stream and returns the cmap's code points.
// Enough to derive @font-face unicode-range from the real file and to check glyph coverage in
// tests without Python. Spec: https://www.w3.org/TR/WOFF2/ (§4 table directory, §5 stream).
import { brotliDecompressSync } from 'node:zlib';

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

function base128(buf: Buffer, pos: { p: number }): number {
  let v = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf.readUInt8(pos.p++);
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) return v;
  }
  throw new Error('woff2: bad UIntBase128');
}

/** Raw (untransformed) bytes of one table from a WOFF2 file. cmap is never transformed. */
export function woff2Table(file: Buffer, want: string): Buffer {
  if (file.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const numTables = file.readUInt16BE(12);
  const compressedLen = file.readUInt32BE(20);
  const pos = { p: 48 };
  const dir: { tag: string; len: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file.readUInt8(pos.p++);
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = file.toString('latin1', pos.p, pos.p + 4);
      pos.p += 4;
    }
    const version = flags >> 6;
    const origLen = base128(file, pos);
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    const len = transformed ? base128(file, pos) : origLen;
    dir.push({ tag: tag as string, len });
  }
  const stream = brotliDecompressSync(file.subarray(pos.p, pos.p + compressedLen));
  let off = 0;
  for (const t of dir) {
    if (t.tag === want) return stream.subarray(off, off + t.len);
    off += t.len;
  }
  throw new Error(`woff2: no ${want} table`);
}

/** Code points mapped to a non-zero glyph by the best Unicode cmap subtable (format 4 or 12). */
export function woff2CodePoints(file: Buffer): Set<number> {
  const cmap = woff2Table(file, 'cmap');
  const n = cmap.readUInt16BE(2);
  const subs: { pid: number; eid: number; off: number; fmt: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = 4 + i * 8;
    const off = cmap.readUInt32BE(r + 4);
    subs.push({ pid: cmap.readUInt16BE(r), eid: cmap.readUInt16BE(r + 2), off, fmt: cmap.readUInt16BE(off) });
  }
  const unicode = (s: { pid: number; eid: number }): boolean => s.pid === 0 || (s.pid === 3 && (s.eid === 1 || s.eid === 10));
  const best = subs.find((s) => unicode(s) && s.fmt === 12) ?? subs.find((s) => unicode(s) && s.fmt === 4);
  if (!best) throw new Error('woff2: no Unicode cmap subtable');
  const out = new Set<number>();
  const o = best.off;
  if (best.fmt === 12) {
    const groups = cmap.readUInt32BE(o + 12);
    for (let g = 0; g < groups; g++) {
      const r = o + 16 + g * 12;
      const start = cmap.readUInt32BE(r);
      const end = cmap.readUInt32BE(r + 4);
      if (cmap.readUInt32BE(r + 8) !== 0 || start !== end) for (let c = start; c <= end; c++) out.add(c);
    }
    return out;
  }
  const segX2 = cmap.readUInt16BE(o + 6);
  const ends = o + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffs = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = cmap.readUInt16BE(ends + s * 2);
    const start = cmap.readUInt16BE(starts + s * 2);
    const delta = cmap.readInt16BE(deltas + s * 2);
    const ro = cmap.readUInt16BE(rangeOffs + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let gid: number;
      if (ro === 0) gid = (c + delta) & 0xffff;
      else {
        const raw = cmap.readUInt16BE(rangeOffs + s * 2 + ro + (c - start) * 2);
        gid = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (gid !== 0) out.add(c);
    }
  }
  return out;
}

/** Compact CSS unicode-range ("U+20-21, U+2C-2E, …") for a set of code points. */
export function unicodeRange(cps: Iterable<number>): string {
  const sorted = [...new Set(cps)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) j++;
    const a = (sorted[i] as number).toString(16).toUpperCase();
    const b = (sorted[j] as number).toString(16).toUpperCase();
    parts.push(i === j ? `U+${a}` : `U+${a}-${b}`);
    i = j + 1;
  }
  return parts.join(', ');
}
