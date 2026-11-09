// Post-build pass over dist/ (runs in astro:build:done, before apps/web generates the CSP).
// 1. One <style> per page (merge), 2. prune unused custom properties, 3. move <lang>/404/index.html
// to <lang>/404.html for Workers static assets `not_found_handling: "404-page"`, 4. fail the
// build on any structural violation (postbuild-core.checkPage), 5. print per-page brotli sizes
// and the hashes of the constant inline scripts, 6. copy brand assets (favicons, og images) into
// dist, 7. minify dist/js/**/*.js in place (oxc via Vite; public/js stays readable source,
// ?v=<hash> URLs are computed from the source so cache-busting is unaffected). One sheet for both languages (lead decision on SHELL-1 r1 F2): /fr/ pages carry the
// Arabic @font-face text but must never preload the font.
// Owner: shell. Plan: artifacts/SHELL-0/plan.md §2.3.
import { readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { minify } from 'vite';
import { checkCatalogAssets, checkPage, classesIn, knownClasses, mergeStyles, pruneCustomProperties, sha256, trimUnusedRules } from './postbuild-core.mjs';

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const br = (s) => brotliCompressSync(Buffer.from(s), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

/**
 * @param {{ allowedInlineScripts: readonly string[], routes?: () => readonly { path: string, template: string }[] | Promise<readonly { path: string, template: string }[]>, extraGroups?: readonly { pattern: RegExp, template: string }[], copy?: readonly { from: string, to: string }[], siteOrigin?: string }} opts
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

        // Meta off (D-009): nothing Meta-related ships. Before the JS scan and the token pruning below,
        // so an unconfigured build carries no trace of it.
        if (!opts.metaEnabled) {
          await rm(join(root, 'js', 'meta.js'), { force: true });
          await rm(join(root, 'js', 'meta-full.js'), { force: true });
          for (const lang of ['ar', 'fr']) await rm(join(root, lang, 'meta'), { recursive: true, force: true });
        }

        // 6. Brand assets.
        for (const { from, to } of opts.copy ?? []) {
          try {
            await mkdir(dirname(join(root, to)), { recursive: true });
            await copyFile(from, join(root, to));
          } catch (e) {
            errors.push(`copy ${from} -> ${to}: ${/** @type {Error} */ (e).message}`);
          }
        }
        // 7. Post-LCP modules: ship minified (Algerian baseline: ES2022 = Chrome 111 / Safari 16.4).
        const jsRows = [];
        try {
          for await (const f of walk(join(root, 'js'))) {
            if (!f.endsWith('.js')) continue;
            const code = await readFile(f, 'utf8');
            const r = await minify(f, code, { compress: { target: 'es2022' }, mangle: true, module: true });
            if (r.errors.length) {
              errors.push(`minify ${relative(root, f)}: ${r.errors.map((e) => e.message).join('; ')}`);
              continue;
            }
            await writeFile(f, r.code);
            jsRows.push({ file: relative(root, f).split(sep).join('/'), srcBr: br(code), minBr: br(r.code) });
          }
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
        }

        if (opts.siteOrigin) {
          const read = (/** @type {string} */ rel) => {
            try {
              return readFileSync(join(root, rel), 'utf8');
            } catch {
              return null;
            }
          };
          const list = (/** @type {string} */ dir) => {
            try {
              return readdirSync(join(root, dir));
            } catch {
              return [];
            }
          };
          errors.push(...checkCatalogAssets(read, list, opts.siteOrigin));
        }

        const rows = [];
        const files = [];
        for await (const f of walk(root)) if (f.endsWith('.html')) files.push(f);
        files.sort();

        // 8. Unused-rule trim (lead-approved, guarded; HB_CSS_TRIM=0 disables it for the pixel-diff
        //    proof). Pass 1: the class universe of each template (<html data-tpl>, both languages) and
        //    the client JS text; pass 2: trim each page with its template's universe, so every page of
        //    a template still gets byte-identical CSS (one CSP hash per template).
        const trim = process.env['HB_CSS_TRIM'] !== '0';
        const pages = [];
        for (const file of files) {
          const src = await readFile(file, 'utf8');
          const tpl = /<html\b[^>]*\bdata-tpl="([\w-]+)"/.exec(src)?.[1] ?? `file:${relative(root, file)}`;
          pages.push({ file, src, tpl, merged: mergeStyles(src) });
        }
        let jsText = '';
        try {
          // The Meta files style only their own bar and carry literal values (D-009): scanning them would change every
          // page's CSS, and so its hash and bytes, when Meta is configured.
          for await (const f of walk(join(root, 'js'))) if (f.endsWith('.js') && !f.endsWith(`${sep}meta.js`) && !f.endsWith(`${sep}meta-full.js`)) jsText += await readFile(f, 'utf8');
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
        }
        /** @type {Map<string, Set<string>>} */
        const universe = new Map();
        for (const pg of pages) {
          const set = universe.get(pg.tpl) ?? new Set();
          for (const c of classesIn(pg.merged.html)) set.add(c);
          universe.set(pg.tpl, set);
        }

        for (const { file, src, tpl, merged } of pages) {
          const rel = relative(root, file).split(sep).join('/');
          let html = merged.html;
          const lang = /<html\b[^>]*\blang=["']?(ar|fr)/i.exec(src)?.[1] ?? '';
          if (merged.count > 0) {
            const known = knownClasses(universe.get(tpl) ?? new Set(), jsText);
            const pruned = pruneCustomProperties(trim ? trimUnusedRules(merged.css, known) : merged.css, jsText);
            html = html.replace(/<style>[\s\S]*?<\/style>/, () => `<style>${pruned}</style>`);
          }
          errors.push(...checkPage(html, { allowedInlineScripts: opts.allowedInlineScripts, file: rel }));
          // French = system stack: the Arabic font may be declared in the shared sheet but never preloaded.
          if (lang === 'fr' && /<link\b[^>]*\bas=["']?font\b/i.test(html)) errors.push(`${rel}: a French page preloads a font (French = system stack, 0 bytes)`);
          if (html !== src) await writeFile(file, html);
          const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
          rows.push({ page: rel, lang, tpl, htmlBr: br(html), cssBr: br(css), styles: merged.count, styleHash: sha256(css) });
        }
        logger.info(`unused-rule trim: ${trim ? 'on' : 'OFF (HB_CSS_TRIM=0)'}`);

        // Every route-map entry produced a file; one inline-CSS hash per template.
        /** @type {Map<string, Map<string, string[]>>} template -> styleHash -> pages */
        const byTemplate = new Map();
        if (opts.routes) {
          const rowByPage = new Map(rows.map((r) => ['/' + r.page, r]));
          for (const { path, template } of await opts.routes()) {
            const want = path.endsWith('.html') ? path : `${path}index.html`;
            const row = rowByPage.get(want);
            if (!row) {
              errors.push(`route map path ${path} was not built (expected ${want})`);
              continue;
            }
            row.template = template;
            const key = template;
            const hashes = byTemplate.get(key) ?? new Map();
            hashes.set(row.styleHash, [...(hashes.get(row.styleHash) ?? []), want]);
            byTemplate.set(key, hashes);
          }
          for (const g of opts.extraGroups ?? []) {
            for (const row of rows) {
              if (!g.pattern.test('/' + row.page)) continue;
              row.template = g.template;
              const key = g.template;
              const hashes = byTemplate.get(key) ?? new Map();
              hashes.set(row.styleHash, [...(hashes.get(row.styleHash) ?? []), '/' + row.page]);
              byTemplate.set(key, hashes);
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
        for (const j of jsRows) logger.info(`${j.file.padEnd(48)} js ${kib(j.srcBr)} → ${kib(j.minBr)} KiB br (minified)`);
        for (const [template, hashes] of byTemplate) logger.info(`template ${template}: ${hashes.size} distinct inline <style> hash(es)`);
        const distinct = new Set(rows.map((r) => r.styleHash)).size;
        logger.info(`distinct inline <style> sheets across the site: ${distinct}`);
        for (const s of opts.allowedInlineScripts) logger.info(`inline script hash for CSP: '${sha256(s)}'`);

        // Machine-readable report outside dist/ (dist is deployed as-is).
        const reportDir = join(root, '..', '.hb');
        await mkdir(reportDir, { recursive: true });
        await writeFile(join(reportDir, 'postbuild-report.json'), JSON.stringify({ pages: rows, js: jsRows, styleHashesPerTemplate: Object.fromEntries([...byTemplate].map(([t, h]) => [t, [...h.keys()]])), scriptHashes: opts.allowedInlineScripts.map(sha256) }, null, 2));

        if (errors.length) {
          for (const e of errors) logger.error(e);
          throw new Error(`hb-postbuild: ${errors.length} violation(s); see above`);
        }
      },
    },
  };
}
