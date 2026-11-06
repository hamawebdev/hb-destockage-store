import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import * as v from 'valibot';
import { AUDIT_MAX_JSON, snapshotJson } from '../src/audit/audit.ts';
import { ar } from '../src/i18n/ar.ts';
import { fr } from '../src/i18n/fr.ts';
import { defineMessages, format, translator } from '../src/i18n/index.ts';
import { CSRF_TTL_MS, issueCsrfToken, verifyCsrfToken } from '../src/lib/csrf.ts';
import { toAsciiDigits } from '../src/lib/digits.ts';
import { vCheckbox, vEmail, vInt, vMoneyDzd, vOptionalInt, vOptionalText, vText } from '../src/lib/forms.ts';
import { cursorPage, decodeCursor, encodeCursor } from '../src/lib/pagination.ts';
import { fromAlgiersInput, startOfAlgiersDay, toAlgiersInput } from '../src/lib/time.ts';
import { safeReturnPath } from '../src/routes/settings/index.tsx';
import { withFlash } from '../src/ui/flash.tsx';
import { formatDateTime, formatMoney } from '../src/ui/format.tsx';
import { activeHref, NAV, navFor } from '../src/ui/nav.ts';

// Real D1 (workerd) requests take seconds on the loaded shared machine: explicit budgets instead
// of vitest's 5 s default, so the admin gate is not red at random (lead, 2026-11-06).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

describe('i18n', () => {
  test('ar has exactly the keys of fr, all non-empty', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(fr).sort());
    for (const [k, val] of Object.entries(ar)) expect(val.trim(), k).not.toBe('');
  });
  test('interpolation and plurals', () => {
    expect(format('fr', 'Page {page} sur {pages}', { page: 2, pages: 10 })).toBe('Page 2 sur 10');
    const t = translator('fr');
    expect(t('form.errorSummary', { count: 1 })).toBe('1 erreur à corriger');
    expect(t('form.errorSummary', { count: 3 })).toBe('3 erreurs à corriger');
    const ta = translator('ar');
    expect(ta('form.errorSummary', { count: 1 })).toBe('خطأ واحد يجب تصحيحه');
    expect(ta('form.errorSummary', { count: 2 })).toBe('خطآن يجب تصحيحهما');
    expect(ta('form.errorSummary', { count: 5 })).toBe('5 أخطاء يجب تصحيحها');
  });
  test('defineMessages enforces key parity at compile time', () => {
    const m = defineMessages({ fr: { a: 'A {x}' }, ar: { a: 'أ {x}' } });
    expect(m('ar')('a', { x: 1 })).toBe('أ 1');
    // @ts-expect-error missing Arabic key
    defineMessages({ fr: { a: 'A', b: 'B' }, ar: { a: 'أ' } });
    // @ts-expect-error extra Arabic key
    defineMessages({ fr: { a: 'A' }, ar: { a: 'أ', z: 'ز' } });
    expectTypeOf(m('fr')).parameter(0).toEqualTypeOf<'a'>();
  });
});

describe('CSRF tokens', () => {
  const secret = 's'.repeat(40);
  test('round trip, bound to user and secret, expires, tamper-proof', async () => {
    const now = 1_780_000_000_000;
    const tok = await issueCsrfToken(secret, 7, now);
    expect(await verifyCsrfToken(secret, 7, tok, now + 1000)).toBe(true);
    expect(await verifyCsrfToken(secret, 8, tok, now + 1000)).toBe(false);
    expect(await verifyCsrfToken('other'.repeat(10), 7, tok, now)).toBe(false);
    expect(await verifyCsrfToken(secret, 7, tok, now + CSRF_TTL_MS + 1)).toBe(false);
    expect(await verifyCsrfToken(secret, 7, `${now + 1}${tok.slice(13)}`, now + 2)).toBe(false);
    for (const bad of [undefined, '', 'x', 123, `${now}.`, 'a'.repeat(500)]) expect(await verifyCsrfToken(secret, 7, bad, now)).toBe(false);
  });
});

