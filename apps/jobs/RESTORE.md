# Restoring the D1 database

Owner: `apps/jobs` (JOBS-1). Audience: whoever operates the client's Cloudflare account.
The local procedure is tested (`apps/jobs/test/backup.d1.test.ts`,
`artifacts/JOBS-1/local-scheduled-e2e.log`). The `--remote` variants run the same wrangler
commands, but this project never logs in to Cloudflare, so they have **not** been exercised here.

## What is backed up

- **When:** daily at 02:00 UTC (03:00 Algiers), by the `hb-jobs` Worker (cron `0 2 * * *`).
  A health check at 09:00 UTC (`0 9 * * *`) alerts when the last good backup is older than 26 h.
- **What:** every table of the `hb-destockage` D1, discovered from `sqlite_master` (D1 and SQLite
  internals excluded), including `d1_migrations` and the AUTOINCREMENT counters.
- **Format:** `d1/YYYY/MM/DD/HHmmssZ/dump.sql.gz` is a gzip SQL dump: `PRAGMA defer_foreign_keys`,
  the tables, the data, the counters, then indexes, views and triggers.
- **Manifest:** `manifest.json` in the same folder, written last. It holds the sha256 of the gzip
  and of the SQL, the rows and digest of every table, the migration version, a schema hash
  (indexes, triggers, constraints), `consistent` and `mode`.
- **Good vs. not good.** A run is **good** when it has a manifest and **no** `INCONSISTENT`
  object. `INCONSISTENT` means rows changed while a large (paginated) export was running. That dump
  **may not load** (a foreign key or unique value that changed between tables): never restore it
  except knowingly, and it counts as a **failed** run everywhere (status, alerts, retention).
- **Health:**
  - `d1/status.json` holds the last good run, the last failure, retention and the health check.
  - The same JSON is mirrored in D1 `settings['jobs.backup_status']` for the admin dashboard, which
    can therefore show "last backup N h ago" even if the jobs Worker stopped running.
  - A run killed mid-way (CPU or memory limit) leaves `d1/in_progress.json`. The next run reports
    it as a failure, stage `killed`.
- **Alerts:** failures, killed runs, inconsistent runs and stale backups go to Telegram or email
  when those are configured (JOBS-2 secrets).
- **Retention:** 35 days. The **7 newest good** runs are always kept, however old, so a stopped
  cron never empties the bucket. Runs without a manifest are deleted after 24 h. Second safety net
  to add in the dashboard: an R2 lifecycle rule on `hb-backups` deleting `d1/` objects after **40**
  days.

## Personal data, access and trust (read before granting anyone access)

- The backups contain **customer personal data**: names, phone numbers and addresses in `orders`
  and `customers`, plus the order history. They are as sensitive as the live database.
- **Where they are stored.** The bucket `hb-backups` is stored **in the EU**, like D1 (Cloudflare
  R2; D1 has no Africa location). Report §6: Algeria's personal-data law (**Law 18-07, as amended
  by Law 25-11**) requires authorisation for transfers abroad unless a consent or
  contract-performance exception applies, a declaration to the ANPDP, a data protection officer,
  and a log of operations. The backups are part of that processing and transfer, and **the
  client's declaration must cover them**.
- **The bucket stays private.** No `r2.dev` URL, no custom domain, no public access. It is used
  only for backups and never shared with the media bucket.
- **Who may access it.**
  - Only the `hb-jobs` Worker writes to it (creates and deletes backups).
  - People get **read-only** access, always: an R2 API token scoped to `hb-backups` with Object
    Read. Restoring never needs write access to the bucket.
  - Only the account owner and named operators who also hold the `owner` admin role. Never
    `confirmer`, `logistics` or `content` staff.
  - Record each grant and revocation in the log the ANPDP declaration relies on.
- **Trust boundary.** The manifest that vouches for a dump sits in the same bucket. Anyone who can
  *write* `hb-backups` could replace both, or delete every run. Hence: write access for the Worker
  only, read-only tokens for people, and consider an **R2 bucket lock** on the `d1/` prefix for
  30 days (retention deletes only after 35 days, so the lock and retention do not conflict).
- **Downloaded copies are personal data on a computer.** `scripts/restore.ts` keeps them in a fresh
  owner-only (0700) folder under the system temp directory, **refuses any folder inside a git
  repository**, and deletes it when it finishes (unless `--keep`, which prints the path to delete).
  Never download backups by hand into the project folder, never attach them to email or chat.
- The job's logs contain stage, table names, counts, sizes and durations, **never row values**
  (tested).

## 1. Choose the method

| Damage is… | Use |
|---|---|
| within the last **30 days** (bad migration, mass delete, wrong bulk edit) | **D1 Time Travel**: point-in-time, to the minute, no download. Go to §2. |
| older than 30 days, or the database itself is lost | **R2 backup** into a new database. Go to §3. |

## 2. Time Travel (last 30 days)

This restores the **live database in place**. Everything written after the target time is
replaced, including orders that customers placed meanwhile. Do every step, from the **project
root**, with the project's pinned wrangler (`./node_modules/.bin/wrangler`, not a global `npx
wrangler`).

```sh
cd <project root>                                   # e.g. the checkout used to deploy
W=./node_modules/.bin/wrangler
P="$(mktemp -d)" && chmod 700 "$P"                  # private folder OUTSIDE the project; holds customer data

# 1. Undo point: write down the bookmark of the database as it is NOW.
$W d1 time-travel info hb-destockage --remote                     # → bookmark <NOW_BOOKMARK>

