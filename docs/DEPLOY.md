# Deploying Comptoir de Luxe

The whole pipeline is one GitHub Actions workflow, [`.github/workflows/pipeline.yml`](../.github/workflows/pipeline.yml).
The deployment logic is in [`scripts/deploy/`](../scripts/deploy/).

## What runs when

| Trigger | Checks | Deployment |
|---|---|---|
| Pull request to `main` | typecheck, tests, build | none |
| Push to `main` | typecheck, tests, build | full deployment, only if the checks passed for that commit |
| Started by hand (`mode=deploy`) | typecheck, tests, build, on the chosen commit | full deployment of that commit, which must be on `main` |
| Started by hand (`mode=publish`) | typecheck, tests, build | rebuild and redeploy `hb-web` from current production data, no migrations |

The separate `report` workflow (byte budget and Lighthouse, about 45 runner-minutes) runs on pushes to `main` only. It holds no secrets, never blocks anything and takes no time from a deployment.
Production runs one at a time, first come first served, for the whole run (checks, export, build, deploy): `deploy` and `publish` share the concurrency group `production-deploy`, queued in order (`queue: max`, up to 100 pending).

## Which commit deploys

The rule: **production only moves forward, unless someone deliberately goes back.** When a run's turn comes, it compares its commit with the tip of `main`:

| Run | Commit is `main`'s tip | `main` has moved past it |
|---|---|---|
| Push to `main` | deploys | skipped, green, nothing changed: the newer push's run deploys everything, migrations included |
| Started by hand, `mode=deploy` | deploys | refused, red, nothing changed; start it again |
| Started by hand, `mode=deploy`, `older_commit=yes`, and `sha` required | deploys | deploys that older commit on purpose |
| Started by hand, `mode=publish` | publishes | refused, red, nothing changed; start it again |

A commit that is not on `main` is always refused. Going back with `older_commit=yes` is also refused if the database already has migrations that commit doesn't know about, because that code may not work with the newer schema. To do it anyway, use `older_commit=with-newer-migrations`. `publish` never accepts an older commit.

## What a deployment does, in order

**Job `export-catalogue` (holds the token):**
1. Applies the rule above, and checks the Worker configs (real D1 id, routes, `SITE_HOSTS`, Access values). Every problem is listed at once, before anything changes.
2. Records the current version of each Worker, for rollback.
3. Classifies the pending migrations. A destructive set stops the run here (see below).
4. Records a D1 Time Travel bookmark in the job summary: the restore point.
5. Applies the pending migrations once, in order (`wrangler d1 migrations apply --remote`).
6. Exports the catalogue from production D1 and the originals from R2 `hb-media`, passed on as the `catalogue` artifact. An empty or incomplete catalogue stops the run here, before any Worker is deployed.

**Job `build-site` (no environment, no secrets):**
7. Loads the export into a throw-away local database and rebuilds the storefront, passed on as the `site` artifact.

**Job `deploy` (holds the token):**
8. Checks that the built site is plain static files, then deploys `hb-jobs` (queue consumer), `hb-web`, then `hb-admin`, with wrangler's automatic resource creation turned off (`--no-experimental-provision`): a missing bucket or queue fails the deployment instead of being created.
9. Checks each Worker now has a new active version, then runs the smoke checks.

If a deploy or a smoke check fails, or the job is cancelled or times out, a final step puts every Worker deployed in this run back on its recorded version, and the run goes red.

The quote check asks production which wilayas have a confirmed delivery fee (available and not a placeholder), and each must be offered with correct totals. A wilaya with a placeholder fee must be refused. Until the client confirms fees there are none to offer: the check then requires delivery to be refused, and the job summary warns "no confirmed delivery fees: customers cannot order yet". The deployment still passes.

The smoke checks prove the live site works; they can't prove which version answered, because the Workers don't report one. The new-version check covers that in part. Behind Cloudflare Access, the admin check confirms the login wall is up, not that the new admin code runs.

Deployed version ids, the bookmark and any rollback are in the run's job summary.

Publish mode does steps 1, 2, 6 and 7, then deploys `hb-web` only and runs the storefront and order API smoke checks. It refuses to run while migrations are pending: run a full deployment first.

**The pipeline never loads development data and never touches orders or customers.** A redeploy cannot reset the admin's work.

## How to deploy

