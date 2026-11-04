// Pure builder for specimen/{fr,ar}.html: every token, the contrast of every brand pair, the icon
// set (mirrored in RTL), and base.css/forms.css components. Self-contained static pages (CSS
// inlined, font from ../fonts/), no JS. Used for brand's guide and for review screenshots.
import type { BrandTokens } from './build-tokens.ts';

export interface SpecimenInput {
  brand: BrandTokens;
  tokensCss: string;
  fontFaceCss: string;
  baseCss: string;
  formsCss: string;
  icons: Record<string, { svg: string; mirror: boolean }>;
  fontSize: Record<string, { css: string; px360: number; px1440: number }>;
  space: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  motion: { duration: Record<string, string>; easing: Record<string, string> };
}

type Lang = 'fr' | 'ar';

const T = {
  fr: {
    title: 'Système visuel',
    intro: 'Jetons de design, police, icônes et composants de la boutique HB Destockage. Page générée, ne pas modifier.',
    other: 'العربية', otherLabel: 'Lire cette page en arabe',
    colours: 'Couleurs', pairs: 'Contraste des paires autorisées', ratio: 'rapport', min: 'min.', use: 'usage',
    type: 'Échelle typographique', typeNote: 'Fluide de 360 à 1440 px. Valeurs à 360 / 1440 px.',
    sample: 'Pack cuisine 12 pièces, livré chez vous', para: 'Des prix de déstockage, une qualité choisie. Livré chez vous, payé à la réception, dans les 69 wilayas.',
    space: 'Espacements', radius: 'Rayons', shadow: 'Ombres', motion: 'Mouvement',
    motionNote: 'CSS seulement. Durées réduites à 0,01 ms avec « réduire les animations ».',
    icons: 'Icônes', mirrored: 'miroir en RTL', island: 'Dans un îlot § (jamais retourné) :',
    comps: 'Composants', order: 'Commander', whatsapp: 'WhatsApp', disabled: 'Indisponible', menu: 'Menu',
    name: 'Nom complet', nameHint: 'Tel qu’il figure sur votre pièce d’identité', phone: 'Téléphone',
    phoneErr: 'Numéro de mobile algérien invalide', wilaya: 'Wilaya', size: 'Taille', colour: 'Couleur',
    red: 'Rouge', blue: 'Bleu', grey: 'Gris', delivery: 'Livraison à domicile', pickup: 'Retrait au bureau',
    info: 'Paiement à la livraison : vous payez au livreur.', ok: 'Commande confirmée.', low: 'Plus que 3 en stock.', err: 'Corrigez les 2 champs signalés.',
    eyebrow: 'Nouveautés', price: '14 600 DA', was: '16 500 DA', popover: 'Ouvrir un popover', popoverBody: 'Entrée CSS avec @starting-style.',
  },
  ar: {
    title: 'النظام البصري',
    intro: 'رموز التصميم والخط والأيقونات ومكوّنات متجر HB Destockage. صفحة مولَّدة، لا تُعدَّل يدويًا.',
    other: 'Français', otherLabel: 'Lire cette page en français',
    colours: 'الألوان', pairs: 'تباين الأزواج المسموح بها', ratio: 'النسبة', min: 'الأدنى', use: 'الاستعمال',
    type: 'سلّم الخطوط', typeNote: 'متدرّج من 360 إلى 1440 بكسل. القيم عند 360 / 1440 بكسل.',
    sample: 'طقم أواني المطبخ 12 قطعة، يصلك إلى البيت', para: 'أسعار التصفية بجودة مختارة. التوصيل إلى باب بيتك والدفع عند الاستلام، في 69 ولاية. ڨالمة، ڤيتامين، ڢ، ڧ.',
    space: 'المسافات', radius: 'الزوايا', shadow: 'الظلال', motion: 'الحركة',
    motionNote: 'بـ CSS فقط. تصبح المدد 0.01 ملّي ثانية عند تفعيل «تقليل الحركة».',
    icons: 'الأيقونات', mirrored: 'معكوسة في RTL', island: 'داخل جزيرة § (لا تنعكس أبدًا):',
    comps: 'المكوّنات', order: 'اطلب الآن', whatsapp: 'واتساب', disabled: 'غير متوفر', menu: 'القائمة',
    name: 'الاسم الكامل', nameHint: 'كما هو في بطاقة التعريف', phone: 'رقم الهاتف',
    phoneErr: 'رقم هاتف جزائري غير صالح', wilaya: 'الولاية', size: 'المقاس', colour: 'اللون',
    red: 'أحمر', blue: 'أزرق', grey: 'رمادي', delivery: 'التوصيل إلى المنزل', pickup: 'الاستلام من المكتب',
    info: 'الدفع عند الاستلام: تدفع لعامل التوصيل.', ok: 'تم تأكيد الطلب.', low: 'بقيت 3 قطع فقط.', err: 'صحّح الحقلين المشار إليهما.',
    eyebrow: 'جديد', price: '14.600 د.ج.', was: '16.500 د.ج.', popover: 'افتح نافذة منبثقة', popoverBody: 'دخول بـ CSS عبر @starting-style.',
  },
} as const;

