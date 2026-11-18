// Settings (admin-core): per-user UI language (every role), store settings (owner, ADMIN-5) and the
// storefront switches (owner): the cart (CART-2) and "you may also like" (BOOT-45, D-030).
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
import { Card } from '../../ui/kit.tsx';
import { cm } from './cart-messages.ts';
import { rm } from './related-messages.ts';
import { loadReception, Reception } from './reception.tsx';

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

// ---------------------------------------------------------------------------------------------
// Storefront switches (owner only, settings.edit): the cart (CART-2, key `cartEnabled`) and "you may
// also like" on product pages (BOOT-45 / D-030, key `relatedEnabled`). Each is a JSON boolean, missing
// ⇒ on (@hb/catalog settingsFromKeyValues). Read by the publish export, so the site changes at the next
// publish, and the card says so with a link to /publish; /api/order never reads them (orders from
// pages built before a switch still go through). Each has its own small form so a switch change never
// depends on the store form being valid, and vice versa.
// ---------------------------------------------------------------------------------------------

export const CART_KEY = 'cartEnabled';
export const RELATED_KEY = 'relatedEnabled';

type SwitchMessage = Parameters<ReturnType<typeof cm>>[0];
interface SwitchDef {
  /** settings key = form field name. */
  readonly key: typeof CART_KEY | typeof RELATED_KEY;
  /** POST path and the `data-<name>-*` hooks on the card. */
  readonly name: 'cart' | 'related';
  readonly messages: (lang: AppEnv['Variables']['lang']) => (key: SwitchMessage) => string;
}
const SWITCHES = {
  cart: { key: CART_KEY, name: 'cart', messages: cm },
  related: { key: RELATED_KEY, name: 'related', messages: rm },
} as const satisfies Record<string, SwitchDef>;
type SwitchName = keyof typeof SWITCHES;
type SwitchStates = Record<SwitchName, { enabled: boolean; error?: string }>;

async function loadSwitch(c: Context<AppEnv>, key: SwitchDef['key']): Promise<{ exists: boolean; value: boolean }> {
  const row = await c.var.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  // Anything but an explicit `false` is on, exactly like the snapshot export.
  return { exists: row !== undefined, value: row?.value !== false };
}

async function loadSwitches(c: Context<AppEnv>): Promise<SwitchStates> {
  const [cart, related] = await Promise.all([loadSwitch(c, CART_KEY), loadSwitch(c, RELATED_KEY)]);
  return { cart: { enabled: cart.value }, related: { enabled: related.value } };
}

function StorefrontSwitch(props: { c: Context<AppEnv>; def: SwitchDef; enabled: boolean; error?: string | undefined }) {
  const { c, def, enabled, error } = props;
  const tm = def.messages(c.var.lang);
  const { key, name } = def;
  const errId = `f-${key}-error`;
  const option = (value: 'on' | 'off', label: string, hint: string) => (
    <div class="field field--check">
      <input type="radio" class="check" id={`f-${key}-${value}`} name={key} value={value} checked={enabled === (value === 'on')} aria-describedby={`f-${key}-${value}-hint`} />
      <label for={`f-${key}-${value}`}><strong>{label}</strong></label>
      <p class="field__hint" id={`f-${key}-${value}-hint`}>{hint}</p>
    </div>
  );
  return (
    <Card title={tm('title')} id={`${name}-switch`}>
      <div {...{ [`data-${name}-switch`]: true }}>
        <p>{tm('intro')}</p>
        <div class="callout callout--warning" {...{ [`data-${name}-publish-note`]: true }}>
          <p>
            <strong>{tm('note.lead')}</strong> {tm('note')}
            {can(c.var.user, 'publish.run') ? <> <a href="/publish">{tm('note.link')}</a></> : null}
          </p>
        </div>
        <Form action={`/settings/${name}`}>
          <fieldset class="localized" aria-describedby={error ? errId : undefined}>
            <legend class="localized__legend">{tm('legend')}</legend>
            {error ? <p class="field__error" id={errId}>{error}</p> : null}
            {option('on', tm('on'), tm('on.hint'))}
            {option('off', tm('off'), tm('off.hint'))}
          </fieldset>
          <p class="field__hint" {...{ [`data-${name}-current`]: enabled ? 'on' : 'off' }}>{tm(enabled ? 'current.on' : 'current.off')}</p>
          <FormActions>
            <Submit>{tm('save')}</Submit>
          </FormActions>
        </Form>
      </div>
    </Card>
  );
}

async function renderStore(c: Context<AppEnv>, values: Record<string, string | undefined>, errors: Record<string, string> | undefined, switches: SwitchStates) {
  const t = c.var.t;
  const wa = values['whatsapp'] ? normalizePhone(values['whatsapp']) : null;
  // Order reception (TGS-4): Telegram and Google Sheets cards, outside the store form.
  const reception = await loadReception(c);
  return c.render(
    <>
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
    </Form>
    <Reception c={c} data={reception} />
    <StorefrontSwitch c={c} def={SWITCHES.cart} enabled={switches.cart.enabled} error={switches.cart.error} />
    <StorefrontSwitch c={c} def={SWITCHES.related} enabled={switches.related.enabled} error={switches.related.error} />
    </>,
    { title: t('nav.settings') },
  );
}

r.get('/', requirePerm('settings.edit'), async (c) =>
  renderStore(c, formValues(await loadStore(c)), undefined, await loadSwitches(c)),
);

for (const def of Object.values(SWITCHES) as SwitchDef[]) {
  const SwitchForm = v.object({ [def.key]: v.picklist(['on', 'off']) });
  r.post(`/${def.name}`, requirePerm('settings.edit'), async (c) => {
    const raw = await readForm(c);
    const f = v.safeParse(SwitchForm, raw);
    const current = await loadSwitch(c, def.key);
    if (!f.success) {
      c.status(422);
      const states = await loadSwitches(c);
      states[def.name] = { enabled: current.value, error: def.messages(c.var.lang)('invalid') };
      return renderStore(c, formValues(await loadStore(c)), undefined, states);
    }
    const next = f.output[def.key] === 'on';
    // A missing key is written even when it means the same (on), so the export reads an explicit value.
    if (current.exists && current.value === next) {
      noAudit(c, `${def.name} switch saved without changes: nothing written`);
      return c.redirect(withFlash('/settings', 'saved'), 303);
    }
    const db = c.var.db;
    const userId = c.var.user.id;
    const json = JSON.stringify(next);
    await db.batch([
      db
        .insert(settings)
        .values({ key: def.key, value: sql`${json}`, updatedBy: userId })
        .onConflictDoUpdate({ target: settings.key, set: { value: sql`${json}`, updatedBy: userId, updatedAt: Date.now() } }),
      audit(c, { action: 'settings.update', entity: 'settings', entityId: def.key, before: current.exists ? current.value : null, after: next }),
    ]);
    return c.redirect(withFlash('/settings', 'saved'), 303);
  });
}

r.post('/', requirePerm('settings.edit'), async (c) => {
  const raw = await readForm(c);
  const f = validateForm(c, storeSchema(), raw);
  if (!f.ok) {
    c.status(422);
    return renderStore(c, raw, f.errors, await loadSwitches(c));
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
