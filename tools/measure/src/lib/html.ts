/**
 * Minimal, dependency-free HTML tokenizer for static-site auditing.
 *
 * Not a full HTML5 parser. It yields start tags (with attributes) in document order, skips
 * comments / doctype / processing instructions, and captures the raw text of `<script>`,
 * `<style>`, `<textarea>` and `<title>` (raw-text elements whose content is not markup).
 * That is everything the budget rules need: which elements exist, their attributes, their order,
 * and the text of inline scripts and styles.
 *
 * Tags inside `<template>` or `<noscript>` are marked `inert`: a JS-capable browser neither
 * fetches nor runs them. A `<template shadowrootmode>` (declarative shadow DOM) is NOT inert: its
 * content renders and fetches. Rules about what such a browser loads skip inert tags; the third-party
 * rule still scans `<noscript>` content (a no-JS browser loads it).
 */

export interface Tag {
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
  index: number;
  /** raw text content for script/style/textarea/title */
  text?: string;
  inert: boolean;
  /** innermost inert container, if any */
  inertIn?: 'template' | 'noscript';
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const INERT = new Set(['template', 'noscript']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the character references that matter in attribute values (URLs, srcsets). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (m, ref: string) => {
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const cp = hex ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[ref.toLowerCase()] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name || name in attrs) continue; // HTML: the first occurrence wins
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Tokenize an HTML document into start tags in document order. */
export function parseTags(html: string): Tag[] {
  const tags: Tag[] = [];
  // open template/noscript elements; 'shadow' = <template shadowrootmode>, which renders (not inert)
  const stack: Array<'template' | 'noscript' | 'shadow'> = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      // HTML comment end: '-->' or '--!>' (a parse error browsers accept); '<!-->' and '<!--->'
      // are empty comments that close immediately
      if (html.startsWith('<!-->', lt)) { i = lt + 5; continue; }
      if (html.startsWith('<!--->', lt)) { i = lt + 6; continue; }
      const m = /--!?>/.exec(html.slice(lt + 4));
      i = m ? lt + 4 + m.index + m[0].length : n;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') {
      const e = html.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (next === '/') {
      const m = /^<\/([a-zA-Z][^\s>/]*)[^>]*>?/.exec(html.slice(lt, lt + 200));
      if (m) {
        const name = (m[1] ?? '').toLowerCase();
        if (name === 'template' || name === 'noscript') {
          // a declarative-shadow-DOM <template> was pushed as 'shadow'
          let k = -1;
          for (let q = stack.length - 1; q >= 0; q--) {
            const e = stack[q];
            if (e === name || (name === 'template' && e === 'shadow')) { k = q; break; }
          }
          if (k >= 0) stack.splice(k, 1);
        }
        i = lt + m[0].length;
      } else i = lt + 2;
      continue;
    }
    const nm = /^<([a-zA-Z][^\s>/]*)/.exec(html.slice(lt, lt + 100));
    if (!nm) { i = lt + 1; continue; }
    const name = (nm[1] ?? '').toLowerCase();
    // end of the start tag; a quote only opens inside an attribute value (right after '=')
    let j = lt + nm[0].length;
    let quote = '';
    for (; j < n; j++) {
      const c = html[j];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") {
        let k = j - 1;
        while (k > lt && /\s/.test(html[k] ?? '')) k--;
        if (html[k] === '=') quote = c;
        continue;
      }
      if (c === '>') break;
    }
    const attrSrc = html.slice(lt + nm[0].length, j).replace(/\/\s*$/, '');
    const inertOnly = stack.filter((e): e is 'template' | 'noscript' => e !== 'shadow');
    const inertIn = inertOnly[inertOnly.length - 1];
    const attrs = parseAttrs(attrSrc);
    const tag: Tag = {
      name, attrs, start: lt, end: Math.min(j + 1, n), index: tags.length,
      inert: inertOnly.length > 0, ...(inertIn ? { inertIn } : {}),
    };
    i = tag.end;
    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}[\\s>/]`, 'ig');
      close.lastIndex = i;
      const cm = close.exec(html);
      const stop = cm ? cm.index : n;
      tag.text = html.slice(i, stop);
      const gt = cm ? html.indexOf('>', stop) : -1;
      i = gt < 0 ? n : gt + 1;
    }
    if (INERT.has(name)) {
      const shadow = name === 'template' && ('shadowrootmode' in attrs || 'shadowroot' in attrs);
      stack.push(shadow ? 'shadow' : (name as 'template' | 'noscript'));
    }
    tags.push(tag);
  }
  return tags;
}

export function has(t: Tag, a: string): boolean {
  return Object.prototype.hasOwnProperty.call(t.attrs, a);
}

export function attr(t: Tag, a: string): string {
  return t.attrs[a] ?? '';
}

/** Space-separated, lower-cased token list of an attribute (e.g. `rel`). */
export function tokens(t: Tag, a: string): string[] {
  return attr(t, a).toLowerCase().split(/\s+/).filter(Boolean);
}