Merge to `main`. To deploy by hand: **Actions → pipeline → Run workflow**, on branch `main`, `mode=deploy`, and optionally a full commit SHA that is on `main`.

## How to publish

**Actions → pipeline → Run workflow**, on branch `main`, `mode=publish`.

The owner and content editors can also publish themselves: admin → **Publier** → **Publier la boutique**. The page
starts the same `mode=publish` run on `main` through the GitHub API and lists the pipeline's latest runs (D-028). A
second click while a run is still waiting to start sends nothing: that run exports the catalogue when it starts. A
publication takes about 10 minutes (checks, export, build, deploy of `hb-web`).

It needs the Worker secret `GITHUB_PUBLISH_TOKEN` on `hb-admin`: a GitHub **fine-grained** personal access token,
repository access **only** `hamawebdev/hb-destockage-store`, permission **Actions: Read and write** (Metadata: read is
added automatically), nothing else. Set it with `npx wrangler secret put GITHUB_PUBLISH_TOKEN --name hb-admin` and paste
the token at the prompt. Without it the page says publishing is not enabled; nothing else changes. When it expires,
the page says GitHub refuses the key: create a new one the same way. Runs it starts appear in GitHub as started by the
token's owner.

**Approval of other manual runs (D-028).** Because that token can start the workflow with any inputs, a run started by
hand that is not a plain publication (`mode=deploy` or `backoffice`, a `sha`, `older_commit`, or
`approve_destructive_migrations`) now waits in the `approve` job until a repository admin approves it:
**Actions → the run → Review deployments → manual-approval → Approve** (or
`gh api -X POST repos/hamawebdev/hb-destockage-store/actions/runs/<id>/pending_deployments -f "environment_ids[]=<id>" -f state=approved -f comment=ok`).
Pushes to `main` and plain publications do not wait. The approval is valid for that attempt only: to run such a run again, use **Re-run all jobs** (it asks again); re-running a later job alone skips the export, the build and the deploy, and the run still ends **green with nothing deployed**: check the job list.

**One product does not block a publication.** An online product the site cannot show (for example its last general
photo was deleted) is published as a draft and logged as a warning in the run; the admin's Publier page lists it.

## First deployment

1. The first run applies the migrations to the empty database, then stops red because the catalogue is empty. That is expected, and no Worker has been deployed.
2. Load the first catalogue once from the command line, outside the pipeline.
3. Run the workflow again by hand.

## Destructive migrations

Anything that could drop or rewrite existing data halts the run in red: `DROP TABLE`, `DROP COLUMN`, table rebuilds, `RENAME`, `DELETE`, `UPDATE`, `REPLACE`, upserts, and any statement the classifier does not recognise. The run prints the sha256 of the pending set.

To approve: read the migrations, take the client's approval, then start the workflow by hand with `mode=deploy`, the same commit, and `approve_destructive_migrations=<that sha256>`. The approval is valid only for that exact set: if a migration changes, the hash changes. A database with no migrations and no tables (the first deployment) is not halted.

## The rule for migrations: backward compatible

Migrations are applied **before** the new code, while the previous Worker versions are still serving orders, and a Worker rollback does not undo them. So every migration must work with the Worker version already running:

- Add columns and tables; don't rename or remove anything the running code reads or writes.
- A new column must be nullable or have a default.
- To remove something: first deploy code that no longer uses it, then remove it in a later, approved migration.

## Rolling back

Automatic rollback covers failures inside a run. To roll back by hand, take the version id from a job summary (or `wrangler deployments list --name <worker>`):

```sh
./node_modules/.bin/wrangler rollback <version-id> --name hb-web -y --message "reason"
```

Same for `hb-jobs` and `hb-admin`. Roll back in the reverse order: `hb-admin`, `hb-web`, then `hb-jobs`.

**A Worker rollback does not undo a migration.** The database stays as it is. If a migration caused the damage, restore the database (next section). Rolling back `hb-web` also restores that version's static pages, so the site may show an older catalogue until the next publish.

## Restoring the database

The full procedure is in [`apps/jobs/RESTORE.md`](../apps/jobs/RESTORE.md). In short, within the last 30 days, with D1 Time Travel, using the bookmark from the job summary:

```sh
W=./node_modules/.bin/wrangler
$W d1 time-travel info hb-destockage      # note the current bookmark: your undo point
$W d1 time-travel restore hb-destockage --bookmark <bookmark from the job summary>
```

