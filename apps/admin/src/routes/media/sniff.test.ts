import { describe, expect, it, vi } from 'vitest';

// Loading sharp and encoding AVIF takes seconds on the shared machine.
vi.setConfig({ testTimeout: 60_000 });
import { checkStructure, sniffImage } from './sniff.ts';

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((ch) => ch.charCodeAt(0)) : p)));
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const box = (type: string, payload: number[]) => [...u32be(8 + payload.length), ...[...type].map((c) => c.charCodeAt(0)), ...payload];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

function jpegWith(w: number, h: number, opts: { sof?: number; orientation?: number } = {}): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  parts.push(0xff, 0xe0, ...u16be(16), ...str('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0); // APP0
  if (opts.orientation) {
    // APP1 Exif, big-endian TIFF, IFD0 with one entry 0x0112 = orientation
    const tiff = [...str('MM'), ...u16be(42), ...u32be(8), ...u16be(1), ...u16be(0x0112), ...u16be(3), ...u32be(1), ...u16be(opts.orientation), 0, 0, ...u32be(0)];
    const payload = [...str('Exif\0\0'), ...tiff];
    parts.push(0xff, 0xe1, ...u16be(payload.length + 2), ...payload);
  }
  parts.push(0xff, 0xff, opts.sof ?? 0xc0, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xff, 0xd9);
  return Uint8Array.from(parts);
}

const pngWith = (w: number, h: number) => bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(w), u32be(h), [8, 6, 0, 0, 0]);

function avifWith(w: number, h: number, opts: { brand?: string; irot?: number } = {}): Uint8Array {
  const ftyp = box('ftyp', [...str(opts.brand ?? 'avif'), ...u32be(0), ...str('mif1'), ...str(opts.brand ?? 'avif')]);
  const ispe = box('ispe', [0, 0, 0, 0, ...u32be(w), ...u32be(h)]);
  const ipcoPayload = [...ispe, ...(opts.irot !== undefined ? box('irot', [opts.irot]) : [])];
  const meta = box('meta', [0, 0, 0, 0, ...box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0, ...str('pict')]), ...box('iprp', box('ipco', ipcoPayload))]);
  return Uint8Array.from([...ftyp, ...meta]);
}

describe('sniffImage: accepted formats', () => {
  it('JPEG baseline and progressive', () => {
    expect(sniffImage(jpegWith(1200, 800))).toEqual({ ok: true, type: 'jpeg', width: 1200, height: 800 });
    expect(sniffImage(jpegWith(640, 480, { sof: 0xc2 }))).toEqual({ ok: true, type: 'jpeg', width: 640, height: 480 });
  });
  it('JPEG EXIF orientation 6 swaps the sides; 3 does not', () => {
    expect(sniffImage(jpegWith(1200, 800, { orientation: 6 }))).toMatchObject({ width: 800, height: 1200 });
    expect(sniffImage(jpegWith(1200, 800, { orientation: 3 }))).toMatchObject({ width: 1200, height: 800 });
  });
  it('PNG', () => {
    expect(sniffImage(pngWith(37, 21))).toEqual({ ok: true, type: 'png', width: 37, height: 21 });
  });
  it('WebP VP8, VP8L, VP8X', () => {
    const vp8 = bytes('RIFF', u32le(30), 'WEBP', 'VP8 ', u32le(18), [0, 0, 0], [0x9d, 0x01, 0x2a], u16le(1200), u16le(800));
    expect(sniffImage(vp8)).toEqual({ ok: true, type: 'webp', width: 1200, height: 800 });
    const packed = (300 - 1) | ((200 - 1) << 14);
    const vp8l = bytes('RIFF', u32le(30), 'WEBP', 'VP8L', u32le(5), [0x2f], u32le(packed));
    expect(sniffImage(vp8l)).toEqual({ ok: true, type: 'webp', width: 300, height: 200 });
    const vp8x = bytes('RIFF', u32le(30), 'WEBP', 'VP8X', u32le(10), [0, 0, 0, 0], [0xff, 0x03, 0x00], [0x1f, 0x03, 0x00]);
    expect(sniffImage(vp8x)).toEqual({ ok: true, type: 'webp', width: 1024, height: 800 });
  });
  it('AVIF (avif and avis brands), irot 90° swaps', () => {
    expect(sniffImage(avifWith(1200, 900))).toEqual({ ok: true, type: 'avif', width: 1200, height: 900 });
    expect(sniffImage(avifWith(10, 20, { brand: 'avis' }))).toMatchObject({ ok: true, width: 10 });
    expect(sniffImage(avifWith(1200, 900, { irot: 1 }))).toMatchObject({ width: 900, height: 1200 });
  });
});

