#!/usr/bin/env node
// Builds favicons, app icons and social (Open Graph) images into brand/assets/ from the logo SVGs,
// and refreshes the admin's byte copy of the monogram (apps/admin/public/assets/brand/monogram.svg:
// Workers static assets cannot read another package; apps/admin/test/assets.test.ts checks the copy).
//
//   node brand/scripts/build-assets.mjs
//
// Deterministic: sharp 0.35.5 (librsvg + Pango/HarfBuzz for text), fonts pinned by path through a
// private fontconfig file, so the system's other fonts can't change the output.
// Fonts (SIL OFL 1.1):
//   INTER_TTF        Inter variable  https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf
//   NOTO_ARABIC_TTF  Noto Sans Arabic Regular v2.013 (400 only — brand rule: one Arabic weight), from
//                    the notofonts release zip pinned below (zip + member sha256); needs `unzip`.
// Both are downloaded and verified when the env vars are not set; a mismatch stops the build.
// The logo itself is outlined paths (brand/logo), never set in a font.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const brand = resolve(here, "..");
const OUT = join(brand, "assets");
const ADMIN_MONOGRAM = resolve(brand, "../apps/admin/public/assets/brand/monogram.svg");

const INTER_URL = "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf";
const INTER_SHA256 = "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031"; // same file as build-logo.py
let INTER = process.env.INTER_TTF ?? null;
// Same pinned release as packages/ui-tokens/fonts/subset.json (TOKENS-2), so the social images use
// exactly the storefront's Arabic face.
const NOTO_ZIP_URL = "https://github.com/notofonts/arabic/releases/download/NotoSansArabic-v2.013/NotoSansArabic-v2.013.zip";
const NOTO_ZIP_SHA256 = "1301aceaea84c501cf2e6dcfb3182e2328c8eae5725817fcb239672bda7154f1";
const NOTO_MEMBER = "NotoSansArabic/unhinted/ttf/NotoSansArabic-Regular.ttf";
const NOTO_SHA256 = "bd86ca02f087d7f3c3788ba458fb6b73744c7639ed276b8d870dba6def6c40d0";
let NOTO_AR = process.env.NOTO_ARABIC_TTF ?? null;

// --- private fontconfig: must be set before sharp/libvips initialises fontconfig ----------------
const sha256 = async (buf) => (await import("node:crypto")).createHash("sha256").update(buf).digest("hex");

async function fetchNoto() {
  if (NOTO_AR) {
    const d = await sha256(readFileSync(NOTO_AR));
    if (d !== NOTO_SHA256) throw new Error(`NOTO_ARABIC_TTF sha256 ${d} != pinned v2.013 ${NOTO_SHA256}`);
    return;
  }
  const res = await fetch(NOTO_ZIP_URL);
  if (!res.ok) throw new Error(`Noto Sans Arabic download failed: ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const zd = await sha256(zip);
  if (zd !== NOTO_ZIP_SHA256) throw new Error(`Noto zip sha256 ${zd} != pinned ${NOTO_ZIP_SHA256}`);
  const dir = mkdtempSync(join(tmpdir(), "hb-noto-"));
  writeFileSync(join(dir, "noto.zip"), zip);
  const { execFileSync } = await import("node:child_process");
  const ttf = execFileSync("unzip", ["-p", join(dir, "noto.zip"), NOTO_MEMBER], { maxBuffer: 64 * 1024 * 1024 });
  const td = await sha256(ttf);
  if (td !== NOTO_SHA256) throw new Error(`Noto member sha256 ${td} != pinned ${NOTO_SHA256}`);
  NOTO_AR = join(dir, "NotoSansArabic-Regular.ttf");
  writeFileSync(NOTO_AR, ttf);
}

async function fetchInter() {
  if (INTER) return;
  const res = await fetch(INTER_URL);
  if (!res.ok) throw new Error(`Inter download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== INTER_SHA256) throw new Error(`Inter sha256 ${digest} != pinned ${INTER_SHA256}; pass INTER_TTF=<pinned file>`);
  INTER = join(mkdtempSync(join(tmpdir(), "hb-inter-")), "Inter.ttf");
  writeFileSync(INTER, buf);
}