A restore replaces everything written after the target time, **including orders placed meanwhile**. Follow `RESTORE.md` §2 to export the current database first and list those orders for re-entry. Older than 30 days, or the database is lost: use the R2 backup (`RESTORE.md` §3).

## Trust boundaries

The site build runs a large tree of third-party packages (Astro, sharp, the catalogue builder). It must never be able to reach the Cloudflare token, so it runs in a job and on a runner of its own.

| Job | Holds | Runs | Takes in |
|---|---|---|---|
| `export-catalogue` | Cloudflare token (one step) | Our scripts and wrangler. Packages installed with `--ignore-scripts`. | The commit |
| `build-site` | Nothing: no environment, no secrets | The full build, with install scripts | The `catalogue` artifact |
| `deploy` | Cloudflare token (two steps) | Our scripts and wrangler, fresh checkout, packages installed with `--ignore-scripts` | The `site` artifact, as data |

- A compromised build dependency can only affect the `site` artifact. It can change what the site serves, which no pipeline can prevent, but it can't read the token, change the deploy job's code or packages, or change the Worker code, which is bundled in the deploy job from the fresh checkout.
- The deploy job never executes anything from the build. It checks the artifact is plain files (no links, no server code), and `wrangler deploy` then only reads those files. `apps/web`'s `build.command` (`deploy-guard.ts` and `csp.ts`, from the fresh checkout, Node built-ins only) reads them to build the CSP.
- The Worker versions for rollback and the small product sample for the smoke checks (kept under 32 KiB) come from the export job's outputs, never from the build.
- **What the `catalogue` artifact holds:** the export of the 10 catalogue tables, the 7 storefront settings, image originals, and the numeric ids of admins who edited content pages. No orders, customers, admin emails or other settings. The export is checked against the table allowlist and stops if any other table appears. It is kept 1 day. The `site` artifact is the public site, also kept 1 day.
- The artifact digest is verified on download, which detects corruption but doesn't vouch for the build job: the checks above are what count.

## Secrets and access

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist only in the GitHub environment `production` (deployment branch policy: `main`).
- The token is set only on the steps that talk to Cloudflare: *Export from production*, *Deploy Workers* and *Roll back*. The other steps refuse to run if it is present.
- Runtime secrets (`TURNSTILE_SECRET`, `ORDER_SIGNING_KEY`, `IP_HASH_KEY`, `CSRF_SECRET`, …) live in Cloudflare. The pipeline never reads or sets them, with one exception: `SETTINGS_ENCRYPTION_KEY` (the key that encrypts the Meta access token entered in the admin, D-017). If that GitHub `production` secret exists, the *Deploy Workers* step uploads it to hb-web and hb-admin with their new versions; if not, nothing is uploaded. See `docs/META-GO-LIVE.md`.
- The report workflow's measurements cover the test catalogue only.

## Deploying the admin and jobs only (`backoffice`)

Start the pipeline by hand with `mode = backoffice` to deploy **hb-jobs and hb-admin only**, at main's tip (D-025). The checks run as usual. Nothing is exported from production, the site is not built, and hb-web and the storefront stay exactly as they are; the smoke check covers the admin's front door only, and a failure rolls the two Workers back. It refuses to run while migrations are pending (run a full deploy for those). Use it when a change touches only the admin or the jobs and a full deploy is not possible, for example while the production catalogue is empty.

## Switching on delivery and Google Sheets

Both ship switched off. With nothing below set, the admin, the storefront and orders work as before: the delivery pages say keys are needed, and the Sheets page says it is not configured. Nothing here goes in the repo, a log or the browser, and no relay sits between us and the courier or Google.

### Shared key (once)

