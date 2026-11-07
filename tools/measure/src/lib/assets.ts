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

/**
 * A CSS length as used in `sizes` → CSS px at viewport width `vw`: a plain length (px, vw, em,
 * rem) or a math function — calc() with + − × ÷ and parentheses, min(), max(), clamp(), nested
 * (MEAS-1 fix: `calc((100vw - 44px) / 2)` used to fall back to the largest candidate). A number
 * without unit may only multiply or divide a length, as in CSS. Anything else → null (the
 * caller then takes the conservative choice).
 */
export function evalLength(len: string, vw: number): number | null {
  type V = { v: number; len: boolean };
  const toks = len.trim().match(/\d*\.?\d+(?:e[+-]?\d+)?(?:px|vw|em|rem)?|[a-z-]+\(|[()+\-*/,]/gi);
  if (!toks || toks.join('') !== len.replace(/\s+/g, '')) return null; // something we do not know
  let i = 0;
  const peek = (): string | undefined => toks[i];
  const fail = (): never => { throw new Error('css'); };
  const unit = (t: string): V => {
    const m = /^(\d*\.?\d+(?:e[+-]?\d+)?)(px|vw|em|rem)?$/i.exec(t);
    if (!m) return fail();
    const n = Number(m[1]);
    const u = (m[2] ?? '').toLowerCase();
    if (!u) return { v: n, len: false };
    return { v: u === 'px' ? n : u === 'vw' ? (n * vw) / 100 : n * 16, len: true };
  };
  const args = (): V[] => {
    const out = [expr()];
    while (peek() === ',') { i++; out.push(expr()); }
    if (toks[i++] !== ')') fail();
    return out;
  };
  const factor = (): V => {
    const t = toks[i++];
    if (t === undefined) return fail();
    if (t === '-') { const f = factor(); return { v: -f.v, len: f.len }; }
    if (t === '(' || /^calc\($/i.test(t)) { const e = expr(); if (toks[i++] !== ')') fail(); return e; }
    const fn = /^(min|max|clamp)\($/i.exec(t)?.[1]?.toLowerCase();
    if (fn) {
      const a = args();
      if (!a.every((x) => x.len) || (fn === 'clamp' && a.length !== 3)) fail();
      const n = a.map((x) => x.v);
      return { v: fn === 'min' ? Math.min(...n) : fn === 'max' ? Math.max(...n) : Math.max(n[0]!, Math.min(n[1]!, n[2]!)), len: true };
    }
    return unit(t);
  };
  const term = (): V => {
    let l = factor();
    while (peek() === '*' || peek() === '/') {
      const op = toks[i++];
      const r = factor();
      if (op === '*') { if (l.len && r.len) fail(); l = { v: l.v * r.v, len: l.len || r.len }; }
      else { if (r.len || r.v === 0) fail(); l = { v: l.v / r.v, len: l.len }; }
    }
    return l;
  };
  const expr = (): V => {
    let l = term();
    while (peek() === '+' || peek() === '-') {
      const op = toks[i++];
      const r = term();
      if (l.len !== r.len) fail();
      l = { v: op === '+' ? l.v + r.v : l.v - r.v, len: l.len };
    }
    return l;
  };
  try {
    const r = expr();
    return i === toks.length && r.len ? r.v : null;
  } catch {
    return null;
  }
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

/**
 * CSS as the browser reads it for URLs: comments removed and escapes decoded
 * (`url("\\68ttps://x")` is `https://x`; `/* font-display: optional *\/` is not a declaration).
 */
export function cleanCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_m, h: string) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
    })
    .replace(/\\([^\n0-9a-fA-F])/g, '$1');
}

/** `url(...)`, `@import "..."` and `image-set("...")` references in CSS text. */
export function cssUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  const imp = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = imp.exec(css))) out.push(m[1] ?? m[2] ?? '');
  // image-set("a.avif" 1x, …) / -webkit-image-set: bare strings are URLs too (url() ones are
  // already collected above)
  const set = /image-set\(((?:[^()]|\([^()]*\))*)\)/gi;
  while ((m = set.exec(css))) {
    const strs = /(?:^|[\s,])(?:"([^"]+)"|'([^']+)')/g;
    let q: RegExpExecArray | null;
    while ((q = strs.exec(m[1] ?? ''))) out.push((q[1] ?? q[2] ?? '').trim());
  }
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
/** Vector images: exempt from the AVIF/srcset rule (logos, icons). */
export const SVG_REF = /^data:image\/svg\+xml|\.svg(?:[?#]|$)/i;
/** Raster data: URIs (they bypass srcset, AVIF and the byte checks). */
export const RASTER_DATA = /^data:image\/(?!svg\+xml)/i;
export const JS_EXT = /\.m?js(?:[?#]|$)/i;
