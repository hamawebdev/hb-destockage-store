// Backup fixtures on top of DB-1: personal data markers, a self-referencing FK inserted
// child-before-parent, awkward text, plus a table created after the migrations (proves nothing is
// hard-coded) with BLOB/REAL/NUL/untyped values, an AUTOINCREMENT gap and triggers that would
// block loading if replayed before the data.
import { applyMigrations, insertOrders } from './schema.ts';

export const PII = { name: 'Amina Benali', phone: '+213560417403', note: 'Rue des Oliviers 12, Bab Ezzouar' };

export async function seedBackupFixtures(db: D1Database): Promise<void> {
  await applyMigrations(db);
  await insertOrders(db, [1, 2]);
  await db.batch([
    db.prepare(`UPDATE customers SET name = ?1, notes = ?2 WHERE id = 1`).bind(PII.name, PII.note),
    db.prepare(`UPDATE orders SET name = ?1, address = ?2 WHERE id = 1`).bind(PII.name, PII.note),
    // child (id 1) references parent (id 2), which is inserted later in rowid order
    db.prepare(`INSERT INTO categories (id, parent_id, slug_fr, slug_ar, name_fr, name_ar) VALUES (2, NULL, 'cuisine', 'matbakh', 'Cuisine', 'مطبخ')`),
    db.prepare(`INSERT INTO categories (id, parent_id, slug_fr, slug_ar, name_fr, name_ar) VALUES (1, 2, 'casseroles', 'qudur', 'Casseroles', 'قدور')`),
    db.prepare(`INSERT INTO settings (key, value) VALUES ('shop', ?1)`).bind(JSON.stringify({ note: "l'été; -- pas de DROP\nligne 2", ar: 'متجر' })),
    db.prepare(`INSERT INTO order_events (order_id, type, actor_type) VALUES (1, 'created', 'customer')`),
    db.prepare(`INSERT INTO audit_log (actor_type, action, entity, after) VALUES ('system', 'order.create', 'order', '{"ref":"HB-T0001"}')`),
    db.prepare(`CREATE TABLE zz_edge (id INTEGER PRIMARY KEY AUTOINCREMENT, b BLOB, r REAL, t TEXT, u)`),
    db.prepare(`INSERT INTO zz_edge (b, r, t, u) VALUES (X'0001FF', 0.1, 'a' || char(0) || 'b', 3.5)`),
    db.prepare(`INSERT INTO zz_edge (b, r, t, u) VALUES (NULL, 1e300, 'سطر' || char(10) || 'ثاني', 'txt')`),
    db.prepare(`INSERT INTO zz_edge (b, r, t, u) VALUES (X'', -0.5, '', 7)`),
    db.prepare(`DELETE FROM zz_edge WHERE id = 3`), // sqlite_sequence stays at 3
    db.prepare(`CREATE INDEX zz_edge_t_idx ON zz_edge (t)`),
    db.prepare(`CREATE TRIGGER zz_edge_no_update BEFORE UPDATE ON zz_edge BEGIN SELECT RAISE(ABORT, 'append-only'); END`),
    db.prepare(`CREATE TABLE zz_frozen (id INTEGER PRIMARY KEY, v TEXT)`),
    db.prepare(`INSERT INTO zz_frozen VALUES (1, 'kept')`),
    db.prepare(`CREATE TRIGGER zz_frozen_no_insert BEFORE INSERT ON zz_frozen BEGIN SELECT RAISE(ABORT, 'frozen'); END`),
  ]);
}
