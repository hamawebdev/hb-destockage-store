/** Helpers shared by the measurement tools: brotli, srcset/sizes, CSS url(), AVIF dimensions. */
import { brotliCompressSync, constants as Z } from 'node:zlib';

/** Brotli size of a buffer at a given quality (0–11), text mode. */
export function brSize(input: Buffer | string, quality = 11): number {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return brotliCompressSync(b, {
    params: {
      [Z.BROTLI_PARAM_QUALITY]: quality,
      [Z.BROTLI_PARAM_SIZE_HINT]: b.length,
      [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT,
    },
  }).length;
}

export interface Candidate {
  url: string;
  w?: number;
  x?: number;
}

/** Parse a `srcset` / `imagesrcset` value (HTML "parse a srcset attribute", simplified). */
export function parseSrcset(value: string): Candidate[] {
  const out: Candidate[] = [];
  const s = value || '';
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i] ?? '')) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j] ?? '')) j++;
    let url = s.slice(i, j);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      i = j;
    } else {
      let k = j;
      let depth = 0;
      while (k < s.length) {
        const c = s[k];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
        k++;
      }
      desc = s.slice(j, k).trim();
      i = k + 1;
    }
    const cand: Candidate = { url };
    for (const d of desc.split(/\s+/).filter(Boolean)) {
      const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(d);
      if (!m) continue;
      if ((m[2] ?? '').toLowerCase() === 'w') cand.w = Number(m[1]);
      else cand.x = Number(m[1]);
    }
    if (url) out.push(cand);
  }
  return out;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Evaluate a media condition at a viewport width. Supports `(min-width|max-width: N px|em|rem)`
 * joined with `and`. Returns null when the condition is not understood.
 */
export function evalMedia(cond: string, vw: number): boolean | null {
  const clauses = cond.split(/\band\b/i).map((c) => c.trim()).filter(Boolean);
  if (!clauses.length) return null;
  for (const c of clauses) {
    const m = /^\(\s*(min|max)-width\s*:\s*([\d.]+)(px|em|rem)\s*\)$/i.exec(c);
    if (!m) return null;
    const px = Number(m[2]) * ((m[3] ?? '').toLowerCase() === 'px' ? 1 : 16);
    const ok = (m[1] ?? '').toLowerCase() === 'min' ? vw >= px : vw <= px;
    if (!ok) return false;
  }
  return true;
}

function evalLength(len: string, vw: number): number | null {
  const m = /^([\d.]+)(px|vw|em|rem)$/i.exec(len);
  if (m) {
    const n = Number(m[1]);
    const u = (m[2] ?? '').toLowerCase();
    return u === 'px' ? n : u === 'vw' ? (n * vw) / 100 : n * 16;
  }
  const f = /^(calc|min|max)\((.*)\)$/is.exec(len);
  if (!f) return null;
  const fn = (f[1] ?? '').toLowerCase();
  const inner = f[2] ?? '';
  if (fn === 'min' || fn === 'max') {
    const vals = splitTopLevel(inner, ',').map((x) => evalLength(x.trim(), vw));
    if (vals.some((v) => v === null)) return null;
    const nums = vals as number[];
    return fn === 'min' ? Math.min(...nums) : Math.max(...nums);
  }
  const terms = inner.trim().split(/\s+([+-])\s+/);
  let total = evalLength(terms[0] ?? '', vw);
  if (total === null) return null;
  for (let k = 1; k < terms.length; k += 2) {
    const v = evalLength(terms[k + 1] ?? '', vw);
    if (v === null) return null;
    total = terms[k] === '+' ? total + v : total - v;
  }
  return total;
}

/**
 * Evaluate a `sizes` attribute at a viewport width → slot width in CSS px.
 * Returns null when it cannot be understood (`auto`, unknown media features, unknown units), so
 * the caller can fall back to the conservative choice (the largest candidate).
 */
export function evalSizes(sizes: string | undefined, vw: number): number | null {
  if (!sizes || !sizes.trim()) return vw; // default 100vw
  for (const raw of splitTopLevel(sizes, ',')) {
    const p = raw.trim();
    if (!p) continue;
    let len = p;
    const m = /^(\(.*?\)(?:\s+and\s+\(.*?\))*)\s+(.+)$/is.exec(p);
    if (m) {
      const ok = evalMedia(m[1] ?? '', vw);
      if (ok === null) return null;
      if (!ok) continue;
      len = m[2] ?? '';
    }
    if (len === 'auto') return null;
    return evalLength(len, vw);
  }
  return vw;
}

/**
 * The candidate a browser picks: sort by density, take the first whose density ≥ DPR, else the
 * densest. Chromium may pick the next-smaller one (geometric-mean rule); we do not, so the
 * estimate errs on the larger file. Unknown slot width → the largest candidate.
 */
export function pickCandidate(cands: Candidate[], slotPx: number | null, dpr: number): Candidate | null {
  if (!cands.length) return null;
  if (slotPx === null || slotPx <= 0) {
    return cands.reduce((a, b) => ((b.w ?? 0) > (a.w ?? 0) ? b : a));
  }
  const withD = cands
    .map((c) => ({ c, d: c.w ? c.w / slotPx : (c.x ?? 1) }))
    .sort((a, b) => a.d - b.d);
  const hit = withD.find((e) => e.d >= dpr) ?? withD[withD.length - 1];
  return hit ? hit.c : null;
}

/** True when the buffer is an ISO-BMFF file whose ftyp brands include avif/avis. */
export function isAvif(buf: Buffer): boolean {
  if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const size = Math.min(buf.readUInt32BE(0), buf.length, 256);
  return /avi[fs]/.test(buf.toString('latin1', 8, size));
}

/** Primary image dimensions of an AVIF file (first `ispe` property box), or null. */
export function avifSize(buf: Buffer): { width: number; height: number } | null {
  if (!isAvif(buf)) return null;
  const k = buf.indexOf('ispe', 0, 'latin1');
  if (k < 4 || k + 16 > buf.length) return null;
  return { width: buf.readUInt32BE(k + 8), height: buf.readUInt32BE(k + 12) };
}

/** `url(...)` and `@import "..."` references in CSS text. */
export function cssUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  const imp = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = imp.exec(css))) out.push(m[1] ?? m[2] ?? '');
  return out.filter(Boolean);
}

export interface FontFace {
  family: string;
  urls: string[];
  display: string | null;
  unicodeRange: string | null;
}

/** `@font-face` blocks in CSS with their `src` URLs (data: excluded) and `font-display`. */
export function fontFaces(css: string): FontFace[] {
  const out: FontFace[] = [];
  const re = /@font-face\s*\{([^}]*)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const body = m[1] ?? '';
    const src = /(?:^|;)\s*src\s*:([^;]*)/i.exec(body)?.[1] ?? '';
    const fam = /font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i.exec(body);
    out.push({
      family: (fam?.[1] ?? fam?.[2] ?? fam?.[3] ?? '').trim(),
      urls: cssUrls(src).filter((u) => !u.startsWith('data:')),
      display: /font-display\s*:\s*([a-z-]+)/i.exec(body)?.[1]?.toLowerCase() ?? null,
      unicodeRange: /unicode-range\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? null,
    });
  }
  return out;
}

export const FONT_EXT = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i;
export const JS_EXT = /\.m?js(?:[?#]|$)/i;