/** WCAG 2.x relative luminance contrast of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = hex.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SPECIMEN_CSS = `
@layer components {
  .sp-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-4); padding-block: var(--space-6); border-block-end: var(--bw-hairline) solid var(--color-border); }
  .sp-switch { font-family: var(--font-switcher); }
  .sp-section { padding-block: var(--space-10); border-block-end: var(--bw-hairline) solid var(--color-border); }
  .sp-section > h2 { margin-block-end: var(--space-6); }
  .sp-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: var(--space-3); }
  .sp-swatch { border: var(--bw-hairline) solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; font-size: var(--fs-small); }
  .sp-swatch > div { block-size: 3.5rem; }
  .sp-swatch > p { padding: var(--space-2); }
  .sp-pairs { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: var(--space-2); }
  .sp-pair { border: var(--bw-hairline) solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; font-size: var(--fs-small); }
  .sp-pair > p { padding: var(--space-2) var(--space-3); }
  .sp-pair-sample { display: flex; align-items: center; min-block-size: 3.5rem; padding-inline: var(--space-3); font-size: var(--fs-body); }
  .sp-ring { display: block; inline-size: 2.5rem; block-size: 1.75rem; border: 3px solid; border-radius: var(--radius-sm); }
  .sp-type { display: grid; gap: var(--space-4); }
  .sp-type > div { display: grid; gap: var(--space-1); }
  .sp-meta { font-size: var(--fs-caption); color: var(--color-text-secondary); }
  .sp-bar { block-size: var(--space-3); background: var(--color-accent); border-radius: var(--radius-sm); }
  .sp-boxes { display: flex; flex-wrap: wrap; gap: var(--space-4); }
  .sp-box { display: grid; place-items: center; inline-size: 7rem; block-size: 5rem; padding: var(--space-2); background: var(--color-surface-alt); font-size: var(--fs-caption); text-align: center; }
  .sp-icons { display: grid; grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr)); gap: var(--space-2); }
  .sp-icon { display: grid; justify-items: center; gap: var(--space-1); padding: var(--space-3); border: var(--bw-hairline) solid var(--color-border); border-radius: var(--radius-md); font-size: var(--fs-caption); text-align: center; }
  .sp-icon svg { inline-size: var(--icon-lg); block-size: var(--icon-lg); }
  .sp-form { display: grid; gap: var(--space-5); max-inline-size: 30rem; }
  .sp-popover { margin: auto; padding: var(--space-6); border: 0; border-radius: var(--radius-lg); box-shadow: var(--shadow-overlay); }
}`;

export function buildSpecimen(lang: Lang, x: SpecimenInput): string {
  const t = T[lang];
  // Escape, and in Arabic isolate Latin runs (brand names, CSS terms) so bidi never reorders them.
  const esc = (s: string): string =>
    lang === 'ar'
      ? s.split(/([A-Za-z@][A-Za-z0-9@.\- ]*[A-Za-z0-9])/).map((part, i) => (i % 2 ? `<bdi dir="ltr">${escHtml(part)}</bdi>` : escHtml(part))).join('')
      : escHtml(s);
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const other: Lang = lang === 'ar' ? 'fr' : 'ar';
  const colours = Object.entries(x.brand.color).filter(([k]) => !k.startsWith('$'));
  const hex = Object.fromEntries(colours.map(([k, v]) => [k, String(v.$value)]));
  const icon = (n: string, cls = 'icon'): string => (x.icons[n]?.svg ?? '').replace('<svg ', `<svg class="${cls}" `);
  const css = [x.tokensCss, x.fontFaceCss.replace('url("./fonts/', 'url("../fonts/'), x.baseCss, x.formsCss, SPECIMEN_CSS].join('\n');
  const isHex = (v: string): boolean => /^#[0-9a-f]{6}$/i.test(v);

  const swatches = colours
    .map(([k, v]) => `<div class="sp-swatch"><div style="background:var(--color-${k})"></div><p><bdi dir="ltr">--color-${k}</bdi><br><span class="muted nums"><bdi dir="ltr">${esc(String(v.$value))}</bdi></span></p></div>`)
    .join('');
  const pairs = (x.brand.contrastPairs?.pairs ?? [])
    .map((p) => {
      const fg = hex[p.fg] ?? '';
      const bg = hex[p.bg] ?? '';
      const r = isHex(fg) && isHex(bg) ? contrast(fg, bg) : 0;
      const ok = r >= p.min;
      // Text pairs (min 4.5) show text in fg on bg; non-text pairs (min 3: outlines, rings) show a 3px
      // ring in fg on bg. The caption sits on the page surface so it is always readable.
      const sample = p.min >= 4.5
        ? `<span style="color:var(--color-${p.fg})">${lang === 'ar' ? 'نص Aa 14.600' : 'Texte Aa 14 600'}</span>`
        : `<span class="sp-ring" style="border-color:var(--color-${p.fg})"></span>`;
      return `<div class="sp-pair"><div class="sp-pair-sample" style="background:var(--color-${p.bg})">${sample}</div><p><bdi dir="ltr">${p.fg} / ${p.bg}</bdi> · <span class="nums">${r.toFixed(2)}:1 ${ok ? '✓' : '✗'} <bdi dir="ltr">≥ ${p.min}</bdi></span><br><span class="muted">${esc(p.use)}</span></p></div>`;
    })
    .join('');
  const type = Object.entries(x.fontSize)
    .map(([k, v]) => `<div><p class="sp-meta"><bdi dir="ltr">--fs-${k}</bdi> · <span class="nums">${v.px360} / ${v.px1440} px</span></p><p style="font-size:var(--fs-${k});line-height:var(--lh-${['display', 'hero', 'h1', 'h2', 'h3'].includes(k) ? 'heading' : 'body'})">${esc(t.sample)}</p></div>`)
    .join('');
  const space = Object.entries(x.space)
    .filter(([k]) => k !== '0')
    .map(([k, v]) => `<div class="cluster"><span class="sp-meta nums" style="min-inline-size:7rem"><bdi dir="ltr">--space-${k} ${v}</bdi></span><div class="sp-bar" style="inline-size:var(--space-${k})"></div></div>`)
    .join('');
  const radius = Object.keys(x.radius)
    .map((k) => `<div class="sp-box" style="border-radius:var(--radius-${k})"><bdi dir="ltr">--radius-${k}</bdi></div>`)
    .join('');
  const shadow = Object.keys(x.shadow)
    .map((k) => `<div class="sp-box" style="background:var(--color-surface);box-shadow:var(--shadow-${k})"><bdi dir="ltr">--shadow-${k}</bdi></div>`)
    .join('');
  const motion = [
    ...Object.entries(x.motion.duration).map(([k, v]) => `<bdi dir="ltr">--dur-${k}: ${v}</bdi>`),
    ...Object.entries(x.motion.easing).map(([k, v]) => `<bdi dir="ltr">--ease-${k}: ${v}</bdi>`),
  ].join('<br>');
  const icons = Object.entries(x.icons)
    .map(([n, i]) => `<div class="sp-icon">${icon(n, '')}<bdi dir="ltr">${n}</bdi>${i.mirror ? `<span class="muted">${t.mirrored}</span>` : ''}</div>`)
    .join('');

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(t.title)} · HB Destockage</title>
<link rel="alternate" hreflang="${other}" href="${other}.html">
<style>
${css}
</style>
</head>
<body>
<a class="skip-link" href="#main">${lang === 'ar' ? 'انتقل إلى المحتوى' : 'Aller au contenu'}</a>
<header class="container sp-header">
<div class="stack" style="--stack-gap:var(--space-1)"><p class="eyebrow"><bdi dir="ltr">@hb/ui-tokens</bdi></p><h1>${esc(t.title)}</h1><p class="muted">${esc(t.intro)}</p></div>
<a class="btn btn-secondary sp-switch" href="${other}.html" lang="${other}" hreflang="${other}" aria-label="${escHtml(t.otherLabel)}">${esc(t.other)}</a>
</header>
<main id="main" class="container">
<section class="sp-section"><h2>${esc(t.colours)}</h2><div class="sp-swatches">${swatches}</div>
<h3 style="margin-block:var(--space-8) var(--space-4)">${esc(t.pairs)}</h3><div class="sp-pairs">${pairs}</div></section>
<section class="sp-section"><h2>${esc(t.type)}</h2><p class="muted" style="margin-block-end:var(--space-4)">${esc(t.typeNote)}</p><div class="sp-type">${type}</div>
<p class="reading" style="margin-block-start:var(--space-8)">${esc(t.para)}</p></section>
<section class="sp-section"><h2>${esc(t.space)}</h2><div class="stack" style="--stack-gap:var(--space-2)">${space}</div></section>
<section class="sp-section"><h2>${esc(t.radius)}</h2><div class="sp-boxes">${radius}</div>
<h2 style="margin-block:var(--space-10) var(--space-6)">${esc(t.shadow)}</h2><div class="sp-boxes">${shadow}</div></section>
<section class="sp-section"><h2>${esc(t.motion)}</h2><p class="muted">${esc(t.motionNote)}</p><p class="sp-meta" style="margin-block-start:var(--space-3)">${motion}</p>
<button class="btn btn-secondary" style="margin-block-start:var(--space-4)" popovertarget="pop">${esc(t.popover)}</button><div id="pop" popover class="sp-popover">${esc(t.popoverBody)}</div></section>
<section class="sp-section"><h2>${esc(t.icons)}</h2><div class="sp-icons">${icons}</div>
<p class="muted" style="margin-block-start:var(--space-4)">${esc(t.island).replace('§', '<bdi dir="ltr"><code>dir="ltr"</code></bdi>')} <span dir="ltr">${icon('arrow-start')} ${icon('arrow-end')} ${icon('chevron-start')} ${icon('chevron-end')}</span></p></section>
<section class="sp-section"><h2>${esc(t.comps)}</h2>
<div class="stack" style="--stack-gap:var(--space-6)">
<div class="stack" style="--stack-gap:var(--space-1)"><p class="eyebrow">${esc(t.eyebrow)}</p><p class="display">${esc(t.sample)} <bdi lang="fr">Tefal</bdi></p>
<p class="lead nums">${esc(t.price)} <s class="muted" style="font-size:var(--fs-small)">${esc(t.was)}</s></p></div>
<div class="cluster"><a class="btn btn-primary" href="#main">${icon('bag')}${esc(t.order)}${icon('arrow-end')}</a><a class="btn btn-secondary" href="https://wa.me/213779942022">${icon('whatsapp')}${esc(t.whatsapp)}</a>
<button class="btn btn-icon" type="button" aria-label="${escHtml(t.menu)}">${icon('menu', 'icon icon-lg')}</button><button class="btn btn-primary" type="button" disabled>${esc(t.disabled)}</button></div>
<form class="sp-form" action="#">
<div class="field"><label class="label" for="n-${lang}">${esc(t.name)}</label><input class="input" id="n-${lang}" autocomplete="name" aria-describedby="nh-${lang}"><p class="hint" id="nh-${lang}">${esc(t.nameHint)}</p></div>
<div class="field"><label class="label" for="p-${lang}">${esc(t.phone)}</label><input class="input" id="p-${lang}" type="tel" inputmode="tel" dir="ltr" autocomplete="tel" value="0560 41 74 0" aria-invalid="true" aria-describedby="pe-${lang}"><p class="error" id="pe-${lang}">${icon('alert', 'icon icon-sm')}${esc(t.phoneErr)}</p></div>
<div class="field"><label class="label" for="w-${lang}">${esc(t.wilaya)}</label><select class="input" id="w-${lang}"><option>${lang === 'ar' ? '16 - الجزائر' : '16 - Alger'}</option><option>${lang === 'ar' ? '07 - بسكرة' : '07 - Biskra'}</option></select></div>
<fieldset class="stack" style="--stack-gap:var(--space-2);border:0;padding:0"><legend class="label">${esc(t.size)}</legend><div class="cluster" style="--cluster-gap:var(--space-2)">
<label class="chip"><input type="radio" name="s-${lang}" checked>S</label><label class="chip"><input type="radio" name="s-${lang}">M</label><label class="chip"><input type="radio" name="s-${lang}">L</label><label class="chip"><input type="radio" name="s-${lang}" disabled>XL</label></div></fieldset>
<fieldset class="stack" style="--stack-gap:var(--space-2);border:0;padding:0"><legend class="label">${esc(t.colour)}</legend><div class="cluster" style="--cluster-gap:var(--space-2)">
<label class="chip swatch"><input type="radio" name="c-${lang}" checked><svg viewBox="0 0 1 1" aria-hidden="true"><rect width="1" height="1" fill="#b4232c"/></svg><span class="visually-hidden">${esc(t.red)}</span></label><label class="chip swatch"><input type="radio" name="c-${lang}"><svg viewBox="0 0 1 1" aria-hidden="true"><rect width="1" height="1" fill="#0066cc"/></svg><span class="visually-hidden">${esc(t.blue)}</span></label><label class="chip swatch"><input type="radio" name="c-${lang}"><svg viewBox="0 0 1 1" aria-hidden="true"><rect width="1" height="1" fill="#86868b"/></svg><span class="visually-hidden">${esc(t.grey)}</span></label></div></fieldset>
<div><label class="choice"><input type="radio" name="d-${lang}" checked>${icon('truck')}${esc(t.delivery)}</label><label class="choice"><input type="radio" name="d-${lang}">${icon('home')}${esc(t.pickup)}</label></div>
<button class="btn btn-primary btn-block" type="submit">${esc(t.order)}</button>
</form>
<div class="note">${icon('info')}<p>${esc(t.info)}</p></div>
<div class="note note-success">${icon('check')}<p>${esc(t.ok)}</p></div>
<div class="note note-warning">${icon('alert')}<p>${esc(t.low)}</p></div>
<div class="note note-danger" role="alert">${icon('alert')}<p>${esc(t.err)}</p></div>
</div></section>
</main>
</body>
</html>
`;
}
