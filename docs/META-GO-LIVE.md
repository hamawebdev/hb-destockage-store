# Meta Pixel and Conversions API: go-live checklist

**Status: built and merged switched off. Nothing here has been checked against the real Meta.** Everything was tested against a local stand-in, because no Pixel ID or access token exists yet. The Meta checks at the end are **not done**.

Decision record: D-011 in `DECISIONS.md`.

## Where the values go

Set these in the GitHub repository settings. The production pipeline (`.github/workflows/pipeline.yml`) passes them on. Do not put them in `apps/web/wrangler.jsonc` or any file in the repository.

| Setting | Kind | Where | Effect |
|---|---|---|---|
| `META_PIXEL_ID` | Variable | Settings → Secrets and variables → Actions → **Variables**, repository level (the build job has no environment, so an environment variable would not reach it) | Turns the Pixel, the consent choice and the CSP additions on. Unset or empty: everything off |
| `META_ACCESS_TOKEN` | Secret | Settings → Environments → **production** → Secrets | Turns server events on. Also needs `META_PIXEL_ID`. Without it, browser only |
| `META_CONSENT_REQUIRED` | Variable, repository level | Same as the Pixel ID | Unset or `1`: visitors must accept. `0`: no choice is shown, but a stored decline is still respected. Any other value fails the build. **Turning consent off is a decision for counsel.** With `0` the privacy section renders its `privacy.meta.off.*` wording, also awaiting legal review |
| `META_TEST_EVENT_CODE` | Variable, repository level | Same as the Pixel ID | Only for the Test Events check below. Remove it afterwards: while set, every production Purchase is tagged as a test event, and the deploy summary warns about it |

The pipeline refuses a malformed or all-zero Pixel ID and a token starting with `FAKE`. It never prints the values.

## Turning Meta on

Before you start:

1. **Legal text.** The Meta section on the privacy page is marked as awaiting legal review, and shows that mark in production. Have counsel finish it (`privacy.meta.*` in `brand/copy/strings.{ar,fr}.json`) and remove the `[PLACEHOLDER: …]` marker.
2. **The privacy page's older text stays in place. Nothing enforces this step.** The privacy text in production lives in the D1 database. The pipeline does not change it and the admin has no screen for it. It still says the site uses no cookies or third-party trackers, and that text stays on the page, below the new Meta section. The new section says it takes precedence, so the page is accurate, but the older sentence remains until it is replaced. Replacing it needs a reviewed migration through the pipeline, once counsel's text is final. Turning Meta on does not check for this.
3. Confirm the Graph API version in `apps/web/src/meta/capi.ts` (`GRAPH_VERSION`, `v25.0`) is still supported by Meta.

Then:

4. Set `META_PIXEL_ID` and the `META_ACCESS_TOKEN` secret as above.
5. Run the **pipeline** workflow by hand, in `publish` mode. The static site has to be rebuilt for the Pixel ID to reach it, and a publish does that. A full `deploy` also works.
6. Run the checks below.

To turn Meta off, delete `META_PIXEL_ID` and run the pipeline again.

## Checks that need real credentials (not done)

Each of these needs the real Pixel ID and token, so none has been run.

- [ ] **Test Events.** Set `META_TEST_EVENT_CODE` from Events Manager → Test Events and publish. Accept the choice on the site, place an order in `/ar/` and in `/fr/`. Purchase must appear from both browser and server with the same event ID (the order reference), and count once. Then remove `META_TEST_EVENT_CODE` and publish again.
- [ ] **Event Match Quality.** In Events Manager → Overview, about 20 minutes after real orders. Aim for 6.0 or better.
- [ ] **Pixel Helper.** With the Chrome extension: `PageView` on each page, `ViewContent` on a product, `AddToCart`, `InitiateCheckout` on the order step and checkout, `Purchase` on the confirmation page with `value` and `currency` DZD.
- [ ] **Content Security Policy.** With the real `fbevents.js`, watch the browser console for CSP violations. The CSP adds `https://connect.facebook.net` (script-src) and `https://www.facebook.com` (img-src, connect-src), which is all that could be checked without Meta's real script. If it needs more, that is a code change in `apps/web/scripts/csp.ts`.
- [ ] **Prerendered product pages.** In ordinary Chrome with no DevTools open, hover a product link without opening it. In Test Events, confirm that no `ViewContent` arrives for that product. Then open it and confirm that exactly one does. (Automated browsers cannot prerender, Chrome reports `PrerenderingDisabledByDevTools`, so this could not be checked here.)
- [ ] **Measure weight.** The with-consent Lighthouse numbers saved under `artifacts/META-0/measure/` exclude the real `fbevents.js`, which could not be downloaded here. Re-measure once it can load.

## Known limits

- An order placed without JavaScript sends nothing to Meta, because that path has no consent.
- A shopper who reaches the order step without any earlier scroll, key press or tap never sees the choice, so that order is not counted.
- Consent reaches the server as the browser's own claim (see D-011).
