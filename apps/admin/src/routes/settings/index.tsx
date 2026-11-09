// Settings (admin-core): per-user UI language (every role) and store settings (owner, ADMIN-5).
// Route order matters: POST /language is registered before POST / so it is matched first.
import { eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import * as v from 'valibot';
import { adminUsers, settings } from '@hb/db';
import { formatPhoneInternational, normalizePhone } from '@hb/shared';
import type { AppEnv } from '../../env.ts';
import { withFlash } from '../../ui/flash.tsx';
import { ErrorSummary, Form, FormActions, LocalizedField, NumberInput, PhoneInput, Submit, TextInput } from '../../ui/form.tsx';
import { can, rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { audit, noAudit, withAudit } from '../../audit/audit.ts';
import { LANGS } from '../../i18n/index.ts';
import { parseForm, readForm, validateForm, vEmail, vInt, vPicklist, vText } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { safeReturnPath } from '../../lib/redirect.ts';
import { renderError } from '../../ui/error-page.tsx';
import { DEFAULT_DELAY_DAYS, DELAY_MAX, DELAY_MIN } from '../parcels/data.ts';

const r = createRouter({ roles: rolesFor('self.lang') });


const LanguageForm = v.object({
  lang: vPicklist(LANGS),
  return_to: v.optional(v.string(), '/'),
});

export { safeReturnPath } from '../../lib/redirect.ts';

r.post('/language', requirePerm('self.lang'), async (c) => {
  const f = await parseForm(c, LanguageForm);
  if (!f.ok) return renderError(c, 403);
  const user = c.var.user;
  if (f.data.lang !== user.uiLang) {
    await withAudit(
      c,
      { action: 'adminUser.setLanguage', entity: 'admin_users', entityId: user.id, before: { uiLang: user.uiLang }, after: { uiLang: f.data.lang } },
      c.var.db.update(adminUsers).set({ uiLang: f.data.lang }).where(eq(adminUsers.id, user.id)),
    );
  } else {
    noAudit(c, 'language unchanged: nothing written');
  }
  return c.redirect(safeReturnPath(f.data.return_to), 303);
});

// ---------------------------------------------------------------------------------------------
// Store settings (ADMIN-5, owner only). Keys follow CAT-1 SnapshotSettings for the storefront
// (read by the publish pipeline) and admin-orders' call-workflow keys. One audited row per
// changed key, all in one batch. Phones go through @hb/shared normalizePhone (one phone rule).
// ---------------------------------------------------------------------------------------------

export const SETTINGS_DEFAULTS = {
  orderMaxUnanswered: 3,
  callRetryMinutes: 30,
  unreachableRetryMinutes: 240,
  lowStockThreshold: 3,
  delayedParcelDays: DEFAULT_DELAY_DAYS,
} as const;

const phoneField = () =>
  v.pipe(
    v.optional(v.string(), ''),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const r = normalizePhone(dataset.value);
      if (!r.ok) {
        addIssue({ message: r.code === 'phone_required' ? 'form.required' : 'form.phoneInvalid' });
        return NEVER;
      }
      return r;
    }),
  );

function storeSchema() {
  return v.object({
    storeName_fr: vText(80),
    storeName_ar: vText(80),
    contactPhone: phoneField(),
    whatsapp: phoneField(),
    contactEmail: v.union([v.pipe(v.optional(v.string(), ''), v.trim(), v.length(0), v.transform(() => null)), vEmail()], 'form.invalid'),
    orderMaxUnanswered: vInt(1, 10),
    callRetryMinutes: vInt(5, 1440),
    unreachableRetryMinutes: vInt(15, 10080),
    lowStockThreshold: vInt(0, 1000),
    delayedParcelDays: vInt(DELAY_MIN, DELAY_MAX),
  });
}

type StoreSettings = {
  storeName: { fr: string; ar: string };
  contactPhone: string;
  whatsapp: string;
  contactEmail: string | null;
  orderMaxUnanswered: number;
  callRetryMinutes: number;
  unreachableRetryMinutes: number;
  lowStockThreshold: number;
  delayedParcelDays: number;
};
export const STORE_KEYS = ['storeName', 'contactPhone', 'whatsapp', 'contactEmail', 'orderMaxUnanswered', 'callRetryMinutes', 'unreachableRetryMinutes', 'lowStockThreshold', 'delayedParcelDays'] as const;

async function loadStore(c: Context<AppEnv>): Promise<Partial<Record<(typeof STORE_KEYS)[number], unknown>>> {
  const rows = await c.var.db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [...STORE_KEYS])).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function formValues(s: Partial<Record<string, unknown>>): Record<string, string> {
  const name = (s['storeName'] ?? {}) as { fr?: unknown; ar?: unknown };
  const str = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '');
  const wa = str(s['whatsapp']);
  return {
    storeName_fr: str(name.fr),
    storeName_ar: str(name.ar),
    contactPhone: str(s['contactPhone']),
    whatsapp: wa ? `+${wa}` : '',
    contactEmail: str(s['contactEmail']),
    orderMaxUnanswered: str(s['orderMaxUnanswered'] ?? SETTINGS_DEFAULTS.orderMaxUnanswered),
    callRetryMinutes: str(s['callRetryMinutes'] ?? SETTINGS_DEFAULTS.callRetryMinutes),
    unreachableRetryMinutes: str(s['unreachableRetryMinutes'] ?? SETTINGS_DEFAULTS.unreachableRetryMinutes),
    lowStockThreshold: str(s['lowStockThreshold'] ?? SETTINGS_DEFAULTS.lowStockThreshold),
    delayedParcelDays: str(s['delayedParcelDays'] ?? SETTINGS_DEFAULTS.delayedParcelDays),
  };
}

