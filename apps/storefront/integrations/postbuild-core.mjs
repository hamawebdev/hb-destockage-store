// Pure HTML/CSS passes used by the post-build integration (hb-postbuild.mjs). No I/O here so
// test/postbuild-core.test.ts can exercise every rule on strings. Owner: shell. Plan: artifacts/SHELL-0/plan.md §2.3.
import { createHash } from 'node:crypto';

const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Merge every <style> element into one, at the position of the first, keeping document order.
 * @param {string} html
 * @returns {{ html: string, css: string, count: number }}
 */
export function mergeStyles(html) {
  const parts = [];
  for (const m of html.matchAll(STYLE_RE)) parts.push(m[1] ?? '');
  if (parts.length === 0) return { html, css: '', count: 0 };
  const css = parts.join('');
  let first = true;
  const out = html.replace(STYLE_RE, () => {
    if (!first) return '';
    first = false;
    return '\u0000HB_STYLE\u0000';
  });
  return { html: out.replace('\u0000HB_STYLE\u0000', () => `<style>${css}</style>`), css, count: parts.length };
}

// `--name:value` up to the next `;` or `}` at the same level. Token values contain no braces.
const DECL_RE = /--([A-Za-z0-9_-]+)\s*:([^;{}]*)(;|(?=\}))/g;
const VAR_RE = /var\(\s*--([A-Za-z0-9_-]+)/g;

/**
 * Drop custom-property declarations that nothing on the page reads through var(), iterating
 * until no more can be dropped (tokens reference tokens). Empty rules left behind are removed.
 * @param {string} css minified CSS
 * @returns {string}
 */
export function pruneCustomProperties(css) {
  let cur = css;
  for (let i = 0; i < 20; i++) {
    // References = var(--x) in everything except the declarations of x itself.
    const used = new Set();
    for (const m of cur.matchAll(VAR_RE)) used.add(m[1]);
    let changed = false;
    const next = cur.replace(DECL_RE, (all, name) => {
      if (used.has(name)) return all;
      // Self-reference only (`--a:var(--a)`) is not a use; ignore that edge, tokens never do it.
      changed = true;
      return '';
    });
    cur = removeEmptyRules(next);
    if (!changed) break;
  }
  return cur;
}

/** Remove `sel{}` and `@media(...){}` left empty, repeatedly; tidy `;}` and `{;`. */
export function removeEmptyRules(css) {
  let cur = css.replace(/;+\}/g, '}').replace(/\{;+/g, '{').replace(/;{2,}/g, ';');
  for (let i = 0; i < 10; i++) {
    const next = cur.replace(/(^|[{}])\s*[^{}@;]+\{\s*\}/g, '$1').replace(/(^|[{}])\s*@(media|supports|container|layer)[^{};]*\{\s*\}/g, '$1');
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

// Physical properties that must be logical (CLAUDE.md: CSS logical properties only).
const PHYSICAL_RE =
  /(?:^|[;{\s])(?:(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)(?:-[a-z]+)?|left|right)\s*:|(?:text-align|float|clear)\s*:\s*(?:left|right)\b/;

/**
 * @param {string} css
 * @returns {string | null} the offending snippet, or null
 */
export function findPhysicalProperty(css) {
  const m = css.match(PHYSICAL_RE);
  if (!m || m.index === undefined) return null;
  return css.slice(Math.max(0, m.index - 30), m.index + 40);
}

/** @param {string} s */
export const sha256 = (s) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`;

/**
 * Structural rules every built page must satisfy. Returns a list of violations (empty = ok).
 * @param {string} html page after mergeStyles
 * @param {{ allowedInlineScripts: readonly string[], file: string }} opts
 * @returns {string[]}
 */
export function checkPage(html, opts) {
  const errors = [];
  const at = (msg) => errors.push(`${opts.file}: ${msg}`);

  const styles = [...html.matchAll(STYLE_RE)];
  if (styles.length !== 1) at(`expected exactly one <style>, found ${styles.length}`);
  for (const s of styles) {
    const bad = findPhysicalProperty(s[1] ?? '');
    if (bad) at(`physical CSS property (use logical properties): …${bad}…`);
  }

  // Inline style attributes and event-handler attributes break the hash-based CSP.
  for (const m of html.matchAll(/<[a-zA-Z][^>]*?\s(style|on[a-z]+)\s*=/g)) {
    at(`forbidden attribute ${m[1]}= in ${m[0].slice(0, 60)}…`);
  }

  if (/<link\b[^>]*\brel=["']?stylesheet/i.test(html)) at('external stylesheet <link rel=stylesheet>');

  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (/\bsrc\s*=/.test(attrs)) {
      at(`external <script src> in the document (inject after load instead): ${attrs.trim()}`);
      continue;
    }
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/.exec(attrs)?.[1]?.toLowerCase() ?? '';
    if (type === 'application/ld+json') {
      if (/<\/?script/i.test(body)) at('ld+json contains a <script sequence (escape < as \\u003c)');
      continue;
    }
    if (type === 'speculationrules' || type === '' || type === 'module' || type === 'text/javascript') {
      if (!opts.allowedInlineScripts.includes(body)) {
        at(`inline script not in the allow-list (type=${type || 'classic'}, ${body.length} chars): ${body.slice(0, 60)}…`);
      }
      continue;
    }
    at(`unexpected script type ${type}`);
  }

  // Nothing cross-origin may be fetched by the document head (no third-party origin before LCP).
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  for (const m of head.matchAll(/<(link|img|source|iframe)\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\brel=["']?(?:canonical|alternate)\b/i.test(tag)) continue;
    const url = /\b(?:href|src|imagesrcset)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? '';
    if (/^(?:https?:)?\/\//i.test(url)) at(`cross-origin resource in <head>: ${tag.slice(0, 100)}`);
  }

  if (!/<html\b[^>]*\blang=["']?(ar|fr)\b/i.test(html)) at('<html> lacks lang="ar|fr"');
  else {
    const lang = /<html\b[^>]*\blang=["']?(ar|fr)/i.exec(html)?.[1];
    const dir = /<html\b[^>]*\bdir=["']?(rtl|ltr)/i.exec(html)?.[1];
    if (dir !== (lang === 'ar' ? 'rtl' : 'ltr')) at(`<html lang="${lang}"> needs dir="${lang === 'ar' ? 'rtl' : 'ltr'}", got ${dir}`);
  }
  return errors;
}
