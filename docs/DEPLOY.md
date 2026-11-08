# Deploying HB Destockage

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

The quote check uses wilayas that production has a confirmed delivery fee for (available and not a placeholder), and each must be offered. Until the client confirms fees, there are none: the check then requires that delivery is **not** offered, and the job summary warns "no confirmed delivery fees: customers cannot order yet". The deployment still passes.

The smoke checks prove the live site works; they can't prove which version answered, because the Workers don't report one. The new-version check covers that in part. Behind Cloudflare Access, the admin check confirms the login wall is up, not that the new admin code runs.

Deployed version ids, the bookmark and any rollback are in the run's job summary.

Publish mode does steps 1, 2, 6 and 7, then deploys `hb-web` only and runs the storefront and order API smoke checks. It refuses to run while migrations are pending: run a full deployment first.

**The pipeline never loads development data and never touches orders or customers.** A redeploy cannot reset the admin's work.

## How to deploy

Merge to `main`. To deploy by hand: **Actions → pipeline → Run workflow**, on branch `main`, `mode=deploy`, and optionally a full commit SHA that is on `main`.

## How to publish

**Actions → pipeline → Run workflow**, on branch `main`, `mode=publish`.

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
- Runtime secrets (`TURNSTILE_SECRET`, `ORDER_SIGNING_KEY`, `IP_HASH_KEY`, `CSRF_SECRET`, …) live in Cloudflare. The pipeline never reads or sets them.
- The report workflow's measurements cover the test catalogue only.