describe('forms', () => {
  test('money: integer DZD, Eastern-Arabic digits and separators', () => {
    const s = vMoneyDzd();
    expect(v.parse(s, '14 600')).toBe(14600);
    expect(v.parse(s, '١٤٦٠٠')).toBe(14600);
    expect(v.parse(s, '۱۶۵۰۰')).toBe(16500);
    expect(v.parse(s, '16.500')).toBe(16500);
    expect(v.safeParse(s, '-5').success).toBe(false);
    expect(v.safeParse(s, '').success).toBe(false);
    expect(v.safeParse(s, '12a').success).toBe(false);
  });
  test('text, ints, checkbox, email', () => {
    expect(v.parse(vText(5), '  abc ')).toBe('abc');
    expect(v.safeParse(vText(5), 'abcdef').issues?.[0]?.message).toBe('form.tooLong|5');
    expect(v.safeParse(vText(5), '   ').issues?.[0]?.message).toBe('form.required');
    expect(v.parse(vOptionalText(5), '')).toBeNull();
    expect(v.parse(vInt(1, 10), '٣')).toBe(3);
    expect(v.safeParse(vInt(1, 10), '11').success).toBe(false);
    expect(v.parse(vCheckbox(), 'on')).toBe(true);
    expect(v.parse(vCheckbox(), undefined)).toBe(false);
    expect(v.parse(vEmail(), ' A@B.dz ')).toBe('a@b.dz');
  });
  test('every field helper accepts an absent key inside object/strictObject', () => {
    const S = v.strictObject({ n: vOptionalInt(1, 9), t: vOptionalText(5), c: vCheckbox() });
    expect(v.parse(S, {})).toEqual({ n: null, t: null, c: false });
    expect(v.parse(S, { n: '', t: '', c: 'on' })).toEqual({ n: null, t: null, c: true });
    expect(v.parse(S, { n: '٧' })).toMatchObject({ n: 7 });
    expect(v.safeParse(S, { n: '10' }).success).toBe(false);
    expect(v.safeParse(v.strictObject({ r: vText(5) }), {}).issues?.[0]?.message).toBe('form.required');
  });
  test('toAsciiDigits', () => {
    expect(toAsciiDigits('٠٥٦٠٤١٧٤٠٣')).toBe('0560417403');
    expect(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });
});

describe('audit snapshots', () => {
  test('the cap is in bytes, also for Arabic text', () => {
    const big = snapshotJson({ name_ar: 'منتج'.repeat(8000) })!;
    expect(new TextEncoder().encode(big).length).toBeLessThanOrEqual(AUDIT_MAX_JSON);
    expect(JSON.parse(big)._truncated).toBe(true);
    expect(JSON.parse(big).head).not.toContain('\uFFFD');
  });
  test('secrets redacted, size capped', () => {
    expect(JSON.parse(snapshotJson({ a: 1, apiKey: 'x', nested: { CSRF_SECRET: 'y', token: 'z' } })!)).toEqual({
      a: 1,
      apiKey: '[redacted]',
      nested: { CSRF_SECRET: '[redacted]', token: '[redacted]' },
    });
    expect(snapshotJson(undefined)).toBeNull();
    const big = snapshotJson({ s: 'x'.repeat(AUDIT_MAX_JSON * 2) })!;
    expect(big.length).toBeLessThanOrEqual(AUDIT_MAX_JSON);
    expect(JSON.parse(big)._truncated).toBe(true);
  });
});

describe('time (Africa/Algiers, UTC+1)', () => {
  test('datetime-local round trip', () => {
    const ms = Date.UTC(2026, 10, 4, 23, 30);
    expect(toAlgiersInput(ms)).toBe('2026-11-05T00:30');
    expect(fromAlgiersInput('2026-11-05T00:30')).toBe(ms);
    expect(fromAlgiersInput('2026-02-30')).toBeNull();
    expect(fromAlgiersInput('nope')).toBeNull();
    expect(startOfAlgiersDay(ms)).toBe(Date.UTC(2026, 10, 4, 23, 0));
  });
  test('matches Intl Africa/Algiers in summer and winter', () => {
    for (const ms of [Date.UTC(2026, 6, 1, 12, 0), Date.UTC(2026, 0, 15, 12, 0)]) {
      const intl = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
      expect(toAlgiersInput(ms).slice(11)).toBe(intl);
    }
  });
});

describe('formatting', () => {
  test('integer DZD with Latin digits in both languages; Algiers dates', () => {
    expect(formatMoney('fr', 14600)).toMatch(/14\s?600/);
    expect(formatMoney('ar', 14600)).not.toMatch(/[٠-٩]/);
    expect(formatMoney('ar', 14600)).toMatch(/14\D?600/);
    expect(formatDateTime('fr', Date.UTC(2026, 10, 4, 23, 30))).toContain('05/11/2026');
  });
});

describe('pagination, nav, flash, redirects', () => {
  test('cursor', () => {
    expect(decodeCursor(encodeCursor({ at: 1780000000000, id: 42 }))).toEqual({ at: 1780000000000, id: 42 });
    for (const bad of [undefined, '', '1', 'a.b', '1.2.3', '-1.2']) expect(decodeCursor(bad)).toBeNull();
    const rows = [1, 2, 3].map((id) => ({ at: 100 - id, id }));
    expect(cursorPage(rows, 2, (r) => r)).toEqual({ rows: rows.slice(0, 2), next: '98.2' });
    expect(cursorPage(rows, 3, (r) => r).next).toBeNull();
  });
  test('nav filtered per role; longest prefix wins', () => {
    const items = NAV.flatMap((g) => g.items);
    expect(activeHref('/orders/queue', items)).toBe('/orders/queue');
    expect(activeHref('/orders/12', items)).toBe('/orders');
    expect(activeHref('/dashboard', items)).toBe('/dashboard');
    expect(activeHref('/', items)).toBeUndefined();
    expect(activeHref('/ordersx', items)).toBeUndefined();
    const content = navFor({ role: 'content' }).flatMap((g) => g.items.map((i) => i.href));
    expect(content).not.toContain('/orders');
    expect(content).not.toContain('/customers');
    expect(content).toContain('/products');
  });
  test('withFlash / safeReturnPath', () => {
    expect(withFlash('/orders/1', 'saved')).toBe('/orders/1?m=saved');
    expect(withFlash('/orders?x=1', 'saved')).toBe('/orders?x=1&m=saved');
    expect(() => withFlash('//evil', 'saved')).toThrow();
    expect(safeReturnPath('/orders?x=1')).toBe('/orders?x=1');
    expect(safeReturnPath('//evil')).toBe('/');
  });
});

describe('UI kit markup (admin-catalog / lead requests 2026-11-06)', () => {
  test('Code never wraps; input size hints; table data-label', async () => {
    const { Code } = await import('../src/ui/format.tsx');
    const { MoneyInput, NumberInput, SkuInput } = await import('../src/ui/form.tsx');
    expect(String(Code({ children: 'HB-7K2Q9' }))).toBe('<bdi dir="ltr" class="code">HB-7K2Q9</bdi>');
    const html = String(
      await Promise.resolve(
        [MoneyInput({ name: 'p', label: 'Prix' }), NumberInput({ name: 'q', label: 'Qté' }), SkuInput({ name: 's', label: 'SKU' })].join(''),
      ),
    );
    expect(html).toContain('class="input input--money"');
    expect(html).toContain('class="input input--qty"');
    expect(html).toContain('class="input input--sku"');
  });
});