function setupFonts() {
  for (const f of [INTER, NOTO_AR]) if (!existsSync(f)) throw new Error(`font not found: ${f} (set INTER_TTF / NOTO_ARABIC_TTF)`);
  const dir = mkdtempSync(join(tmpdir(), "hb-fonts-"));
  copyFileSync(INTER, join(dir, "Inter.ttf"));
  copyFileSync(NOTO_AR, join(dir, "NotoSansArabic-Regular.ttf"));
  const conf = join(dir, "fonts.conf");
  writeFileSync(
    conf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${dir}</dir><cachedir>${dir}/cache</cachedir></fontconfig>\n`,
  );
  process.env.FONTCONFIG_FILE = conf;
}

const tokens = JSON.parse(readFileSync(join(brand, "tokens.json"), "utf8"));
const C = Object.fromEntries(Object.entries(tokens.color).map(([k, v]) => [k, v.$value]));
const strings = {
  ar: JSON.parse(readFileSync(join(brand, "copy/strings.ar.json"), "utf8")),
  fr: JSON.parse(readFileSync(join(brand, "copy/strings.fr.json"), "utf8")),
};

// --- monogram parts, read from the outlined logo -----------------------------------------------
const mono = readFileSync(join(brand, "logo/monogram.svg"), "utf8");
const letters = /<path[^>]*\/>/.exec(mono)[0].replace(/fill="[^"]*"/, 'fill="#ffffff"'); // HB letters (64-unit tile)
const dot = /<circle[^>]*\/>/.exec(mono)[0]; // accent eyelet
const wordmark = readFileSync(join(brand, "logo/wordmark.svg"), "utf8");
const wordVB = /viewBox="([^"]+)"/.exec(wordmark)[1].split(" ").map(Number); // 0 -100 W 100
const wordInner = wordmark.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>.*?<\/title>/, "");

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Tile with rounded corners on transparent (favicon, standard icons).
const tile = ({ withDot = true, radius = 14 } = {}) =>
  `<rect width="64" height="64" rx="${radius}" fill="${C.text}"/>${letters}${withDot ? dot : ""}`;

// Full-bleed square; content scaled about the centre (maskable safe zone = 80 % circle).
const bleed = (scale) =>
  `<rect width="64" height="64" fill="${C.text}"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${letters}${dot}</g>`;

function faviconSvg() {
  // Light/dark aware: tile inverts on dark browser chrome. Smallest possible markup.
  const l = letters.replace('fill="#ffffff"', 'class="l"');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<style>.t{fill:${C.text}}.l{fill:#fff}@media(prefers-color-scheme:dark){.t{fill:#fff}.l{fill:${C.text}}}</style>` +
    `<rect class="t" width="64" height="64" rx="14"/>${l}${dot}</svg>\n`
  );
}

