# Meta Pixel and Conversions API: go-live checklist

**Status: built and merged switched off. Nothing here has been checked against the real Meta.** Everything was tested against a local stand-in, because no Pixel ID or access token exists yet. The Meta checks at the end are **not done**.

Decision records: D-014 and D-015 (what Meta may do on the storefront), D-017 (the values come from the admin) in `DECISIONS.md`.

## Where the values go

**Everything is entered in the admin, on the Meta screen (`/meta`, Settings → Meta (Facebook)). Only the owner sees it.** Nothing goes in GitHub, in a wrangler file or anywhere in the repository, except the one encryption key below.

| Value | In the admin | Takes effect |
|---|---|---|
| Pixel ID | "Pixel ID and consent" | Browser: at the next **publish**. Server events: at once |
| Consent | Same form: "Ask visitors" (default) or "Do not ask" | At the next publish. **Turning consent off is a decision for counsel.** With "Do not ask" the privacy section renders its `privacy.meta.off.*` wording, also awaiting legal review. A visitor's stored decline is always respected |
| Access token (Conversions API) | "Access token": write-only, encrypted before it is stored, never shown again (at most its last 4 characters) | At once |
| Test event code | "Test event code" | At once. Only for the Test Events check below. **Remove it afterwards**: while it is stored, every server Purchase is tagged as a test event, and the screen shows a warning |

The Meta screen shows two status lines: whether the browser Pixel is on from the next publish, and whether server events are on now (or why not: no Pixel ID, no token, no encryption key, or a stored token the current key cannot read).

What each part reads, and when:

- **Browser (Pixel, consent choice, CSP additions):** the published build, from the snapshot the admin's Publish exports. Changing or removing the Pixel ID changes the site at the next publish.
- **Server (Purchase events):** hb-web reads the Pixel ID, the token and the test code from the database when it sends, after the order has been answered. It sends only for an order placed from a page that carried that same Pixel ID, and only with the visitor's consent. So **removing the Pixel ID stops server events at once**, and a page built without Meta never causes one.

## The encryption key (once)

The access token is stored encrypted (AES-GCM). The key is a Worker secret, `SETTINGS_ENCRYPTION_KEY`, used by two Workers: **hb-admin** encrypts, **hb-web** decrypts. It is never stored in the database.

