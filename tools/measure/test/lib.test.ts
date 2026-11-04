import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTags } from '../src/lib/html.ts';
import { avifSize, cssUrls, evalSizes, fontFaces, isAvif, parseSrcset, pickCandidate } from '../src/lib/assets.ts';
import { absUrlsIn, jsRefs } from '../src/budget/check.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('parseTags', () => {
  it('keeps script text raw and does not tokenize markup inside it', () => {
    const t = parseTags('<head><script>if(a<b){x="<img src=https://x.example/a>"}</script><img src="/a.avif"></head>');
    expect(t.map((x) => x.name)).toEqual(['head', 'script', 'img']);
    expect(t[1]?.text).toContain('<img src=https://x.example/a>');
  });
  it('handles > inside quoted attributes, unquoted values, entities and case', () => {
    const t = parseTags('<IMG ALT="a > b" SRC=/x.avif data-x=\'1\' srcset="/a.avif?x=1&amp;y=2 360w">');
    expect(t[0]?.attrs).toEqual({ alt: 'a > b', src: '/x.avif', 'data-x': '1', srcset: '/a.avif?x=1&y=2 360w' });
  });
  it('skips comments and marks template/noscript content inert', () => {
    const t = parseTags('<!-- <script src="/c.js"></script> --><template><img src="/t.avif"></template><noscript><img src="/n.avif"></noscript><p>');
    expect(t.map((x) => `${x.name}:${x.inert}:${x.inertIn ?? ''}`)).toEqual(['template:false:', 'img:true:template', 'noscript:false:', 'img:true:noscript', 'p:false:']);
  });
  it('first duplicate attribute wins', () => {
    expect(parseTags('<img src="/a" src="/b">')[0]?.attrs['src']).toBe('/a');
  });
});

describe('srcset / sizes', () => {
  it('parses w and x descriptors', () => {
    expect(parseSrcset('/a-360.avif 360w, /a-480.avif 480w,/b.avif 2x, /c.avif')).toEqual([
      { url: '/a-360.avif', w: 360 }, { url: '/a-480.avif', w: 480 }, { url: '/b.avif', x: 2 }, { url: '/c.avif' },
    ]);
  });
  it('evaluates sizes at a viewport', () => {
    expect(evalSizes('(min-width: 768px) 50vw, 100vw', 412)).toBe(412);
    expect(evalSizes('(min-width: 768px) 50vw, 100vw', 1000)).toBe(500);
    expect(evalSizes('(max-width: 40em) calc(100vw - 32px), 600px', 412)).toBe(380);
    expect(evalSizes('min(100vw, 600px)', 1440)).toBe(600);
    expect(evalSizes(undefined, 412)).toBe(412);
    expect(evalSizes('auto', 412)).toBeNull();
    expect(evalSizes('(orientation: portrait) 50vw, 100vw', 412)).toBeNull();
  });
  it('picks the candidate Lighthouse mobile would download (412 px × 1.75)', () => {
    const c = parseSrcset('/a-360.avif 360w, /a-480.avif 480w, /a-720.avif 720w, /a-960.avif 960w, /a-1200.avif 1200w');
    expect(pickCandidate(c, 412, 1.75)?.url).toBe('/a-960.avif');
    expect(pickCandidate(c, 206, 1.75)?.url).toBe('/a-480.avif');
    expect(pickCandidate(c, null, 1.75)?.url).toBe('/a-1200.avif');
  });
});

describe('AVIF', () => {
  it('reads dimensions from a real AVIF (ffmpeg/libaom)', () => {
    const buf = readFileSync(path.join(here, 'fixtures/real-480x320.avif'));
    expect(isAvif(buf)).toBe(true);
    expect(avifSize(buf)).toEqual({ width: 480, height: 320 });
  });
  it('rejects non-AVIF ISO-BMFF and garbage', () => {
    const mp4 = Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2', 'latin1');
    expect(isAvif(mp4)).toBe(false);
    expect(avifSize(Buffer.from('not an image at all'))).toBeNull();
  });
});

describe('CSS', () => {
  it('extracts url() and @import', () => {
    expect(cssUrls('a{background:url( "/a.png" )}b{background:url(/b.svg)}@import "/c.css";')).toEqual(['/a.png', '/b.svg', '/c.css']);
  });
  it('reads @font-face', () => {
    expect(fontFaces('@font-face{font-family:"Noto Sans Arabic";src:url(/f.woff2) format("woff2"),url(data:x);font-display:optional;unicode-range:U+0600-06FF}')).toEqual([
      { family: 'Noto Sans Arabic', urls: ['/f.woff2'], display: 'optional', unicodeRange: 'U+0600-06FF' },
    ]);
  });
});

describe('JS references', () => {
  it('finds imports, dynamic imports and injected script URLs', () => {
    const js = `import a from './a.js'; export * from "../b.mjs"; import('/c.js'); s.src='/js/d.js?v=1'; const u = "not-a-path.js"; // https://example.com/e.js`;
    expect(jsRefs(js).sort()).toEqual(['../b.mjs', './a.js', '/c.js', '/js/d.js?v=1'].sort());
  });
  it('finds absolute and protocol-relative URLs but not // comments', () => {
    expect(absUrlsIn('// a comment\nfetch("https://x.example/a"); s.src="//cdn.example.com/y.js"')).toEqual([
      'https://x.example/a', 'https://cdn.example.com/y.js',
    ]);
  });
});
