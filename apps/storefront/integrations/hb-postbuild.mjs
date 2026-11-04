// Post-build pass over dist/ (runs in astro:build:done, before apps/web generates the CSP).
// 1. One <style> per page (merge), 2. prune unused custom properties, 3. move <lang>/404/index.html
// to <lang>/404.html for Workers static assets `not_found_handling: "404-page"`, 4. fail the
// build on any structural violation (postbuild-core.checkPage), 5. print per-page brotli sizes
// and the hashes of the constant inline scripts. Owner: shell. Plan: artifacts/SHELL-0/plan.md §2.3.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { checkPage, mergeStyles, pruneCustomProperties, sha256 } from './postbuild-core.mjs';

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const br = (s) => brotliCompressSync(Buffer.from(s), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

/**
 * @param {{ allowedInlineScripts: readonly string[], routes?: () => readonly { path: string, template: string }[], extraGroups?: readonly { pattern: RegExp, template: string }[] }} opts
 *   allowedInlineScripts: exact bodies of the constant inline scripts (src/lib/inline-scripts.mjs).
 *   routes: every route-map entry; each must have produced a file, and all pages of one template
 *   must carry byte-identical inline CSS (apps/web's CSP groups style hashes per template route
 *   pattern: _headers allows 100 rules x 2,000 chars, so CSS may depend on the template's
 *   component set only, never on page data).
 * @returns {import('astro').AstroIntegration}
 */
export default function hbPostbuild(opts) {
  return {
    name: 'hb-postbuild',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const root = fileURLToPath(dir);

        // 3. Per-language 404 pages: <lang>/404/index.html → <lang>/404.html
        for (const lang of ['ar', 'fr']) {
          const from = join(root, lang, '404', 'index.html');
          try {
            await rename(from, join(root, lang, '404.html'));
            await rm(dirname(from), { recursive: true, force: true });
          } catch (e) {
            if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
          }
        }

        const errors = [];
        const rows = [];
        const files = [];
        for await (const f of walk(root)) if (f.endsWith('.html')) files.push(f);
        files.sort();

        for (const file of files) {
          const rel = relative(root, file).split(sep).join('/');
          const src = await readFile(file, 'utf8');
          const merged = mergeStyles(src);
          let html = merged.html;
          if (merged.count > 0) {
            const pruned = pruneCustomProperties(merged.css);
            html = html.replace(/<style>[\s\S]*?<\/style>/, () => `<style>${pruned}</style>`);
          }
          errors.push(...checkPage(html, { allowedInlineScripts: opts.allowedInlineScripts, file: rel }));
          if (html !== src) await writeFile(file, html);
          const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
          rows.push({ page: rel, htmlBr: br(html), cssBr: br(css), styles: merged.count, styleHash: sha256(css) });
        }

        // Every route-map entry produced a file; one inline-CSS hash per template.
        /** @type {Map<string, Map<string, string[]>>} template -> styleHash -> pages */
        const byTemplate = new Map();
        if (opts.routes) {
          const rowByPage = new Map(rows.map((r) => ['/' + r.page, r]));
          for (const { path, template } of opts.routes()) {
            const want = path.endsWith('.html') ? path : `${path}index.html`;
            const row = rowByPage.get(want);
            if (!row) {
              errors.push(`route map path ${path} was not built (expected ${want})`);
              continue;
            }
            row.template = template;
            const hashes = byTemplate.get(template) ?? new Map();
            hashes.set(row.styleHash, [...(hashes.get(row.styleHash) ?? []), want]);
            byTemplate.set(template, hashes);
          }
          for (const g of opts.extraGroups ?? []) {
            for (const row of rows) {
              if (!g.pattern.test('/' + row.page)) continue;
              row.template = g.template;
              const hashes = byTemplate.get(g.template) ?? new Map();
              hashes.set(row.styleHash, [...(hashes.get(row.styleHash) ?? []), '/' + row.page]);
              byTemplate.set(g.template, hashes);
            }
          }
          for (const [template, hashes] of byTemplate) {
            if (hashes.size > 1) {
              const detail = [...hashes].map(([h, pages]) => `${h} (${pages.length}: ${pages.slice(0, 3).join(', ')})`).join('; ');
              errors.push(`template ${template} has ${hashes.size} distinct inline <style> sheets, expected 1 (CSS must not depend on page data): ${detail}`);
            }
          }
        }

        const kib = (n) => (n / 1024).toFixed(2);
        logger.info(`pages: ${rows.length}`);
        for (const r of rows) {
          logger.info(`${r.page.padEnd(48)} html+css ${kib(r.htmlBr)} KiB br (css ${kib(r.cssBr)} KiB, ${r.styles} <style> merged)`);
        }
        for (const [template, hashes] of byTemplate) logger.info(`template ${template}: ${hashes.size} distinct inline <style> hash(es)`);
        const distinct = new Set(rows.map((r) => r.styleHash)).size;
        logger.info(`distinct inline <style> sheets across the site: ${distinct}`);
        for (const s of opts.allowedInlineScripts) logger.info(`inline script hash for CSP: '${sha256(s)}'`);

        // Machine-readable report outside dist/ (dist is deployed as-is).
        const reportDir = join(root, '..', '.hb');
        await mkdir(reportDir, { recursive: true });
        await writeFile(join(reportDir, 'postbuild-report.json'), JSON.stringify({ pages: rows, styleHashesPerTemplate: Object.fromEntries([...byTemplate].map(([t, h]) => [t, [...h.keys()]])), scriptHashes: opts.allowedInlineScripts.map(sha256) }, null, 2));

        if (errors.length) {
          for (const e of errors) logger.error(e);
          throw new Error(`hb-postbuild: ${errors.length} violation(s); see above`);
        }
      },
    },
  };
}