- `COURIER_KEYS_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). It seals the courier keys, the Google refresh token and the Telegram bot token stored in D1. Set the **same value** as a Cloudflare secret on **`admin` and `jobs`**.
- Never change it while couriers, Sheets or Telegram are connected. A new value can't open what the old one sealed, so the owner would have to enter every courier's keys, reconnect Google and paste the bot token again.
- `ENV` stays `production` on admin, jobs and web: it is the default in each `wrangler.jsonc`. Outside production, courier and Google calls are held to `127.0.0.1` (the stand-ins).
- Never set `COURIER_STANDIN_URL`, `GOOGLE_STANDIN_URL` or `TELEGRAM_STANDIN_URL` in production. `tools/standins/` (the stand-ins and `live-proxy.mjs`) is for a developer's machine only and is never deployed.

### Couriers (owner, in the admin)

1. **Delivery → Settings**, pick the courier, enter its keys:

   | Courier | Keys |
   |---|---|
   | Yalidine (and Guepex) | API ID, API token |
   | EcoTrack (each EcoTrack company) | API token |
   | ZR Express | secret API key, account (tenant) ID |
   | NOEST Express | API token, user GUID |
   | Maystro Delivery | store token |

2. **Test** checks the keys with one call to the courier, and the result is recorded. Set the origin wilaya where the courier asks for it, then **Enable**.
3. **Courier notifications** (Yalidine, EcoTrack, ZR, NOEST):
   - **Generate the notification address** (*Générer l'adresse de notification*) shows the full URL `https://<storefront domain>/api/courier-hook/<courier>/<token>` **once**. Paste it into the courier's dashboard.
   - Copy the courier's **signing secret** into *Secret de signature des notifications*. Without it, notifications are refused and tracking falls back to polling.
   - The address points at the storefront Worker because Cloudflare Access closes `admin.<domain>`.
   - A lost address can't be shown again: *Remplacer l'adresse* makes a new one and voids the old one at once.
   - Maystro's webhooks are unsigned, so Maystro is polled only.
4. Status sync runs in the `jobs` cron every minute (`* * * * *`, already in `apps/jobs/wrangler.jsonc`). It reads the webhook inbox and polls whatever a webhook didn't settle.
   - Only *delivered* and *returned* move an order.
   - A *returned* parcel restocks once.
   - A status we don't know never moves an order and appears under **Delivery → Exceptions**.

### Google Sheets (once in Google Cloud, then a few clicks for the owner)

1. In Google Cloud, make a project, then **enable the Google Sheets API and the Google Drive API**.
2. Fill in the OAuth consent screen. Scope: `https://www.googleapis.com/auth/drive.file` only, so the app sees only the sheet it creates. **Publish it to "In production"**: in "Testing", Google expires the refresh token after 7 days and the sync stops.
3. Create an OAuth client of type **Web application**. Authorised redirect URI: `https://admin.<domain>/sheets/callback`.
4. Set these Cloudflare secrets:

   | Worker | Secrets |
   |---|---|
   | admin | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (exactly the URI above) |
   | jobs | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

   Admin and jobs also both need `COURIER_KEYS_KEY`.
5. Cloudflare Access: keep its cookie's SameSite setting **Lax or None, not Strict**. A Strict cookie is not sent on Google's redirect back, so the callback would land on the Access login.
6. The owner opens the **Google Sheets** page (Administration), clicks **Connect** and signs in with the admin's Google account.
   - A sheet owned by that account is created, and every existing order is exported, oldest first.
   - After that, one row per order is kept up to date (the jobs cron, every minute).
   - The admin stays the source of truth: a hand edit to one of our columns is overwritten at that order's next change.
   - If Google is down, orders still go through, and the rows catch up on their own.
   - **Reconnexion nécessaire** means Google withdrew access (a revoked token, or a consent screen left in Testing): reconnect the same account and the missing rows follow.

### Telegram (owner, in the admin: no secret to set)

There is no Telegram secret on any Worker. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are no longer read: if they are still set on `jobs` from an earlier setup, delete them. The only requirement is `COURIER_KEYS_KEY` on admin and jobs (above).

1. The owner makes a bot with @BotFather and copies its token.
2. In the admin, **Telegram** (Administration): paste the token and save. It is checked with Telegram, sealed in D1 and never shown again in full.
3. He writes a message to the bot, or adds it to a group, then presses **Chercher de nouvelles discussions** and confirms each chat that should receive orders.
4. He ticks the details a message carries, sends a test message, and switches Telegram on.
   - From then on every new order goes to every confirmed chat within seconds (the jobs queue consumer).
   - If Telegram is down, the order still goes through; the jobs cron retries every minute and the message follows once Telegram is back, for up to 72 hours.
   - Orders placed while Telegram was switched off, or before a chat was confirmed, are not sent later.
   - Backup alerts go to the same chats.
   - The settings page shows the last message sent and, in plain words, any problem (token refused, a chat that removed the bot, Telegram unreachable).
