/**
 * Image type and dimensions from the bytes themselves (ACAT-3, plan §6). Never trusts a filename or
 * a Content-Type. Allow-list: JPEG, PNG, WebP, AVIF. Everything else (SVG, HTML, GIF, HEIC, PDF,
 * polyglots whose first bytes are not one of these) is `unsupported_type`. Pure, bounded, never
 * throws, never copies the buffer. Worker-safe (Uint8Array/DataView only).
 */

export type ImageType = 'jpeg' | 'png' | 'webp' | 'avif';
export const MIME: Readonly<Record<ImageType, string>> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };
export const EXT: Readonly<Record<ImageType, string>> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
export const MAX_SIDE = 20_000;

export type SniffResult =
  | { readonly ok: true; readonly type: ImageType; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly error: 'unsupported_type' | 'truncated' | 'bad_dimensions' };

class Truncated extends Error {}

/** Bounds-checked big/little-endian reader over a Uint8Array view. */
class Reader {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  private need(at: number, n: number): void {
    if (at < 0 || at + n > this.bytes.length) throw new Truncated();
  }
  u8(at: number): number {
    this.need(at, 1);
    return this.view.getUint8(at);
  }
  u16(at: number, le = false): number {
    this.need(at, 2);
    return this.view.getUint16(at, le);
  }
  u24le(at: number): number {
    this.need(at, 3);
    return this.view.getUint8(at) | (this.view.getUint8(at + 1) << 8) | (this.view.getUint8(at + 2) << 16);
  }
  u32(at: number, le = false): number {
    this.need(at, 4);
    return this.view.getUint32(at, le);
  }
  ascii(at: number, n: number): string {
    this.need(at, n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[at + i] as number);
    return s;
  }
}

function result(type: ImageType, width: number, height: number): SniffResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    return { ok: false, error: 'bad_dimensions' };
  }
  return { ok: true, type, width, height };
}

export function sniffImage(bytes: Uint8Array): SniffResult {
  const r = new Reader(bytes);
  try {
    if (r.length >= 3 && r.u8(0) === 0xff && r.u8(1) === 0xd8 && r.u8(2) === 0xff) return jpeg(r);
    if (r.length >= 8 && r.ascii(1, 3) === 'PNG' && r.u8(0) === 0x89 && r.u32(4) === 0x0d0a1a0a) return png(r);
    if (r.length >= 12 && r.ascii(0, 4) === 'RIFF' && r.ascii(8, 4) === 'WEBP') return webp(r);
    if (r.length >= 12 && r.ascii(4, 4) === 'ftyp') return avif(r);
    return { ok: false, error: 'unsupported_type' };
  } catch (e) {
    if (e instanceof Truncated) return { ok: false, error: 'truncated' };
    return { ok: false, error: 'unsupported_type' };
  }
}

// ---------------------------------------------------------------------------------------------
// JPEG: walk the segments to the first SOFn; EXIF orientation 5–8 swaps the sides (sharp's
// .rotate() at publish produces the upright image, so stored dims must match it).
// ---------------------------------------------------------------------------------------------

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(r: Reader): SniffResult {
  let at = 2;
  let orientation = 1;
  for (let guard = 0; guard < 10_000; guard++) {
    if (r.u8(at) !== 0xff) return { ok: false, error: 'truncated' };
    let marker = r.u8(at + 1);
    while (marker === 0xff) marker = r.u8(++at + 1); // fill bytes
    at += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
    if (marker === 0xd9 || marker === 0xda) return { ok: false, error: 'truncated' }; // EOI / SOS before any SOF
    const len = r.u16(at);
    if (len < 2) return { ok: false, error: 'truncated' };
    if (marker === 0xe1 && len >= 16 && r.ascii(at + 2, 6) === 'Exif\0\0') orientation = exifOrientation(r, at + 8, len - 8) ?? orientation;
    if (SOF.has(marker)) {
      const height = r.u16(at + 3);
      const width = r.u16(at + 5);
      return orientation >= 5 && orientation <= 8 ? result('jpeg', height, width) : result('jpeg', width, height);
    }
    at += len;
  }
  return { ok: false, error: 'truncated' };
}

