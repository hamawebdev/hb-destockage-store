/**
 * Single-page fixtures for the keyboard pass and the measured contrast check (MEAS-3 r2).
 * `trap` is rev-c's review fixture verbatim (artifacts/MEAS-3/rev-c-evidence/fixtures/fr/trap/);
 * `half`, `partial`, `imgbg` and `ar-ok` are rev-a's r2 fixtures verbatim
 * (artifacts/MEAS-3/rev-a-r2/fixtures/), `half.png` included.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HEAD = '<!doctype html><html lang="fr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title>'
  + '<style>body{font:16px system-ui;margin:20px}a,button,summary,input,select{display:inline-block;padding:12px;color:#0066cc}:focus-visible{outline:2px solid #0071e3;outline-offset:2px}'
  + '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.sr:focus{position:static;width:auto;height:auto;clip:auto}</style></head><body>';
const page = (body: string): string => `${HEAD}${body}</body></html>`;

export const A11Y_PAGES: Record<string, string> = {
  /** rev-c: a keydown handler bounces Tab between two links; the third is never reached. */
  trap: '<!doctype html><html lang="fr" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title><style>body{font:16px system-ui;margin:20px}a{display:inline-block;padding:12px;color:#0066cc}a:focus-visible{outline:2px solid #0071e3;outline-offset:2px}</style></head><body><main><h1>Test</h1><p><a id="x" href="#a">Piège A</a> <a id="y" href="#b">Piège B</a> <a href="#c">Jamais atteint</a></p><script>document.addEventListener(\'keydown\',function(e){if(e.key===\'Tab\'){e.preventDefault();var a=document.getElementById(\'x\'),b=document.getElementById(\'y\');(document.activeElement===a?b:a).focus();}});</script></main></body></html>',
  /** a broken modal: a focusout handler pulls focus back into a region in the middle of the page. */
  region: page('<main><h1>Test</h1><p><a href="#0">Avant</a></p><div id="m" role="group" aria-label="Fenêtre"><a href="#1">Un</a> <a href="#2">Deux</a></div><p><a href="#3">Après</a></p>'
    + '<script>var m=document.getElementById(\'m\');m.addEventListener(\'focusout\',function(e){if(e.relatedTarget&&!m.contains(e.relatedTarget))m.querySelector(\'a\').focus();});</script></main>'),
  /** traps Shift+Tab only: forward Tab is fine. */
  shift: page('<main><h1>Test</h1><p><a id="x" href="#a">Un</a> <a id="y" href="#b">Deux</a> <a id="z" href="#c">Trois</a></p>'
    + '<script>document.addEventListener(\'keydown\',function(e){if(e.key===\'Tab\'&&e.shiftKey&&document.activeElement.id===\'y\'){e.preventDefault();document.getElementById(\'z\').focus();}});</script></main>'),
  /** no trap, many elements Tab skips by design: must pass (no false "never reached"). */
  widgets: page('<a class="sr" href="#main">Aller au contenu</a><main id="main"><h1>Test</h1><form>'
    + '<fieldset><legend>Couleur</legend><label><input type="radio" name="c" value="1"> Rouge</label><label><input type="radio" name="c" value="2" checked> Bleu</label><label><input type="radio" name="c" value="3"> Vert</label></fieldset>'
    + '<label>Qté <select name="q"><option>1</option><option>2</option></select></label><label>Nom <input name="n"></label><button disabled>Désactivé</button>'
    + '<fieldset disabled><legend>Off</legend><input name="off" aria-label="off"></fieldset><span tabindex="-1">pas tabbable</span><a href="#h" style="display:none">caché</a>'
    + '<a href="#v" style="visibility:hidden">invisible</a><div inert><a href="#i">inerte</a></div><details><summary>Plus</summary><a href="#d">Dans details</a></details>'
    + '<dialog><button type="button">Dans dialog</button></dialog><button type="button">Envoyer</button></form></main>'),
  /** #ddd text on a near-white gradient: axe says `incomplete` (bgGradient), contrast is about 1.3:1. */
  'contrast-low': page('<main><h1>Test</h1><div style="background:linear-gradient(90deg,#f8f8f8,#fbfbfb);padding:20px"><p style="color:#dddddd">Texte presque invisible sur un dégradé</p></div><p><a href="#a">Lien</a></p></main>'),
  /** #222 text on the same gradient: incomplete for axe, measured well above 4.5:1. */
  'contrast-ok': page('<main><h1>Test</h1><div style="background:linear-gradient(90deg,#f8f8f8,#fbfbfb);padding:20px"><p style="color:#222">Texte lisible sur un dégradé</p></div><p><a href="#a">Lien</a></p></main>'),
  /** a lazy image far below the fold: loading must neither hang nor skip it. */
  lazy: page('<main><h1>Test</h1><p><a href="#a">Lien</a></p><div style="height:6000px"></div><img src="/img/lazy-missing.png" loading="lazy" alt="Image différée" width="10" height="10"></main>'),
  /** rev-a: white text on a black|white gradient, the second half of the sentence is invisible (1:1). */
  half: "<!doctype html><html lang=\"fr\" dir=\"ltr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>T</title><style>body{font:16px system-ui;margin:20px}a{display:inline-block;padding:12px;color:#0066cc}a:focus-visible{outline:2px solid #0071e3;outline-offset:2px}</style></head><body><main><h1>Test</h1><div style=\"background:linear-gradient(90deg,#000 0 50%,#fff 50% 100%);padding:0;width:100%\"><p style=\"color:#fff;margin:0;padding:8px 0;white-space:nowrap;overflow:hidden\">Livraison gratuite partout en Algerie, paiement a la livraison, retour gratuit sous sept jours ici</p></div><p><a href=\"#a\">Lien</a></p></main></body></html>",
  /** rev-a: the same with only the last 7 % on white. */
  partial: "<!doctype html><html lang=\"fr\" dir=\"ltr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>T</title><style>body{font:16px system-ui;margin:20px}a{display:inline-block;padding:12px;color:#0066cc}a:focus-visible{outline:2px solid #0071e3;outline-offset:2px}</style></head><body><main><h1>Test</h1><div style=\"background:linear-gradient(90deg,#000 0 93%,#fff 93% 100%);padding:0;width:100%\"><p style=\"color:#fff;margin:0;padding:8px 0;white-space:nowrap;overflow:hidden\">Livraison gratuite partout en Algerie, paiement a la livraison, retour gratuit sous sept jours ici</p></div><p><a href=\"#a\">Lien</a></p></main></body></html>",
  /** rev-a: white text over an <img> that is light on its right half. */
  imgbg: "<!doctype html><html lang=\"fr\" dir=\"ltr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>T</title><style>body{font:16px system-ui;margin:20px}a{display:inline-block;padding:12px;color:#0066cc}a:focus-visible{outline:2px solid #0071e3;outline-offset:2px}</style></head><body><main><h1>Test</h1><div style=\"position:relative;width:400px;height:60px\"><img src=\"/img/half.png\" alt=\"\" width=\"400\" height=\"60\" style=\"position:absolute;inset:0\"><p style=\"position:relative;color:#fff;margin:0;padding:18px 8px;white-space:nowrap\">Pack cuisine complet a prix destockage</p></div><p><a href=\"#a\">Lien</a></p></main></body></html>",
  /** white text over a "product photo shot on white" (an <img>, near-white everywhere): unreadable. */
  'white-photo': page('<main><h1>Test</h1><div style="position:relative;width:320px;height:60px"><img src="/img/white-photo.svg" alt="" width="320" height="60" style="position:absolute;inset:0"><p style="position:relative;color:#fff;margin:0;padding:18px 8px;white-space:nowrap">Pack cuisine complet</p></div><p><a href="#a">Lien</a></p></main>'),
  /** best-practice only (no WCAG tag): text outside every landmark (`region`). */
  'outside-landmarks': page('<main><h1>Test</h1><p><a href="#a">Lien</a></p></main><p>Texte hors de tout repère</p>'),
  /** rev-a: Arabic RTL, #1a1a1a over a light gradient; must pass. */
  'ar-ok': "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>T</title><style>body{font:18px system-ui;margin:20px;line-height:1.7}a{display:inline-block;padding:12px;color:#0066cc}a:focus-visible{outline:2px solid #0071e3}</style></head><body><main><h1>اختبار</h1><div style=\"background:linear-gradient(90deg,#f6f6f6,#fdfdfd);padding:16px\"><p style=\"color:#1a1a1a;margin:0\">التوصيل مجاني إلى جميع الولايات والدفع عند الاستلام</p></div><p><a href=\"#a\">رابط</a></p></main></body></html>",
};

/** Images the pages above use, written under /img/. */
const IMG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="60"><rect width="320" height="60" fill="#fdfdfd"/><ellipse cx="240" cy="30" rx="70" ry="24" fill="#f2f2f2"/></svg>';

/** Write A11Y_PAGES into a built-site dir as /fr/<name>/index.html. */
export function addA11yPages(dist: string): void {
  for (const [name, html] of Object.entries(A11Y_PAGES)) {
    mkdirSync(path.join(dist, 'fr', name), { recursive: true });
    writeFileSync(path.join(dist, 'fr', name, 'index.html'), html);
  }
  mkdirSync(path.join(dist, 'img'), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, 'half.png'), path.join(dist, 'img/half.png'));
  writeFileSync(path.join(dist, 'img/white-photo.svg'), IMG_SVG);
}
