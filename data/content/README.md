# Content pages (brand)

One file per page, `<key>.json`, shaped exactly as `SnapshotContentPage` in
`packages/catalog/src/types.ts` (CAT-1): `id, key, slug{ar,fr}, title, summary, body{ar,fr}, sort,
active, placeholder, updatedAt`. `packages/catalog` reads every `*.json` here (this README is ignored).
Body = plain-text blocks `h2 | p | ul | ol | link`; no HTML, no Markdown.

Rules (tested by `brand/test/content.test.mjs`):

- **Phone numbers are never in running text.** They are `link` blocks (`tel:+213560417403`,
  `https://wa.me/213779942022`), and templates render the text of `tel:`/`wa.me` links inside
  `<bdi dir="ltr">` so they don't reorder on `/ar/`.
- Anything not confirmed by the client contains `[PLACEHOLDER…]` and the page has `"placeholder": true`.
  `privacy` and `legal` open with a placeholder paragraph for the client's legal counsel
  (Law 18-07 as amended by Law 25-11); their bullet points only describe what the site actually does.
- Arabic and French bodies have the same block structure. Slugs are ASCII kebab-case (Arabic slugs
  transliterated), not reserved URL segments.
- French typography: U+00A0 before `:` and inside « », U+202F before `; ? !`.
