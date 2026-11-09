import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { foldName, matchCommune } from '../src/commune.ts';
import { courierBase, isValidTracking, redact, safeLabelUrl } from '../src/client.ts';
import { eventKey, parseCourierDate } from '../src/event.ts';
import { toWilaya58 } from '../src/wilaya.ts';
import type { CourierCommune } from '../src/types.ts';

describe('toWilaya58', () => {
  // Written out separately from the code; derived from pre-reform commune codes (rev-h, CARR-0 r1).
  const PARENTS: Array<[number, number]> = [
    [59, 3],
    [60, 5],
    [61, 7],
    [62, 12],
    [63, 13],
    [64, 14],
    [65, 17],
    [66, 17],
    [67, 26],
    [68, 28],
    [69, 32],
  ];

  it.each(PARENTS)('maps %i to its parent %i', (code, parent) => {
    expect(toWilaya58(code)).toEqual({ ok: true, code: parent });
  });

  it('keeps 1..58 as they are', () => {
    for (let code = 1; code <= 58; code += 1) expect(toWilaya58(code)).toEqual({ ok: true, code });
  });

  it.each([0, 70, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (code) => {
    expect(toWilaya58(code)).toMatchObject({ ok: false, code: 'wilaya_unmapped' });
  });
});

const commune = (name: string, deliverable = true): CourierCommune => ({
  name,
  wilayaCode: 16,
  hasStopDesk: false,
  deliverable,
});

describe('matchCommune', () => {
  const input = (nameFr: string, nameAr = 'لا شيء') => ({ nameFr, nameAr });

  it.each([
    ['Aïn Bénian', 'Ain Benian'],
    ['El-Harrach', 'El Harrach'],
    ["Sidi M'Hamed", 'Sidi MHamed'],
    ['bab  EZZOUAR', 'Bab Ezzouar'],
  ])('folds %s to match %s', (ours, theirs) => {
    expect(matchCommune(input(ours), [commune(theirs)])).toMatchObject({ ok: true, commune: { name: theirs } });
  });

  it('never matches by similarity', () => {
    expect(matchCommune(input('Bab Ezzouar'), [commune('Bab El Oued')])).toMatchObject({
      ok: false,
      code: 'commune_unmapped',
    });
    expect(matchCommune(input('Alger'), [commune('Alger Centre')])).toMatchObject({
      ok: false,
      code: 'commune_unmapped',
    });
  });

  it('two entries folding alike match nothing', () => {
    expect(matchCommune(input('El Biar'), [commune('El Biar'), commune('El-Biar')])).toMatchObject({
      ok: false,
      code: 'commune_unmapped',
    });
  });

  it('reports a commune the courier does not serve', () => {
    expect(matchCommune(input('Hydra'), [commune('Hydra', false)])).toMatchObject({
      ok: false,
      code: 'commune_not_deliverable',
    });
  });

  it("uses a person's pick over our spelling", () => {
    const picked = { nameFr: 'Inconnue', nameAr: 'x', courierName: 'Hydra' };
    expect(matchCommune(picked, [commune('Hydra')])).toMatchObject({ ok: true, commune: { name: 'Hydra' } });
  });

  it('falls back to the Arabic name', () => {
    expect(matchCommune({ nameFr: 'Autre', nameAr: 'حيدرة' }, [commune('حيدرة')])).toMatchObject({ ok: true });
  });

  it('an empty name matches nothing', () => {
    expect(foldName(" -' ")).toBe('');
    expect(matchCommune(input(''), [commune('')])).toMatchObject({ ok: false, code: 'commune_unmapped' });
  });
});

describe('parseCourierDate', () => {
  it('reads a naive date as Algeria time', () => {
    expect(parseCourierDate('2025-12-30 13:24:34')).toBe(1767097474000);
  });

  it('gives the same instant from ISO forms', () => {
    expect(parseCourierDate('2025-12-30T12:24:34Z')).toBe(1767097474000);
    expect(parseCourierDate('2025-12-30T13:24:34+01:00')).toBe(1767097474000);
    expect(parseCourierDate('2025-12-30T12:24:34.000Z')).toBe(1767097474000);
  });

  it('does not depend on the host time zone', () => {
    const before = process.env['TZ'];
    try {
      for (const tz of ['UTC', 'Africa/Algiers', 'Pacific/Auckland', 'America/New_York']) {
        process.env['TZ'] = tz;
        expect(parseCourierDate('2025-12-30 13:24:34')).toBe(1767097474000);
      }
    } finally {
      if (before === undefined) delete process.env['TZ'];
      else process.env['TZ'] = before;
    }
  });

  it.each(['', 'soon', '2025-02-31 10:00:00', '2025-13-01 10:00:00', '2025-12-30 25:00:00', null, 5, undefined])(
    'gives null for %j',
    (value) => {
      expect(parseCourierDate(value)).toBeNull();
    },
  );
});

describe('eventKey', () => {
  it('uses the time when there is one', () => {
    expect(eventKey('t1', 'Livré', { occurredAt: 5 })).toBe('t1|Livré|5');
  });

  it('builds from the normalised status', () => {
    expect(eventKey('t1', 'Livré ', { occurredAt: 5 })).toBe(eventKey('t1', 'Livré'.normalize('NFD'), { occurredAt: 5 }));
  });

  it('falls back to the event id, then none', () => {
    expect(eventKey('t1', 'Livré', { occurredAt: null, eventId: 'e9' })).toBe('t1|Livré|ev:e9');
    expect(eventKey('t1', 'Livré', { occurredAt: null })).toBe('t1|Livré|none');
    expect(eventKey('t1', 'Livré', { occurredAt: 5, eventId: 'e9' })).toBe('t1|Livré|5');
  });
});

describe('isValidTracking', () => {
  it.each(['yal-000TST', 'ECQFLD2103047673', 'a_b-c'])('accepts %s', (value) => {
    expect(isValidTracking(value)).toBe(true);
  });

  it.each(['a,b', '../x', 'x?y=1', '', 'a b', 'x'.repeat(65), 5, null])('refuses %j', (value) => {
    expect(isValidTracking(value)).toBe(false);
  });
});

describe('courierBase', () => {
  const prod = 'https://api.yalidine.app';

  it('uses the stand-in outside production', () => {
    expect(courierBase(prod, 'yalidine', { env: 'test', standinUrl: 'http://127.0.0.1:9/' })).toBe(
      'http://127.0.0.1:9/yalidine',
    );
  });

  it('ignores the stand-in in production', () => {
    expect(courierBase(prod, 'yalidine', { env: 'production', standinUrl: 'http://127.0.0.1:9' })).toBe(prod);
  });

  it('resolves to the real host without a stand-in, for the guard to refuse', () => {
    expect(courierBase(prod, 'yalidine', { env: 'test' })).toBe(prod);
  });
});

describe('redact', () => {
  it('removes credential values and URLs and caps the length', () => {
    const out = redact(`bad SECRET at https://x.test/?t=SECRET ${'y'.repeat(400)}`, { apiToken: 'SECRET' });
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('x.test');
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it('gives nothing for a non-string', () => {
    expect(redact({ a: 1 }, {})).toBe('');
  });
});

describe('safeLabelUrl', () => {
  const hosts = ['yalidine.app'];
  const prod = { env: 'production' };

  it('keeps https on the list', () => {
    const url = 'https://yalidine.app/app/bordereau.php?tracking=t';
    expect(safeLabelUrl(url, hosts, prod)).toBe(url);
  });

  it.each([
    'javascript:alert(1)',
    'http://yalidine.app/x',
    'https://evil.test/x',
    'https://yalidine.app.evil.test/x',
    'not a url',
    null,
  ])('drops %j', (url) => {
    expect(safeLabelUrl(url, hosts, prod)).toBeUndefined();
  });

  it("allows the stand-in's own origin only outside production", () => {
    const url = 'http://127.0.0.1:9/yalidine/label/t';
    expect(safeLabelUrl(url, hosts, { env: 'test', standinUrl: 'http://127.0.0.1:9' })).toBe(url);
    expect(safeLabelUrl(url, hosts, { env: 'production', standinUrl: 'http://127.0.0.1:9' })).toBeUndefined();
  });
});

describe('static rules', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it('only http.ts calls fetch', () => {
    const callers = files(src).filter((path) => /(^|[^\w.])fetch\(|\.fetch\(/.test(readFileSync(path, 'utf8')));
    expect(callers.map((path) => path.slice(src.length))).toEqual([]);
  });

  it('no Node API is imported', () => {
    for (const path of files(src)) expect(readFileSync(path, 'utf8')).not.toMatch(/from 'node:/);
  });
});