describe('sniffImage: refused', () => {
  it.each([
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['HTML', bytes('<!doctype html><script>alert(1)</script>')],
    ['GIF', bytes('GIF89a', [1, 0, 1, 0])],
    ['PDF', bytes('%PDF-1.7')],
    ['BMP', bytes('BM', [0, 0, 0, 0])],
    ['empty', new Uint8Array()],
    ['SVG wrapping a PNG signature', bytes('<svg>', [0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])],
    ['HEIC', Uint8Array.from([...box('ftyp', [...str('heic'), ...u32be(0), ...str('mif1'), ...str('heic')])])],
  ])('%s → unsupported_type', (_name, b) => {
    expect(sniffImage(b)).toEqual({ ok: false, error: 'unsupported_type' });
  });

  it('truncated files', () => {
    expect(sniffImage(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ ok: false, error: 'truncated' });
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toEqual({ ok: false, error: 'truncated' });
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9]))).toEqual({ ok: false, error: 'truncated' });
    expect(sniffImage(avifWith(10, 10).slice(0, 40))).toMatchObject({ ok: false });
  });

  it('zero or absurd dimensions', () => {
    expect(sniffImage(pngWith(0, 10))).toEqual({ ok: false, error: 'bad_dimensions' });
    expect(sniffImage(pngWith(30_000, 10))).toEqual({ ok: false, error: 'bad_dimensions' });
  });

  it('hostile box sizes never throw or hang', () => {
    const huge = Uint8Array.from([...box('ftyp', [...str('avif'), 0, 0, 0, 0]), 0xff, 0xff, 0xff, 0xff, ...str('meta')]);
    expect(sniffImage(huge)).toMatchObject({ ok: false });
    const large = Uint8Array.from([...box('ftyp', [...str('avif'), 0, 0, 0, 0]), 0, 0, 0, 1, ...str('meta'), 0xff, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(large)).toMatchObject({ ok: false });
    const zero = Uint8Array.from([...box('ftyp', [...str('avif'), 0, 0, 0, 0]), 0, 0, 0, 0, ...str('meta')]);
    expect(sniffImage(zero)).toMatchObject({ ok: false });
    const loops = Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 5000 }, () => [0xff, 0xff]).flat()]);
    expect(sniffImage(loops)).toMatchObject({ ok: false });
  });
});

describe('sniffImage: real encoder output (sharp, when installed)', () => {
  it('matches the dimensions sharp wrote', async () => {
    // sharp may not be resolvable from this workspace: then the hand-built fixtures above cover it.
    const mod = await import('sharp').catch(() => null);
    if (mod === null) return;
    const sharp = mod.default;
    for (const format of ['jpeg', 'png', 'webp', 'avif'] as const) {
      const buf = new Uint8Array(await sharp({ create: { width: 37, height: 21, channels: 3, background: '#c00000' } }).toFormat(format).toBuffer());
      expect(sniffImage(buf), format).toEqual({ ok: true, type: format, width: 37, height: 21 });
      expect(checkStructure(buf, format), `${format} structure`).toBe(true);
      // Same header, body cut in half: refused.
      expect(checkStructure(buf.slice(0, Math.floor(buf.length / 2)), format), `${format} half`).toBe(false);
    }
  });
});

describe('checkStructure (header-valid files with a junk body)', () => {
  const chunk = (type: string, data: number[]) => [...u32be(data.length), ...str(type), ...data, 0, 0, 0, 0];
  const fullPng = () => Uint8Array.from([0x89, ...str('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32be(10), ...u32be(10), 8, 6, 0, 0, 0]), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);
  it('PNG: needs IDAT and IEND inside the file', () => {
    expect(checkStructure(fullPng(), 'png')).toBe(true);
    expect(checkStructure(pngWith(10, 10), 'png')).toBe(false);
    const junk = Uint8Array.from([...pngWith(10, 10), ...str('<script>alert(1)</script>')]);
    expect(checkStructure(junk, 'png')).toBe(false);
    expect(checkStructure(fullPng().slice(0, -6), 'png')).toBe(false);
  });
  it('JPEG: needs a scan then end-of-image', () => {
    expect(checkStructure(jpegWith(10, 10), 'jpeg')).toBe(false); // SOF but no SOS
    const ok = Uint8Array.from([...jpegWith(10, 10).slice(0, -2), 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
    expect(checkStructure(ok, 'jpeg')).toBe(true);
    expect(checkStructure(ok.slice(0, -2), 'jpeg')).toBe(false);
  });
  it('WebP: RIFF size must match the file', () => {
    const body = bytes('WEBP', 'VP8 ', u32le(10), [0, 0, 0, 0x9d, 0x01, 0x2a, 10, 0, 10, 0]);
    const ok = Uint8Array.from([...bytes('RIFF', u32le(body.length)), ...body]);
    expect(checkStructure(ok, 'webp')).toBe(true);
    expect(checkStructure(Uint8Array.from([...ok, 1, 2, 3]), 'webp')).toBe(false);
  });
  it('AVIF: boxes must cover the file and include mdat', () => {
    const base = avifWith(10, 10);
    expect(checkStructure(base, 'avif')).toBe(false); // no mdat
    const ok = Uint8Array.from([...base, ...box('mdat', [1, 2, 3, 4])]);
    expect(checkStructure(ok, 'avif')).toBe(true);
    expect(checkStructure(Uint8Array.from([...ok, 9]), 'avif')).toBe(false);
  });
});
