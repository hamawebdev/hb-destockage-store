/**
 * MEAS-1 r2 runtime pass: a real Chrome load (system Chrome via Playwright) over a local server.
 * Lead ruling F2: the shared sheet may declare the Arabic @font-face on /fr/; the page must not
 * download it. And no third-party request may happen without user interaction.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { runtimeChecks } from '../src/budget/runtime.ts';
import { FONT, ORDER_JS, cleanup, edit, freshSite, put } from './fixtures/site.ts';

afterAll(cleanup);
const FR_H = 'fr/index.html';
const AR_FACE = `@font-face{font-family:"Noto Sans Arabic";src:url(${FONT}) format("woff2");font-display:optional;unicode-range:U+0600-06FF}`;
const pagesOf = (urls: string[]) => urls.map((url) => ({ url, lang: url.slice(1, 3) }));
const rules = (m: Map<string, Array<{ rule: string; message: string }>>): string[] => [...m.values()].flat().map((v) => `${v.rule}: ${v.message}`);
const T = { timeout: 240_000 };

describe('runtime pass (Chrome)', () => {
  it('good site: no font on /fr/, the font on /ar/, no third party without interaction', T, async () => {
    const d = freshSite();
    // the shared sheet declares the Arabic face on /fr/ too, unused: must pass
    edit(d, FR_H, (s) => s.replace('<style>', `<style>${AR_FACE}`));
    const r = await runtimeChecks(d, pagesOf(['/ar/', '/fr/', '/ar/p/pack-cuisine/', '/fr/p/pack-cuisine/']));
    expect(rules(r.violations)).toEqual([]);
    const ar = r.results.find((x) => x.url === '/ar/');
    expect(ar?.fontRequests).toEqual([FONT]);
  });

  it('lead fixture: /fr/ with an unscoped :lang(ar) font rule and an Arabic span downloads the font → fr-font', T, async () => {
    const d = freshSite();
    edit(d, FR_H, (s) => s.replace('<style>', `<style>${AR_FACE}:lang(ar){font-family:"Noto Sans Arabic",system-ui}`)
      .replace('</main>', '<p><span lang="ar">مرحبا</span></p></main>'));
    const r = await runtimeChecks(d, pagesOf(['/fr/']));
    expect(rules(r.violations).join('\n')).toMatch(/^fr-font: \(runtime\) French page downloaded \/font\/noto-sans-arabic-400\.woff2/m);
  });

  it('a font pulled in only by :hover/:focus on the language switch is caught by the interaction pass', T, async () => {
    const d = freshSite();
    edit(d, FR_H, (s) => s.replace('<style>', `<style>${AR_FACE}.sw{font-family:system-ui}.sw:focus,.sw:hover{font-family:"Noto Sans Arabic",system-ui}`)
      .replace('</header>', '<a class="sw" href="/ar/" lang="ar">العربية</a></header>'));
    // without interaction nothing is downloaded…
    const quiet = await runtimeChecks(d, pagesOf(['/fr/']));
    expect(quiet.results.find((x) => x.url === '/fr/')?.fontRequests).toEqual([]);
    const r = await runtimeChecks(d, pagesOf(['/fr/']));
    expect(rules(r.violations).join('\n')).toMatch(/fr-font: \(runtime\)/);
  });

  it('Turnstile injected on load instead of on interaction → third-party (runtime)', T, async () => {
    const d = freshSite();
    put(d, 'js/order.js', `${ORDER_JS}\nloadTurnstile();\n`);
    const r = await runtimeChecks(d, pagesOf(['/fr/p/pack-cuisine/']));
    expect(rules(r.violations).join('\n')).toMatch(/third-party: \(runtime\) Chrome requested https:\/\/challenges\.cloudflare\.com\/turnstile/);
  });

  it('a page that does not load is a runtime violation, never a silent pass', T, async () => {
    const d = freshSite();
    const r = await runtimeChecks(d, pagesOf(['/fr/does-not-exist/']));
    expect(rules(r.violations).join('\n')).toMatch(/^runtime: page did not load/m);
  });
});
