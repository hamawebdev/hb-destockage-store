use worker::*;
mod data;
use data::*;

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() { match c { '&' => o.push_str("&amp;"), '<' => o.push_str("&lt;"), '>' => o.push_str("&gt;"), '"' => o.push_str("&quot;"), '\'' => o.push_str("&#39;"), _ => o.push(c) } }
    o
}
fn fmt(n: u32) -> String {
    let s = n.to_string(); let b = s.as_bytes(); let mut o = String::new();
    for (i, ch) in b.iter().enumerate() { if i > 0 && (b.len() - i) % 3 == 0 { o.push('\u{a0}'); } o.push(*ch as char); }
    o
}
fn render(ar: bool, kufi: bool) -> String {
    let p = if ar { &AR } else { &FR };
    let lang = p.lang;
    let mut opt = String::with_capacity(4096);
    for (i, (fr, a)) in WILAYAS.iter().enumerate() { opt.push_str(&format!("<option value=\"{:02}\">{:02} - {}</option>", i + 1, i + 1, esc(if ar { a } else { fr }))); }
    let mut specs = String::new();
    for (k, v) in p.specs { specs.push_str(&format!("<dt>{}</dt><dd>{}</dd>", esc(k), esc(v))); }
    let ff = if ar && kufi { "@font-face{font-family:\"Kufi\";src:url(/assets/kufi-ar.woff2) format(\"woff2\");font-display:swap;unicode-range:U+0600-06FF,U+200C-200F,U+FD3E-FD3F}:root{--ar:\"Kufi\"}" } else { "" };
    let preload = if ar && kufi { "<link rel=\"preload\" href=\"/assets/kufi-ar.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>" } else { "" };
    let (skip, crumb, other_lang, badge, country) = if ar { ("انتقل إلى المحتوى", "مسار التنقل", "fr", "إصدار محدود · 120 قطعة", "الجزائر") } else { ("Aller au contenu", "Fil d'Ariane", "ar", "Édition limitée · 120 pièces", "Algérie") };
    let srcset_avif = "/assets/hero-400.avif 400w,/assets/hero-640.avif 640w,/assets/hero-960.avif 960w";
    let sizes = "(min-width:880px) 600px,100vw";
    format!("<!doctype html><html lang=\"{lang}\" dir=\"{dir}\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title><meta name=\"description\" content=\"{tag}\"><link rel=\"alternate\" hreflang=\"fr-DZ\" href=\"/fr/\"><link rel=\"alternate\" hreflang=\"ar-DZ\" href=\"/ar/\">{preload}<link rel=\"preload\" as=\"image\" imagesrcset=\"{srcset_avif}\" imagesizes=\"{sizes}\" type=\"image/avif\" fetchpriority=\"high\"><style>{ff}{css}</style></head><body><a class=\"skip\" href=\"#main\">{skip}</a><div class=\"wrap\"><header><a class=\"logo\" href=\"/{lang}/\">Maison Lumen</a><a class=\"lang\" href=\"{oh}\" hreflang=\"{ol}\" lang=\"{ol}\">{other}</a></header><nav aria-label=\"{crumb}\"><ol><li><a href=\"/{lang}/\">{home}</a></li><li><a href=\"/{lang}/\">{cat}</a></li><li aria-current=\"page\">{name}</li></ol></nav><main id=\"main\" class=\"grid\"><div class=\"hero\"><picture><source type=\"image/avif\" srcset=\"{srcset_avif}\" sizes=\"{sizes}\"><img src=\"/assets/hero-640.webp\" srcset=\"/assets/hero-400.webp 400w,/assets/hero-640.webp 640w,/assets/hero-960.webp 960w\" sizes=\"{sizes}\" width=\"960\" height=\"960\" alt=\"{name}\" fetchpriority=\"high\" decoding=\"async\"></picture></div><div><h1>{name}</h1><p class=\"tag\">{tag}</p><p class=\"price\"><span class=\"sr\" hidden>{pl}</span>{price}&nbsp;{cur} <small>TTC</small></p><span class=\"badge\">{badge}</span><p class=\"desc\">{desc}</p><h2>{st}</h2><dl>{specs}</dl><form data-o method=\"post\" action=\"/api/order\" aria-labelledby=\"oh\"><h2 id=\"oh\" style=\"margin:0\">{order}</h2><input type=\"hidden\" name=\"sku\" value=\"{sku}\"><input type=\"hidden\" name=\"lang\" value=\"{lang}\"><label>{fname}<input name=\"name\" autocomplete=\"name\" required minlength=\"3\" maxlength=\"80\"></label><label>{phone}<span class=\"hint\" id=\"ph\">{hint}</span><input name=\"phone\" type=\"tel\" inputmode=\"numeric\" autocomplete=\"tel\" required pattern=\"0[567][0-9]{{8}}\" maxlength=\"10\" aria-describedby=\"ph\" data-m=\"{hint_e}\" dir=\"ltr\"></label><label>{wil}<select name=\"wilaya\" required><option value=\"\">{choose}</option>{opt}</select></label><label>{com}<input name=\"commune\" required maxlength=\"60\" autocomplete=\"address-level2\"></label><div class=\"hp\" aria-hidden=\"true\"><label>Website<input name=\"hp\" tabindex=\"-1\" autocomplete=\"off\"></label></div><button type=\"submit\">{submit}</button><p class=\"note\">{note}</p></form></div></main><footer>© 2026 Maison Lumen · {country}</footer></div><script type=\"module\">{js}</script></body></html>",
        lang = lang, dir = p.dir, title = esc(p.title), tag = esc(p.tagline), preload = preload, srcset_avif = srcset_avif, sizes = sizes, ff = ff, css = CSS, skip = skip,
        oh = p.other_href, ol = other_lang, other = p.other, crumb = crumb, home = p.home, cat = p.cat, name = esc(p.name), pl = p.price_label, price = fmt(PRICE), cur = p.currency,
        badge = badge, desc = esc(p.desc), st = p.specs_t, specs = specs, order = p.order, sku = SKU, fname = p.f_name, phone = p.phone, hint = p.phone_hint, hint_e = esc(p.phone_hint),
        wil = p.wilaya, choose = p.choose, opt = opt, com = p.commune, submit = p.submit, note = p.note, country = country, js = JS)
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path = url.path().to_string();
    let (ar, kufi) = match path.as_str() { "/fr/" => (false, false), "/ar/" => (true, true), "/ar-sys/" => (true, false),
        "/" => return Response::redirect(Url::parse(&format!("{}fr/", url.origin().ascii_serialization() + "/"))?),
        _ => return env.assets("ASSETS")?.fetch_request(req).await };
    let nocache = url.query().map(|q| q.contains("nocache")).unwrap_or(false);
    let cache = Cache::default();
    let key = format!("{}{}", url.origin().ascii_serialization(), path);
    if !nocache { if let Some(mut hit) = cache.get(&key, false).await? { let b = hit.bytes().await?; let h = Headers::new(); h.set("content-type", "text/html; charset=utf-8")?; h.set("x-s2-cache", "HIT")?; return Ok(Response::from_bytes(b)?.with_headers(h)); } }
    let headers = Headers::new();
    headers.set("content-type", "text/html; charset=utf-8")?;
    headers.set("cache-control", "public, max-age=0, s-maxage=600")?;
    headers.set("x-s2-cache", "MISS")?;
    let mut res = Response::ok(render(ar, kufi))?.with_headers(headers);
    if !nocache { let c = res.cloned()?; ctx.wait_until(async move { let _ = Cache::default().put(key, c).await; }); }
    Ok(res)
}
