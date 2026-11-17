// REBR-6: migration 0013 renames the store in production data (settings.storeName, content pages),
// only where the old name is still there, and is idempotent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { MIGRATIONS_DIR, migrationFiles } from './helpers.ts';

const FILE = '0013_rename_comptoir_de_luxe.sql';
const OLD = /hb ?d[eé]stockage|hbdestockage|إتش ?بي|اتش ?بي/i;
const statements = (file: string) =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

/** A database at the migration before 0013, holding what production holds. */
function before(storeName: { fr: string; ar: string }) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const f of migrationFiles()) {
    if (f >= FILE) break;
    for (const s of statements(f)) db.exec(s);
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('storeName', JSON.stringify(storeName));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('contactPhone', JSON.stringify('0560417403'));
  const page = db.prepare(
    'INSERT INTO content_pages (key, slug_fr, slug_ar, title_fr, title_ar, summary_fr, summary_ar, body_fr, body_ar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  page.run('about', 'a-propos', 'man-nahnu', 'À propos de HB Destockage', 'من نحن', 'HB Destockage, boutique en ligne algérienne.', 'HB Destockage متجر جزائري عبر الإنترنت.',
    JSON.stringify([{ type: 'p', text: 'HB Destockage est une boutique en ligne algérienne.' }]), JSON.stringify([{ type: 'p', text: 'HB Destockage متجر جزائري عبر الإنترنت.' }]));
  page.run('delivery', 'livraison', 'at-tawsil', 'Livraison', 'التوصيل', 'Livraison dans les 69 wilayas.', 'التوصيل إلى 69 ولاية.', '[]', '[]');
  return db;
}
const apply = (db: Database.Database) => { for (const s of statements(FILE)) db.exec(s); };
const storeName = (db: Database.Database) => JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'storeName'").get() as { value: string }).value) as unknown;

/** Every text cell of every table that still holds the old name. */
function leftovers(db: Database.Database): string[] {
  const out: string[] = [];
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) {
    for (const row of db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) {
      for (const [c, v] of Object.entries(row)) if (typeof v === 'string' && OLD.test(v)) out.push(`${t}.${c}: ${v}`);
    }
  }
  return out;
}

describe('0013 rename to Comptoir de Luxe', () => {
  test('is in the migration list and holds only UPDATE statements', () => {
    expect(migrationFiles()).toContain(FILE);
    for (const s of statements(FILE)) expect(s.replace(/^--.*$/gm, '').trim()).toMatch(/^UPDATE /);
  });

  test.each([
    ['the seeded Latin name in both languages', { fr: 'HB Destockage', ar: 'HB Destockage' }],
    ['the Arabic transliteration', { fr: 'HB Destockage', ar: 'إتش بي ديستوكاج' }],
  ])('renames %s and the content pages; no old name is left anywhere', (_n, name) => {
    const db = before(name);
    expect(leftovers(db).length).toBeGreaterThan(0);
    apply(db);
    expect(storeName(db)).toEqual({ fr: 'Comptoir de Luxe', ar: 'كونتوار دو لوكس' });
    const about = db.prepare("SELECT * FROM content_pages WHERE key = 'about'").get() as Record<string, string>;
    expect(about['title_fr']).toBe('À propos de Comptoir de Luxe');
    expect(about['summary_fr']).toBe('Comptoir de Luxe, boutique en ligne algérienne.');
    expect(about['summary_ar']).toBe('كونتوار دو لوكس متجر جزائري عبر الإنترنت.');
    expect(JSON.parse(about['body_fr']!)).toEqual([{ type: 'p', text: 'Comptoir de Luxe est une boutique en ligne algérienne.' }]);
    expect(JSON.parse(about['body_ar']!)).toEqual([{ type: 'p', text: 'كونتوار دو لوكس متجر جزائري عبر الإنترنت.' }]);
    expect(leftovers(db)).toEqual([]);
  });

  test('is idempotent and touches nothing else', () => {
    const db = before({ fr: 'HB Destockage', ar: 'HB Destockage' });
    apply(db);
    const dump = () => JSON.stringify([db.prepare('SELECT * FROM settings ORDER BY key').all(), db.prepare('SELECT * FROM content_pages ORDER BY id').all()]);
    const once = dump();
    apply(db);
    expect(dump()).toBe(once);
    const delivery = db.prepare("SELECT summary_fr, updated_at, created_at FROM content_pages WHERE key = 'delivery'").get() as Record<string, unknown>;
    expect(delivery['summary_fr']).toBe('Livraison dans les 69 wilayas.');
    expect(delivery['updated_at']).toBe(delivery['created_at']);
    expect(JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'contactPhone'").get() as { value: string }).value)).toBe('0560417403');
  });

  test('leaves a name the owner already changed, per language', () => {
    const db = before({ fr: 'Ma Boutique', ar: 'HB Destockage' });
    apply(db);
    expect(storeName(db)).toEqual({ fr: 'Ma Boutique', ar: 'كونتوار دو لوكس' });
    const kept = before({ fr: 'Ma Boutique', ar: 'متجري' });
    const row = () => kept.prepare("SELECT value, updated_at FROM settings WHERE key = 'storeName'").get();
    const was = row();
    apply(kept);
    expect(row()).toEqual(was);
  });

  test('a storeName without an "ar" key gets none; other spellings in pages are left and not re-stamped', () => {
    const db = before({ fr: 'HB Destockage' } as unknown as { fr: string; ar: string });
    db.prepare("UPDATE content_pages SET summary_fr = 'HB DESTOCKAGE en majuscules' WHERE key = 'delivery'").run();
    apply(db);
    expect(storeName(db)).toEqual({ fr: 'Comptoir de Luxe' });
    const delivery = db.prepare("SELECT summary_fr, updated_at, created_at FROM content_pages WHERE key = 'delivery'").get() as Record<string, unknown>;
    expect(delivery['summary_fr']).toBe('HB DESTOCKAGE en majuscules');
    expect(delivery['updated_at']).toBe(delivery['created_at']);
  });

  test('a no-op on an empty database', () => {
    const db = new Database(':memory:');
    for (const f of migrationFiles()) for (const s of statements(f)) db.exec(s);
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 });
  });
});