# 2. Save what the restore would erase: a full copy of the current database.
$W d1 export hb-destockage --remote --output "$P/pre-restore.sql"

# 3. Restore to the target time (wrangler also prints the previous bookmark: keep it with step 1's).
$W d1 time-travel restore hb-destockage --remote --timestamp 2026-11-04T08:00:00Z

# 4. List the orders placed after the target time, complete (customer, wilaya, commune, address,
#    items, totals), from the copy of step 2. The script loads the copy into a throw-away local
#    database inside its own private folder (it ships its own wrangler config) and deletes it.
node apps/jobs/scripts/restore.ts --orders-since 2026-11-04T08:00:00Z --from-sql "$P/pre-restore.sql" > "$P/orders-to-reenter.txt"

# 5. Undo, only if the restore was wrong:
#    $W d1 time-travel restore hb-destockage --remote --bookmark <NOW_BOOKMARK>

# 6. When every listed order is re-entered:
rm -rf "$P"
```

Staff re-enter each order listed in `orders-to-reenter.txt` in the admin, or call the customer
back. The file holds personal data: print it, don't email it.
The `bookmark` in each backup manifest is the D1 bookmark at the time of that backup.
Rehearsed end to end on a local database: `artifacts/JOBS-1/runbook-s2-transcript.txt`. The
`--remote` lines are the same commands against Cloudflare; they were not run, because this project
never logs in.

## 3. Restore from an R2 backup into a new database

Never restore over the live database: restore into a new one, verify, then switch.

From the **project root**, with the pinned wrangler:

```sh
W=./node_modules/.bin/wrangler
# 1. a fresh, empty database (same location hint as production)
$W d1 create hb-restore-20261104 --location weur                      # note the database_id

# 2. download → check → load → verify, in one guarded command
node apps/jobs/scripts/restore.ts --run d1/2026/11/04/020000Z \
     --source-remote --remote --target hb-restore-20261104 --target-id <database_id>
#    (--run latest takes the newest good run; list runs with:
#     $W r2 object list hb-backups --prefix d1/ --remote)
```

The script:

1. Works in a private temp folder and deletes it at the end.
2. Refuses runs marked `INCONSISTENT`.
3. Checks the gzip and SQL sha256 against the manifest **before** loading, then loads exactly those
   verified bytes.
4. Verifies every table (rows and digest), the migration version and the schema hash.

`RESTORE VERIFIED` with exit code 0 means the new database matches the backup exactly. Anything
else: stop and keep the old database.

Then, **by the client** (deploying is outside this project):

5. Put the new `database_id` in the `DB` binding of `apps/web`, `apps/admin` and `apps/jobs`
   (`wrangler.jsonc`) and deploy the three Workers.
6. `$W d1 migrations list hb-restore-20261104 --remote` must show nothing pending from
   the dump's version. Apply newer migrations if the code has moved on.
7. Orders placed between the backup and the switch exist only in the old database (if it still
   exists) or in the staff notifications. If the old database still answers, take
   `$W d1 export hb-destockage --remote --output "$P/old.sql"` into a private folder, then
   `node apps/jobs/scripts/restore.ts --orders-since <backup time> --from-sql "$P/old.sql"` lists
   them complete, as in §2 step 4.
8. Clean up:
   - delete restore databases you are not switching to (`$W d1 delete <name>`);
   - if a restore was interrupted hard (power loss, `kill -9`; Ctrl-C is handled), remove its
     private folder: `rm -rf "${TMPDIR:-/tmp}"/hb-restore-*` while no restore is running;
   - delete any folder kept with `--keep`;
   - delete the scratch databases and folders from §2.

### Rehearsal (local, no account needed)

```sh
node apps/jobs/scripts/restore.ts --run latest --target hb-restore-rehearsal
# backups read from the local jobs state (.wrangler/hb-local); the restored database lives in the
# temp folder and is deleted with it. Use --keep to inspect it (path printed; delete it afterwards).
```

To check a dump without loading it:
`npm run restore:verify -w @hb/jobs -- --manifest <file> --dump <dump.sql.gz> --dump-only`. Both
files must be outside the project; the tool refuses paths inside a git worktree.

## Limits (measured or by design)

- **Consistency:** below 16 MB the whole database is read in **one D1 batch** (one transaction, an
  exact snapshot). Above that the job pages through each table and compares a watermark of the
  rows that existed at the start (count, sum of rowids, sum of `updated_at`). New rows don't
  matter, but changed or deleted ones do. It retries 3 times, then stores the run as
  `INCONSISTENT` (failed) and alerts. Not detected: an in-place update of a table without
  `updated_at` (`notification_deliveries`, `publish_runs`, `rum_daily`; operational only).
- **Integers above 2^53** cannot be read exactly through D1. If one ever appears, the backup **fails
  loudly** (`PrecisionError`) rather than store a rounded value.
- **Rows larger than about 90 KB of SQL** cannot be written as one D1 statement. The backup fails,
  naming the table (`OversizedRowError`), and **keeps failing every night** until that row
  shrinks. In `audit_log` (append-only triggers, DB-2) it can never shrink, so treat the first
  such alert as urgent: contact the developer. The planned fix is to split large values into
  INSERT + `UPDATE … SET c = c || …` before the triggers are replayed. Today the largest rows (content
  pages) are about 5.6 KB.
- **Memory:** only the gzip output is held, about 10% of the raw SQL. Past about 300 MB of raw
  data, switch to the D1 REST export API (needs an API token in a Worker secret) or to R2
  multipart uploads.
