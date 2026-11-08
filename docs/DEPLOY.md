# Deploying HB Destockage

The whole pipeline is one GitHub Actions workflow, [`.github/workflows/pipeline.yml`](../.github/workflows/pipeline.yml).
The deployment logic is in [`scripts/deploy/`](../scripts/deploy/).

## What runs when

| Trigger | Checks | Deployment |
|---|---|---|
| Pull request to `main` | typecheck, tests, build, report | none |
| Push to `main` | typecheck, tests, build, report | full deployment, only if the checks passed for that commit |
| Started by hand (`mode=deploy`) | same checks, on the chosen commit | full deployment of that commit, which must be on `main` |
| Started by hand (`mode=publish`) | typecheck, tests, build | rebuild and redeploy `hb-web` from current production data, no migrations |

The `report` job (byte budget and Lighthouse) never blocks anything and holds no secrets.
Only one deployment runs at a time: `deploy` and `publish` share the concurrency group `production-deploy`.
A push whose commit is no longer the tip of `main` when its turn comes is skipped, so an older commit never overwrites a newer one.

## What a deployment does, in order

1. Refuses anything not on `main`, and checks the Worker configs (real D1 id, routes, `SITE_HOSTS`, Access values). Every problem is listed at once, before anything changes.
2. Records the current version of each Worker, for rollback.
3. Classifies the pending migrations. A destructive set stops the run here (see below).
4. Records a D1 Time Travel bookmark in the job summary: the restore point.
5. Applies the pending migrations once, in order (`wrangler d1 migrations apply --remote`).
6. Exports only the catalogue tables from production D1 and rebuilds the storefront from them, with the originals from R2 `hb-media`. An empty or incomplete catalogue stops the run here, before any Worker is deployed.
7. Deploys `hb-jobs` (queue consumer), then `hb-web`, then `hb-admin`, with wrangler's automatic resource creation turned off (`--no-experimental-provision`): a missing bucket or queue fails the deployment instead of being created.
8. Runs the smoke checks. If a deploy or a smoke check fails, every Worker deployed in this run goes back to its recorded version and the run goes red.

Deployed version ids, the bookmark and any rollback are in the run's job summary.

Publish mode does steps 1, 2, 6, then deploys `hb-web` only and runs the storefront and order API smoke checks. It refuses to run while migrations are pending: run a full deployment first.

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

## Secrets and access

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist only in the GitHub environment `production` (deployment branch policy: `main`), and are given only to the Deploy step. The build runs without them.
- Runtime secrets (`TURNSTILE_SECRET`, `ORDER_SIGNING_KEY`, `IP_HASH_KEY`, `CSRF_SECRET`, …) live in Cloudflare. The pipeline never reads or sets them.
- Catalogue exports stay on the runner and are deleted at the end of the job. Nothing goes into GitHub artifacts except the report job's measurements of the test catalogue.