function renderStore(c: Context<AppEnv>, values: Record<string, string | undefined>, errors?: Record<string, string>) {
  const t = c.var.t;
  const wa = values['whatsapp'] ? normalizePhone(values['whatsapp']) : null;
  return c.render(
    <Form action="/settings">
      <ErrorSummary errors={errors} />
      <div class="callout callout--warning">
        <p><strong>{t('settings.publishNote.lead')}</strong> {t('settings.publishNote')}</p>
      </div>
      <h2>{t('settings.store')}</h2>
      <LocalizedField name="storeName" label={t('settings.storeName')} values={values} errors={errors} maxlength={80} required />
      <PhoneInput name="contactPhone" label={t('settings.contactPhone')} value={values['contactPhone']} error={errors?.['contactPhone']} required hint={t('settings.phoneHint')} />
      <PhoneInput name="whatsapp" label={t('settings.whatsapp')} value={values['whatsapp']} error={errors?.['whatsapp']} required hint={t('settings.phoneHint')} />
      {wa && wa.ok ? <p class="field__hint">{t('settings.whatsappPreview')} <bdi dir="ltr">{formatPhoneInternational(wa.e164)}</bdi></p> : null}
      <TextInput name="contactEmail" type="email" label={t('settings.contactEmail')} value={values['contactEmail']} error={errors?.['contactEmail']} dir="ltr" maxlength={254} />
      <h2>{t('settings.calls')}</h2>
      <NumberInput name="orderMaxUnanswered" label={t('settings.orderMaxUnanswered')} value={values['orderMaxUnanswered']} error={errors?.['orderMaxUnanswered']} required hint={t('settings.range', { min: 1, max: 10 })} />
      <NumberInput name="callRetryMinutes" label={t('settings.callRetryMinutes')} value={values['callRetryMinutes']} error={errors?.['callRetryMinutes']} required hint={t('settings.range', { min: 5, max: 1440 })} />
      <NumberInput name="unreachableRetryMinutes" label={t('settings.unreachableRetryMinutes')} value={values['unreachableRetryMinutes']} error={errors?.['unreachableRetryMinutes']} required hint={t('settings.range', { min: 15, max: 10080 })} />
      <h2>{t('settings.stock')}</h2>
      <NumberInput name="lowStockThreshold" label={t('settings.lowStockThreshold')} value={values['lowStockThreshold']} error={errors?.['lowStockThreshold']} required hint={t('settings.range', { min: 0, max: 1000 })} />
      {can(c.var.user, 'sheets.settings') ? (
        <>
          <h2>{t('settings.sheets')}</h2>
          <p class="field__hint">
            {t('settings.sheetsHint')} <a href="/sheets">{t('settings.sheetsLink')}</a>
          </p>
        </>
      ) : null}
      <h2>{t('settings.delivery')}</h2>
      {can(c.var.user, 'delivery.settings') ? (
        <p class="field__hint">
          {t('settings.couriersHint')} <a href="/delivery/settings">{t('settings.couriersLink')}</a>
        </p>
      ) : null}
      <NumberInput name="delayedParcelDays" label={t('settings.delayedParcelDays')} value={values['delayedParcelDays']} error={errors?.['delayedParcelDays']} required hint={t('settings.delayedParcelDaysHint', { min: DELAY_MIN, max: DELAY_MAX })} />
      <FormActions>
        <Submit>{t('common.save')}</Submit>
      </FormActions>
    </Form>,
    { title: t('nav.settings') },
  );
}

r.get('/', requirePerm('settings.edit'), async (c) => renderStore(c, formValues(await loadStore(c))));

r.post('/', requirePerm('settings.edit'), async (c) => {
  const raw = await readForm(c);
  const f = validateForm(c, storeSchema(), raw);
  if (!f.ok) {
    c.status(422);
    return renderStore(c, raw, f.errors);
  }
  const d = f.data;
  const next: StoreSettings = {
    storeName: { fr: d.storeName_fr, ar: d.storeName_ar },
    contactPhone: d.contactPhone.national,
    whatsapp: d.whatsapp.e164.slice(1),
    contactEmail: d.contactEmail,
    orderMaxUnanswered: d.orderMaxUnanswered,
    callRetryMinutes: d.callRetryMinutes,
    unreachableRetryMinutes: d.unreachableRetryMinutes,
    lowStockThreshold: d.lowStockThreshold,
    delayedParcelDays: d.delayedParcelDays,
  };
  const current = await loadStore(c);
  // A key that does not exist yet counts as changed even when the new value is null, so the
  // publish pipeline always finds every key (e.g. contactEmail: null).
  const changed = STORE_KEYS.filter((k) => !Object.hasOwn(current, k) || JSON.stringify(current[k]) !== JSON.stringify(next[k]));
  if (changed.length === 0) {
    noAudit(c, 'settings saved without changes: nothing written');
    return c.redirect(withFlash('/settings', 'saved'), 303);
  }
  const db = c.var.db;
  const userId = c.var.user.id;
  // settings.value is NOT NULL JSON text: bind the serialised JSON ourselves so `null` is stored
  // as the JSON text 'null' (drizzle would turn a null value into SQL NULL).
  const stmts = changed.flatMap((k) => [
    db
      .insert(settings)
      .values({ key: k, value: sql`${JSON.stringify(next[k])}`, updatedBy: userId })
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`${JSON.stringify(next[k])}`, updatedBy: userId, updatedAt: Date.now() } }),
    audit(c, { action: 'settings.update', entity: 'settings', entityId: k, before: current[k] ?? null, after: next[k] }),
  ]);
  await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  return c.redirect(withFlash('/settings', 'saved'), 303);
});

export default r;