function exifOrientation(r: Reader, tiff: number, len: number): number | null {
  try {
    const order = r.ascii(tiff, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const le = order === 'II';
    if (r.u16(tiff + 2, le) !== 42) return null;
    const ifd = tiff + r.u32(tiff + 4, le);
    if (ifd < tiff || ifd >= tiff + len) return null;
    const count = Math.min(r.u16(ifd, le), 500);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (r.u16(entry, le) === 0x0112) return r.u16(entry + 8, le);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// PNG: IHDR must be the first chunk (bytes 8..32).
// ---------------------------------------------------------------------------------------------

function png(r: Reader): SniffResult {
  if (r.ascii(12, 4) !== 'IHDR') return { ok: false, error: 'truncated' };
  return result('png', r.u32(16), r.u32(20));
}

// ---------------------------------------------------------------------------------------------
// WebP: VP8 (lossy), VP8L (lossless), VP8X (extended).
// ---------------------------------------------------------------------------------------------

function webp(r: Reader): SniffResult {
  const chunk = r.ascii(12, 4);
  if (chunk === 'VP8 ') {
    // Frame tag (3 bytes) at 20, start code 9D 01 2A at 23, then 14-bit width/height.
    if (r.u8(23) !== 0x9d || r.u8(24) !== 0x01 || r.u8(25) !== 0x2a) return { ok: false, error: 'truncated' };
    return result('webp', r.u16(26, true) & 0x3fff, r.u16(28, true) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (r.u8(20) !== 0x2f) return { ok: false, error: 'truncated' };
    const b = r.u32(21, true);
    return result('webp', (b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') return result('webp', r.u24le(24) + 1, r.u24le(27) + 1);
  return { ok: false, error: 'unsupported_type' };
}

// ---------------------------------------------------------------------------------------------
// AVIF (ISO-BMFF): ftyp brand avif/avis, then meta → iprp → ipco → ispe (+ irot 90°/270° swaps).
// ---------------------------------------------------------------------------------------------

interface Box {
  type: string;
  start: number; // payload start
  end: number; // exclusive
}

function* boxes(r: Reader, from: number, to: number): Generator<Box> {
  let at = from;
  for (let guard = 0; at + 8 <= to && guard < 10_000; guard++) {
    let size = r.u32(at);
    const type = r.ascii(at + 4, 4);
    let header = 8;
    if (size === 1) {
      const hi = r.u32(at + 8);
      const lo = r.u32(at + 12);
      if (hi !== 0) throw new Truncated(); // > 4 GiB: impossible for an 8 MiB upload
      size = lo;
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) throw new Truncated();
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function child(r: Reader, parent: Box, type: string, fullBox = false): Box | undefined {
  for (const b of boxes(r, parent.start + (fullBox ? 4 : 0), parent.end)) if (b.type === type) return b;
  return undefined;
}

function avif(r: Reader): SniffResult {
  const all = [...boxes(r, 0, r.length)];
  const ftyp = all.find((b) => b.type === 'ftyp');
  if (ftyp === undefined) return { ok: false, error: 'unsupported_type' };
  const brands = [r.ascii(ftyp.start, 4)];
  for (let at = ftyp.start + 8; at + 4 <= ftyp.end; at += 4) brands.push(r.ascii(at, 4));
  if (!brands.includes('avif') && !brands.includes('avis')) return { ok: false, error: 'unsupported_type' };
  const meta = all.find((b) => b.type === 'meta');
  if (meta === undefined) return { ok: false, error: 'truncated' };
  const iprp = child(r, meta, 'iprp', true);
  const ipco = iprp === undefined ? undefined : child(r, iprp, 'ipco');
  if (ipco === undefined) return { ok: false, error: 'truncated' };
  let width = 0;
  let height = 0;
  let rotated = false;
  for (const b of boxes(r, ipco.start, ipco.end)) {
    if (b.type === 'ispe' && width === 0) {
      width = r.u32(b.start + 4);
      height = r.u32(b.start + 8);
    }
    if (b.type === 'irot') rotated = (r.u8(b.start) & 0x03) % 2 === 1;
  }
  if (width === 0) return { ok: false, error: 'truncated' };
  return rotated ? result('avif', height, width) : result('avif', width, height);
}