function ico(pngs) {
  // ICO container with PNG payloads (Vista+ format, supported by every current browser).
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

// --- Open Graph images ---------------------------------------------------------------------------
const W = 1200;
const H = 630;
const M = 88; // outer margin

function lockup(x, y, h) {
  // monogram tile + wordmark; logo never mirrors, only its position does.
  const k = h / 64;
  const capH = h * 0.42;
  const s = capH / 100;
  const gap = h * 0.32;
  const ww = wordVB[2] * s;
  return {
    width: h + gap + ww,
    body:
      `<g transform="translate(${x} ${y}) scale(${k})">${tile()}</g>` +
      `<g transform="translate(${x + h + gap} ${y + h / 2 + capH / 2}) scale(${s})">${wordInner}</g>`,
  };
}

function ogSvg({ lang, headline, sub, eyebrow }) {
  const rtl = lang === "ar";
  const font = rtl ? "Noto Sans Arabic" : "Inter";
  const weight = rtl ? 400 : 600;
  const size = rtl ? 72 : 68;
  const lh = rtl ? 1.6 : 1.12;
  const lines = headline.length > 1 ? headline : headline[0].split(/(?<=[.،,])\s+/);
  const logoH = 64;
  const lk = lockup(0, 0, logoH);
  const logoX = rtl ? W - M - lk.width : M;
  const logo = lockup(logoX, M, logoH).body;
  // librsvg resolves text-anchor against the text direction: "start" in RTL = the right edge at x.
  const anchor = "start";
  const tx = rtl ? W - M : M;
  const ls = rtl ? "" : ` letter-spacing="-1"`;
  const blockH = lines.length * size * lh;
  const baseY = H - M - 70 - blockH + size; // first baseline; sub line sits under the block
  const head = lines
    .map((l, i) => `<text x="${tx}" y="${Math.round(baseY + i * size * lh)}" text-anchor="${anchor}" direction="${rtl ? "rtl" : "ltr"}" font-family="${font}" font-weight="${weight}" font-size="${size}" fill="${C.text}"${ls}>${esc(l)}</text>`)
    .join("");
  const subY = Math.round(baseY + (lines.length - 1) * size * lh + (rtl ? 78 : 66));
  const dotR = 7;
  const subX = rtl ? tx - dotR * 2 - 14 : tx + dotR * 2 + 14;
  const dotCx = rtl ? tx - dotR : tx + dotR;
  const subLine =
    `<circle cx="${dotCx}" cy="${subY - (rtl ? 11 : 10)}" r="${dotR}" fill="${C.accent}"/>` +
    `<text x="${subX}" y="${subY}" text-anchor="${anchor}" direction="${rtl ? "rtl" : "ltr"}" font-family="${font}" font-weight="400" font-size="${rtl ? 30 : 30}" fill="${C["text-secondary"]}">${esc(sub)}</text>`;
  const eyebrowEl = eyebrow
    ? `<text x="${tx}" y="${Math.round(baseY - size - 18)}" text-anchor="${anchor}" direction="${rtl ? "rtl" : "ltr"}" font-family="${font}" font-weight="400" font-size="28" fill="${C["text-secondary"]}">${esc(eyebrow)}</text>`
    : "";
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${C["surface-alt"]}"/>${logo}${eyebrowEl}${head}${subLine}`);
}

async function jpeg(sharp, svgText, file) {
  const buf = await sharp(Buffer.from(svgText), { density: 72 })
    .flatten({ background: C["surface-alt"] })
    .jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
  writeFileSync(join(OUT, file), buf);
  return buf.length;
}

/** Category social image: category title as headline. Exported for packages/catalog if wanted. */
export async function renderCategoryOg(sharp, { lang, title }) {
  const t = strings[lang];
  const svgText = ogSvg({ lang, headline: [title], sub: `${t["trust.cod"]} · ${t["trust.delivery69"]}`, eyebrow: null });
  return sharp(Buffer.from(svgText)).flatten({ background: C["surface-alt"] }).jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
}

async function main() {
  await fetchInter();
  await fetchNoto();
  setupFonts();
  const { default: sharp } = await import("sharp");
  mkdirSync(OUT, { recursive: true });
  const sizes = {};
  const png = async (svgText, size, file, opts = {}) => {
    const buf = await sharp(Buffer.from(svgText), { density: 72 * Math.max(1, size / 64) })
      .resize(size, size)
      .png({ compressionLevel: 9, palette: opts.palette ?? false })
      .toBuffer();
    if (file) writeFileSync(join(OUT, file), buf);
    sizes[file ?? `${size}`] = buf.length;
    return buf;
  };

  writeFileSync(join(OUT, "favicon.svg"), faviconSvg());
  const p16 = await png(svg(64, 64, tile({ withDot: false })), 16, null);
  const p32 = await png(svg(64, 64, tile()), 32, "favicon-32.png");
  writeFileSync(join(OUT, "favicon.ico"), ico([{ size: 16, data: p16 }, { size: 32, data: p32 }]));
  // apple-touch: opaque, square (iOS applies its own mask); content at 0.9 for breathing room.
  const at = await sharp(Buffer.from(svg(64, 64, bleed(0.9))), { density: 72 * 3 }).resize(180, 180).flatten({ background: C.text }).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(OUT, "apple-touch-icon.png"), at);
  await png(svg(64, 64, tile()), 192, "icon-192.png");
  await png(svg(64, 64, tile()), 512, "icon-512.png");
  const mk = await sharp(Buffer.from(svg(64, 64, bleed(0.72))), { density: 72 * 8 }).resize(512, 512).flatten({ background: C.text }).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(OUT, "icon-maskable-512.png"), mk);

  for (const lang of ["ar", "fr"]) {
    const t = strings[lang];
    const svgText = ogSvg({ lang, headline: [t["home.heroTitle"]], sub: `${t["trust.cod"]} · ${t["trust.delivery69"]}` });
    sizes[`og-default-${lang}.jpg`] = await jpeg(sharp, svgText, `og-default-${lang}.jpg`);
    const cat = await renderCategoryOg(sharp, { lang, title: lang === "ar" ? "المطبخ والأواني" : "Cuisine et ustensiles" });
    writeFileSync(join(OUT, `og-category-sample-${lang}.jpg`), cat);
  }
  copyFileSync(join(OUT, "og-default-ar.jpg"), join(OUT, "og-default.jpg")); // x-default = Arabic
  mkdirSync(dirname(ADMIN_MONOGRAM), { recursive: true });
  copyFileSync(join(brand, "logo/monogram.svg"), ADMIN_MONOGRAM);
  console.log("brand/assets written", sizes);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