1. Generate it once: `openssl rand -base64 32`. Keep it somewhere safe, outside the repository.
2. In GitHub: Settings → Environments → **production** → Secrets → add `SETTINGS_ENCRYPTION_KEY`.
3. Run the **pipeline** workflow in `deploy` mode. The "Deploy Workers" step uploads the key to hb-web and hb-admin with their new versions (`wrangler deploy --secrets-file`, which keeps the Workers' other secrets). The pipeline refuses a malformed key, naming the variable and never the value. Without the GitHub secret, nothing is uploaded and the Workers keep the value Cloudflare already holds.

Until the key is in place, the Meta screen refuses to save a token and says why, and no server event is sent. Everything else works.

**Key rotation is not supported.** Changing the key makes the stored token unreadable: server events stop (nothing breaks, no order is affected) and the Meta screen says the token cannot be read. To recover, enter the token again on the Meta screen.

## Old settings to delete

Earlier builds took these from GitHub and from the Worker. They are no longer read by anything; delete them so nobody thinks they still matter:

- GitHub → Settings → Secrets and variables → Actions → **Variables** (repository level): `META_PIXEL_ID`, `META_CONSENT_REQUIRED`, `META_TEST_EVENT_CODE`.
- GitHub → Settings → Environments → **production** → Secrets: `META_ACCESS_TOKEN`.
- Cloudflare → Workers → **hb-web** → Settings → Variables and Secrets: `META_ACCESS_TOKEN` (a secret, if it was ever set; it survives deploys until deleted). `META_PIXEL_ID` and `META_TEST_EVENT_CODE`, if present, were plain variables and disappear at the next deploy.

## Turning Meta on

Before you start:

1. **Legal text.** The Meta section on the privacy page is marked as awaiting legal review, and shows that mark in production. Have counsel finish it (`privacy.meta.*` in `brand/copy/strings.{ar,fr}.json`) and remove the `[PLACEHOLDER: …]` marker.
2. **The privacy page's own text stays in place. Nothing enforces this step.** The privacy text in production lives in the D1 database, last written by migration `packages/db/migrations/0010_launch_cleanup.sql`. The admin has no screen for it, and turning Meta on does not change it. It says, in both languages, that the site uses no cookie and no analytics or advertising tool, and that the customer's name, phone number and address "servent uniquement à traiter votre commande" ("تُستعمل فقط لمعالجة طلبك"). With Meta on and accepted, both are no longer true. That text stays on the page, below the new Meta section, which says it takes precedence over statements about cookies, trackers and what the data is used for. The older sentences remain until they are replaced, which needs a reviewed migration through the pipeline once counsel's text is final. Turning Meta on does not check for this.
3. Confirm the Graph API version in `apps/web/src/meta/capi.ts` (`GRAPH_VERSION`, `v25.0`) is still supported by Meta.
4. The encryption key is in place (above).

Then:

5. On the admin's Meta screen, enter the Pixel ID (and leave consent on "Ask visitors" unless counsel decided otherwise), then the access token.
6. **Publish** (the admin's Publish, or the **pipeline** workflow in `publish` mode). The static site has to be rebuilt for the Pixel ID to reach it. A full `deploy` also works.
7. Run the checks below.

To turn Meta off: on the Meta screen, **Remove the Pixel ID**, then publish. Server events stop at once; the Pixel, the choice and the CSP additions leave the site at the publish. The stored token can stay or be removed with its own button.

## Checks that need real credentials (not done)

Each of these needs the real Pixel ID and token, so none has been run.

- [ ] **Test Events.** In Events Manager → Test Events, copy the test code and enter it on the admin's Meta screen (it takes effect at once, no publish needed). Accept the choice on the site, place an order in `/ar/` and in `/fr/`. Purchase must appear from both browser and server with the same event ID (the order reference), and count once. Then **remove the test code** on the Meta screen.
- [ ] **Event Match Quality.** In Events Manager → Overview, about 20 minutes after real orders. Aim for 6.0 or better.
- [ ] **Pixel Helper.** With the Chrome extension: `PageView` on each page, `ViewContent` on a product, `AddToCart`, `InitiateCheckout` on the order step and checkout, `Purchase` on the confirmation page with `value` and `currency` DZD.
- [ ] **Content Security Policy.** With the real `fbevents.js`, watch the browser console for CSP violations. The CSP adds `https://connect.facebook.net` (script-src) and `https://www.facebook.com` (img-src, connect-src), which is all that could be checked without Meta's real script. If it needs more, that is a code change in `apps/web/scripts/csp.ts`.
- [ ] **Prerendered product pages.** In ordinary Chrome with no DevTools open, hover a product link without opening it. In Test Events, confirm that no `ViewContent` arrives for that product. Then open it and confirm that exactly one does. (Automated browsers cannot prerender, Chrome reports `PrerenderingDisabledByDevTools`, so this could not be checked here.)
- [ ] **Measure weight.** The with-consent Lighthouse numbers saved under `artifacts/META-0/measure/` exclude the real `fbevents.js`, which could not be downloaded here. Re-measure once it can load.

## Known limits

- An order placed without JavaScript sends nothing to Meta, because that path has no consent.
- A shopper who reaches the order step without any earlier scroll, key press or tap never sees the choice, so that order is not counted.
- Consent reaches the server as the browser's own claim (see D-014).
- Pages published before a Pixel ID change carry the old Pixel ID until the next publish; their orders send no server event in the meantime (the IDs no longer match).
- Key rotation is not supported (above).
- The nightly database backup holds the encrypted token, never the key.
