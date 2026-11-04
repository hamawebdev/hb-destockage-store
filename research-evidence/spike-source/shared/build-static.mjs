import { render } from "./template.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[2];
for (const [path, lang, font] of [["fr","fr","system"],["ar","ar","kufi"],["ar-sys","ar","system"]]) {
  mkdirSync(`${out}/${path}`, { recursive: true });
  writeFileSync(`${out}/${path}/index.html`, render(lang, { font }));
}
writeFileSync(`${out}/_headers`, `/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n`);
writeFileSync(`${out}/index.html`, `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content="0;url=/fr/"><a href="/fr/">fr</a>`);
