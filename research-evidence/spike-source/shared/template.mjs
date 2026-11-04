// Shared renderer used by S1 (build-time) and S2 (Hono, request-time). S3 (Rust) mirrors it.
import { WILAYAS, PRODUCT } from "./data.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export const CSS = `:root{--ink:#14110f;--muted:#5d564f;--line:#e6e0d8;--bg:#faf8f5;--card:#fff;--gold:#8a6a2f;--accent:#1d1a17;--r:14px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
[lang=ar] body,body:lang(ar){font-family:var(--ar,system-ui),"Noto Sans Arabic","Noto Naskh Arabic",Tahoma,sans-serif;line-height:1.8}
a{color:inherit}.wrap{max-width:1180px;margin-inline:auto;padding-inline:16px}
header{display:flex;align-items:center;justify-content:space-between;padding-block:14px;border-block-end:1px solid var(--line)}
.logo{font-weight:700;letter-spacing:.18em;text-transform:uppercase;font-size:.95rem;text-decoration:none}[lang=ar] .logo{letter-spacing:0}
.lang{font-size:.9rem;padding:8px 12px;border:1px solid var(--line);border-radius:999px;text-decoration:none;min-height:44px;display:inline-flex;align-items:center}
nav[aria-label]{font-size:.85rem;color:var(--muted);padding-block:12px}nav ol{list-style:none;margin:0;padding:0;display:flex;gap:8px;flex-wrap:wrap}nav li+li::before{content:"/";margin-inline-end:8px;color:#b5aca2}
.grid{display:grid;gap:28px;padding-block:8px 48px}@media(min-width:880px){.grid{grid-template-columns:1.1fr .9fr;gap:56px}}
.hero{border-radius:var(--r);overflow:hidden;background:#ece6dd;aspect-ratio:1/1}.hero img{display:block;width:100%;height:auto}
h1{font-size:clamp(1.6rem,4.5vw,2.4rem);line-height:1.15;margin:0 0 8px;font-weight:600;letter-spacing:-.01em}[lang=ar] h1{line-height:1.45;letter-spacing:0}
.tag{color:var(--muted);margin:0 0 18px}.price{font-size:1.75rem;font-weight:700;margin:0 0 4px;font-variant-numeric:tabular-nums}.price small{font-size:.9rem;color:var(--muted);font-weight:500}
.badge{display:inline-block;font-size:.8rem;color:var(--gold);border:1px solid #d9c7a3;border-radius:999px;padding:2px 10px;margin-block-end:18px}
.desc{margin:0 0 22px}h2{font-size:1.05rem;margin:28px 0 10px;font-weight:600}
dl{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;margin:0;font-size:.95rem}dt{color:var(--muted)}dd{margin:0}
form{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px;margin-block-start:26px;display:grid;gap:14px}
label{display:grid;gap:6px;font-size:.92rem;font-weight:500}
input,select{font:inherit;font-size:16px;padding:12px 14px;border:1px solid #cfc6bb;border-radius:10px;background:#fff;color:var(--ink);min-height:48px;width:100%}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #2b5cd6;outline-offset:2px}
.hint{font-size:.8rem;color:var(--muted);font-weight:400}.hp{position:absolute;inset-inline-start:-9999px;width:1px;height:1px;overflow:hidden}
button{font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:14px 18px;min-height:52px;cursor:pointer}
.note{font-size:.85rem;color:var(--muted);margin:0}footer{border-block-start:1px solid var(--line);padding-block:24px;color:var(--muted);font-size:.85rem}
.skip{position:absolute;inset-inline-start:8px;top:-60px;background:#000;color:#fff;padding:8px 12px;border-radius:8px}.skip:focus{top:8px}`;

export const JS = `document.querySelectorAll("form[data-o]").forEach(f=>{const p=f.querySelector("[name=phone]");p.addEventListener("input",()=>{p.value=p.value.replace(/[^0-9]/g,"").slice(0,10);p.setCustomValidity(/^0[567][0-9]{8}$/.test(p.value)||!p.value?"":p.dataset.m)});f.addEventListener("submit",e=>{if(f.hp.value){e.preventDefault();return}f.querySelector("button").disabled=true})})`;

export function fontFace(lang, font) {
  if (lang !== "ar" || font !== "kufi") return "";
  return `@font-face{font-family:"Kufi";src:url(/assets/kufi-ar.woff2) format("woff2");font-display:swap;unicode-range:U+0600-06FF,U+200C-200F,U+FD3E-FD3F}:root{--ar:"Kufi"}`;
}

export function render(lang, opts = {}) {
  const font = opts.font || "kufi";
  const p = PRODUCT[lang], u = p.ui;
  const opt = WILAYAS.map(([fr, ar], i) => {
    const n = String(i + 1).padStart(2, "0");
    return `<option value="${n}">${n} - ${esc(lang === "ar" ? ar : fr)}</option>`;
  }).join("");
  const specs = p.specs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const preload = lang === "ar" && font === "kufi" ? `<link rel="preload" href="/assets/kufi-ar.woff2" as="font" type="font/woff2" crossorigin>` : "";
  return `<!doctype html><html lang="${u.lang}" dir="${u.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(u.title)}</title><meta name="description" content="${esc(p.tagline)}"><link rel="alternate" hreflang="fr-DZ" href="/fr/"><link rel="alternate" hreflang="ar-DZ" href="/ar/">${preload}<link rel="preload" as="image" imagesrcset="/assets/hero-400.avif 400w,/assets/hero-640.avif 640w,/assets/hero-960.avif 960w" imagesizes="(min-width:880px) 600px,100vw" type="image/avif" fetchpriority="high"><style>${fontFace(lang, font)}${CSS}</style></head><body><a class="skip" href="#main">${lang === "ar" ? "انتقل إلى المحتوى" : "Aller au contenu"}</a><div class="wrap"><header><a class="logo" href="/${lang}/">Maison Lumen</a><a class="lang" href="${u.otherHref}" hreflang="${lang === "ar" ? "fr" : "ar"}" lang="${lang === "ar" ? "fr" : "ar"}">${u.other}</a></header><nav aria-label="${lang === "ar" ? "مسار التنقل" : "Fil d'Ariane"}"><ol><li><a href="/${lang}/">${u.home}</a></li><li><a href="/${lang}/">${u.cat}</a></li><li aria-current="page">${esc(p.name)}</li></ol></nav><main id="main" class="grid"><div class="hero"><picture><source type="image/avif" srcset="/assets/hero-400.avif 400w,/assets/hero-640.avif 640w,/assets/hero-960.avif 960w" sizes="(min-width:880px) 600px,100vw"><img src="/assets/hero-640.webp" srcset="/assets/hero-400.webp 400w,/assets/hero-640.webp 640w,/assets/hero-960.webp 960w" sizes="(min-width:880px) 600px,100vw" width="960" height="960" alt="${esc(p.name)}" fetchpriority="high" decoding="async"></picture></div><div><h1>${esc(p.name)}</h1><p class="tag">${esc(p.tagline)}</p><p class="price"><span class="sr" hidden>${u.priceLabel}</span>${fmt(PRODUCT.price)}&nbsp;${u.currency} <small>TTC</small></p><span class="badge">${lang === "ar" ? "إصدار محدود · 120 قطعة" : "Édition limitée · 120 pièces"}</span><p class="desc">${esc(p.desc)}</p><h2>${u.specs}</h2><dl>${specs}</dl><form data-o method="post" action="/api/order" aria-labelledby="oh"><h2 id="oh" style="margin:0">${u.order}</h2><input type="hidden" name="sku" value="${PRODUCT.sku}"><input type="hidden" name="lang" value="${lang}"><label>${u.name}<input name="name" autocomplete="name" required minlength="3" maxlength="80"></label><label>${u.phone}<span class="hint" id="ph">${u.phoneHint}</span><input name="phone" type="tel" inputmode="numeric" autocomplete="tel" required pattern="0[567][0-9]{8}" maxlength="10" aria-describedby="ph" data-m="${esc(u.phoneHint)}" dir="ltr"></label><label>${u.wilaya}<select name="wilaya" required><option value="">${u.choose}</option>${opt}</select></label><label>${u.commune}<input name="commune" required maxlength="60" autocomplete="address-level2"></label><div class="hp" aria-hidden="true"><label>Website<input name="hp" tabindex="-1" autocomplete="off"></label></div><button type="submit">${u.submit}</button><p class="note">${u.note}</p></form></div></main><footer>© 2026 Maison Lumen · ${lang === "ar" ? "الجزائر" : "Algérie"}</footer></div><script type="module">${JS}</script></body></html>`;
}
