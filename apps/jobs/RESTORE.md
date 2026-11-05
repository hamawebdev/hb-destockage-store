# Restoring the D1 database from a backup

Owner: `apps/jobs` (JOBS-1). Audience: whoever operates the client's Cloudflare account.
Nothing here was run against a real Cloudflare account in this project: the local procedure is tested
(`apps/jobs/test/backup.d1.test.ts`). The remote commands are the same wrangler commands with
`--remote`.

## What is backed up

- **When:** daily at 02:00 UTC (03:00 Algiers), by the `hb-jobs` Worker (cron `0 2 * * *`).
- **What:** every table of the `hb-destockage` D1, discovered from `sqlite_master` (D1 and SQLite
  internals excluded). This includes `d1_migrations` and the AUTOINCREMENT counters.
- **Format:** `d1/YYYY/MM/DD/HHmmssZ/dump.sql.gz` is a gzip SQL dump: `PRAGMA defer_foreign_keys`,
  the tables, the data, the counters, then indexes and triggers.
- **Manifest:** `d1/YYYY/MM/DD/HHmmssZ/manifest.json`, written last, so a run without a manifest is
  incomplete. It holds the sha256 of the gzip and the raw SQL, the row count and digest of every
  table, the migration version, `consistent` and `mode`.
- **Status:** `d1/status.json` records the last success and the last failure. A failure also sends a
  Telegram or email alert when those are configured.
- **Retention:** 35 days, and the 7 newest complete backups are **always** kept, so a stopped cron
  never empties the bucket. Incomplete runs are deleted after 24 h. Second safety net to add in the
  dashboard: an R2 lifecycle rule on `hb-backups` deleting `d1/` objects after **40** days.

## Personal data and access (read before granting anyone access)

- The backups contain **customer personal data**: names, phone numbers and addresses in `orders` and
  `customers`, plus the order history. They are as sensitive as the live database.
- The bucket `hb-backups`, like D1, is stored **in the EU** (Cloudflare R2; D1 has no Africa
  location). Report §6: Algeria's personal-data law (**Law 18-07, as amended by Law 25-11**) requires
  authorisation for transfers abroad unless a consent or contract-performance exception applies, a
  declaration to the ANPDP, a data protection officer, and a log of operations. The backups are part
  of that same processing and transfer, and **the client's declaration must cover them**.
- **The bucket stays private:** no `r2.dev` public URL, no custom domain, no public access. It is
  used only for backups and is never shared with the media/images bucket.
- **Who may access it:** only the client's account owner, and named operators who also hold the
  `owner` admin role. Give them an account role scoped to R2 (or an R2 API token scoped to
  `hb-backups` only, read-only unless they restore). Never give it to `confirmer`, `logistics` or
  `content` staff. Record each grant and revocation in the same log the ANPDP declaration relies on.
- **Downloaded copies** (steps below) are personal data on a laptop: work in an encrypted folder,
  delete the files when the restore is verified, and never attach them to email or chat.
- The job's logs contain stage, table names, counts, sizes and durations, and **never row values**
  (tested).

## 1. Choose the method

| Damage is… | Use |
|---|---|
| within the last **30 days** (bad migration, mass delete, wrong bulk edit) | **D1 Time Travel**: point-in-time, to the minute, no download. Go to §2. |
| older than 30 days, or the database itself is lost | **R2 backup**. Go to §3. |

## 2. Time Travel (last 30 days)

```sh
npx wrangler d1 time-travel info hb-destockage --timestamp 2026-11-04T08:00:00Z   # find the bookmark
npx wrangler d1 time-travel restore hb-destockage --timestamp 2026-11-04T08:00:00Z
```

This restores **in place** (everything after that point is lost). The `bookmark` in a backup's
manifest is the D1 bookmark at the moment of that backup.

## 3. Restore from an R2 backup into a new database

Never restore over the live database. Restore into a new one, verify, then switch.

```sh
cd apps/jobs
RUN=d1/2026/11/04/020000Z                       # pick the run: npx wrangler r2 object list hb-backups --prefix d1/ --remote
npx wrangler r2 object get hb-backups/$RUN/manifest.json --file manifest.json --remote
npx wrangler r2 object get hb-backups/$RUN/dump.sql.gz   --file dump.sql.gz   --remote

# 1. integrity: both sha256 must match the manifest (also checked by step 4)
sha256sum dump.sql.gz && grep '"sha256"' manifest.json
gunzip -k dump.sql.gz                            # → dump.sql

# 2. a fresh, empty database (same location hint as production)
npx wrangler d1 create hb-restore-20261104 --location weur

# 3. load it (one command; the dump defers foreign keys and recreates triggers last)
npx wrangler d1 execute hb-restore-20261104 --remote --file dump.sql --yes

# 4. verify: every table, row count, digest and the migration version
npm run restore:verify -w @hb/jobs -- --manifest manifest.json --dump dump.sql.gz \
  --remote --database hb-restore-20261104 --database-id <id printed by step 2>
```

`RESTORE VERIFIED: <n> tables, schema <migration>` and exit code 0 mean the new database matches the
backup exactly. Anything else: stop and keep the old database.

Then, **by the client** (deploying is outside this project):

5. Put the new `database_id` in the `DB` binding of `apps/web`, `apps/admin` and `apps/jobs`
   (`wrangler.jsonc`) and deploy the three Workers.
6. `npx wrangler d1 migrations list hb-restore-20261104 --remote` must show nothing pending from
   the dump's version. Apply newer migrations if the code has moved on.
7. Orders placed between the backup and the switch exist only in the old database (if it still
   exists). Re-enter them from the old database or from the staff notifications.
8. Delete `manifest.json`, `dump.sql.gz` and `dump.sql` from the laptop.

### Rehearsal (local, no account needed)

```sh
npx wrangler d1 execute hb-restore --local --file dump.sql --persist-to /tmp/hb-restore --yes
npm run restore:verify -w @hb/jobs -- --manifest manifest.json --dump dump.sql.gz --persist-to /tmp/hb-restore
```

## Limits (measured or by design)

- **Consistency:** below 16 MB the whole database is read in **one D1 batch** (one transaction, exact
  snapshot). Above that the job pages through each table and re-checks a watermark (per-table count,
  max rowid and max `updated_at`), retrying up to 3 times. If writes never stop, the backup is kept
  with `"consistent": false` and an alert is sent.
- **Integers above 2^53** cannot be read exactly through D1. If one ever appears, the backup **fails
  loudly** (`PrecisionError`) rather than store a rounded value.
- A single row larger than about 90 KB of SQL cannot be written as one D1 statement, so the backup
  fails and names the table (`OversizedRowError`).
- Memory: only the gzip output is held, about 10% of the raw SQL. Past about 300 MB of raw data,
  switch to the D1 REST export API (which needs an API token in a Worker secret) or to R2 multipart
  uploads.
