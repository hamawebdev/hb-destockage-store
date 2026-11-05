// Prints a per-table verification report (names, counts, hashes only) and returns ok.
import { verifyRestore } from '../../src/backup/verify.ts';
import type { RestoreManifest } from './dump.ts';

export async function verifyDatabase(db: D1Database, manifest: RestoreManifest): Promise<boolean> {
  const r = await verifyRestore(db, manifest);
  for (const t of manifest.tables) {
    const m = r.mismatches.find((x) => x.table === t.name);
    console.log(`${m ? 'MISMATCH' : 'ok      '} ${t.name} rows=${t.rows}${m ? ` actual=${JSON.stringify(m.actual)}` : ''}`);
  }
  for (const m of r.mismatches.filter((x) => !manifest.tables.some((t) => t.name === x.table))) {
    console.log(`MISMATCH ${m.table} expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}`);
  }
  console.log(
    r.ok
      ? `RESTORE VERIFIED: ${manifest.tables.length} tables, schema ${manifest.schemaVersion} (${manifest.schemaSha256.slice(0, 12)}…)`
      : `RESTORE NOT VERIFIED: ${r.mismatches.length} mismatch(es)`,
  );
  return r.ok;
}
