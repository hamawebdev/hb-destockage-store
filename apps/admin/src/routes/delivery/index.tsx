// Delivery section (owner: shipping). Mounted at /delivery by app.ts. Contract: artifacts/SHIP-0.
// Rules: see the header of src/app.ts.
//
//   GET  /settings                         couriers, search                  (delivery.settings)
//   GET  /settings/:courier                one courier
//   POST /settings/:courier/keys           seal and store credentials
//   POST /settings/:courier/config         origin wilaya, pickup request
//   POST /settings/:courier/test           one credential check, recorded
//   POST /settings/:courier/enable|disable
//   POST /settings/:courier/remove-keys
//   POST /settings/:courier/webhook-token[/remove]   the URL token, shown once
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { canEnable, getCourier, listCouriers, type CourierAdapter, type CourierCredentials } from '@hb/couriers';
import { courierAccounts, hashWebhookToken, newWebhookToken, wilayas, type CourierAccount } from '@hb/db';
import { audit, noAudit, withAudit } from '../../audit/audit.ts';
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { readForm } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { renderError } from '../../ui/error-page.tsx';
import { withFlash } from '../../ui/flash.tsx';
import type { FieldErrors, Option } from '../../ui/form.tsx';
import { courierContext, credentialHint, openCredentials, readKeyState, sealCredentials, WEBHOOK_SECRET_FIELD, type KeyState } from './keys.ts';
import { m } from './messages.ts';
import { AccountPage, SettingsListPage, type AccountView } from './settings-page.tsx';

const r = createRouter({ roles: rolesFor('delivery.view') });

const CHECK_TIMEOUT_MS = 8000;
const MAX_CREDENTIAL_CHARS = 500;
const SEARCH_MAX = 60;

type Ctx = Context<AppEnv>;
const problemOf = (state: KeyState) => (state.ok ? null : state.reason);
const changesOf = (result: unknown): number => (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
/** The account still holds exactly the sealed keys this request read. */
const sameKeys = (courier: string, cipher: string) => and(eq(courierAccounts.courier, courier), eq(courierAccounts.credentialsCipher, cipher))!;

async function accountOf(c: Ctx, courier: string): Promise<CourierAccount | undefined> {
  return (await c.var.db.select().from(courierAccounts).where(eq(courierAccounts.courier, courier)))[0];
}

async function viewOf(adapter: CourierAdapter, account: CourierAccount | undefined, state: KeyState): Promise<AccountView> {
  const unreadable = Boolean(account?.credentialsCipher) && state.ok && (await openCredentials(state.key, account)) === null;
  return { adapter, account, unreadable };
}

async function wilayaOptions(c: Ctx): Promise<Option[]> {
  const rows = await c.var.db.select({ code: wilayas.code, fr: wilayas.nameFr, ar: wilayas.nameAr }).from(wilayas).orderBy(asc(wilayas.code));
  return rows.map((w) => ({ value: String(w.code), label: `${w.code} - ${c.var.lang === 'ar' ? w.ar : w.fr}` }));
}

async function renderAccount(c: Ctx, adapter: CourierAdapter, status: 200 | 409 | 422, extra: { errors?: FieldErrors; webhookOnce?: string } = {}) {
  const state = await readKeyState(c.env);
  const account = await accountOf(c, adapter.id);
  const view = await viewOf(adapter, account, state);
  const options = await wilayaOptions(c);
  c.status(status);
  return c.render(<AccountPage view={view} keyProblem={problemOf(state)} wilayas={options} {...extra} />, {
    title: adapter.displayName,
    breadcrumbs: [{ href: '/delivery/settings', label: m(c.var.lang)('settings.title') }],
  });
}

r.get('/settings', requirePerm('delivery.settings'), async (c) => {
  const q = (c.req.query('q') ?? '').slice(0, SEARCH_MAX).trim();
  const needle = q.toLowerCase();
  const [state, accounts] = await Promise.all([readKeyState(c.env), c.var.db.select().from(courierAccounts)]);
  const byCourier = new Map(accounts.map((a) => [a.courier, a]));
  const adapters = listCouriers().filter((a) => needle === '' || a.displayName.toLowerCase().includes(needle) || a.id.includes(needle));
  const views = await Promise.all(adapters.map((a) => viewOf(a, byCourier.get(a.id), state)));
  // Couriers already configured first; the long tail of tenants stays alphabetical below them.
  const rank = (v: AccountView) => (v.account?.enabled ? 0 : v.account?.credentialsCipher ? 1 : 2);
  views.sort((a, b) => rank(a) - rank(b) || a.adapter.displayName.localeCompare(b.adapter.displayName, 'fr'));
  return c.render(<SettingsListPage views={views} q={q} keyProblem={problemOf(state)} />, { title: m(c.var.lang)('settings.title') });
});

/** The courier named in the URL, or a 404 page. Ids come from the registry only. */
function courierParam(c: Ctx): CourierAdapter | null {
  return getCourier(c.req.param('courier') ?? '') ?? null;
}

r.get('/settings/:courier', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  return adapter ? renderAccount(c, adapter, 200) : renderError(c, 404);
});

r.post('/settings/:courier/keys', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter) return (noAudit(c, 'unknown courier'), renderError(c, 404));
  const tm = m(c.var.lang);
  const state = await readKeyState(c.env);
  if (!state.ok) {
    noAudit(c, 'encryption key unavailable, nothing written');
    return renderAccount(c, adapter, 409, { errors: { _form: tm('err.keyConfig') } });
  }
  const values = await readForm(c);
  const account = await accountOf(c, adapter.id);
  const stored = await openCredentials(state.key, account);
  const merged: Record<string, string> = {};
  const fieldsSet: string[] = [];
  const errors: Record<string, string> = {};
  for (const f of adapter.capabilities.credentialFields) {
    const name = `cred_${f.key}`;
    const given = (values[name] ?? '').trim();
    if ([...given].length > MAX_CREDENTIAL_CHARS) {
      errors[name] = c.var.t('form.tooLong', { max: MAX_CREDENTIAL_CHARS });
    } else if (given !== '') {
      merged[f.key] = given;
      fieldsSet.push(f.key);
    } else if (stored?.[f.key] !== undefined) {
      merged[f.key] = stored[f.key]!;
    } else {
      errors[name] = c.var.t('form.required');
    }
  }
  if (adapter.capabilities.webhook === 'hmac') {
    // Optional: blank keeps what is stored, absent stays absent.
    const name = `cred_${WEBHOOK_SECRET_FIELD}`;
    const given = (values[name] ?? '').trim();
    if ([...given].length > MAX_CREDENTIAL_CHARS) errors[name] = c.var.t('form.tooLong', { max: MAX_CREDENTIAL_CHARS });
    else if (given !== '') {
      merged[WEBHOOK_SECRET_FIELD] = given;
      fieldsSet.push(WEBHOOK_SECRET_FIELD);
    } else if (stored?.[WEBHOOK_SECRET_FIELD] !== undefined) merged[WEBHOOK_SECRET_FIELD] = stored[WEBHOOK_SECRET_FIELD]!;
  }
  if (Object.keys(errors).length > 0) {
    noAudit(c, 'credentials form refused, nothing written');
    return renderAccount(c, adapter, 422, { errors });
  }
  if (fieldsSet.length === 0) {
    noAudit(c, 'credentials form was blank: stored values kept');
    return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
  }
  const sealed = await sealCredentials(state.key, adapter.id, merged as CourierCredentials);
  const hint = Object.fromEntries(Object.entries(merged).map(([k, val]) => [k, credentialHint(val)]));
  // New keys are unproven: the last check no longer applies, and an unconfirmed courier goes off.
  const enabled = (account?.enabled ?? false) && canEnable(adapter, null);
  const row = {
    credentialsCipher: sealed.cipher,
    credentialsIv: sealed.iv,
    keyVersion: 1,
    credentialsHint: hint,
    lastCheckResult: null,
    lastCheckAt: null,
    enabled,
    updatedBy: c.var.user.id,
  };
  await withAudit(
    c,
    { action: 'courierAccount.saveKeys', entity: 'courier_accounts', entityId: adapter.id, before: { hadKeys: Boolean(account?.credentialsCipher) }, after: { fieldsSet, enabled } },
    c.var.db.insert(courierAccounts).values({ courier: adapter.id, ...row }).onConflictDoUpdate({ target: courierAccounts.courier, set: row }),
  );
  return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
});

r.post('/settings/:courier/config', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter) return (noAudit(c, 'unknown courier'), renderError(c, 404));
  const values = await readForm(c);
  const account = await accountOf(c, adapter.id);
  const config: Record<string, unknown> = { ...(account?.config ?? {}) };
  if (adapter.capabilities.needsOriginWilaya) {
    const code = Number(values['originWilaya'] ?? '');
    const known = Number.isInteger(code) && (await c.var.db.select({ code: wilayas.code }).from(wilayas).where(eq(wilayas.code, code))).length === 1;
    if (!known) {
      noAudit(c, 'config refused: bad origin wilaya');
      return renderAccount(c, adapter, 422, { errors: { originWilaya: c.var.t('form.invalid') } });
    }
    config['originWilaya'] = code;
  }
  if (adapter.capabilities.needsValidation) config['askCollection'] = values['askCollection'] === '1';
  const row = { config, updatedBy: c.var.user.id };
  await withAudit(
    c,
    { action: 'courierAccount.config', entity: 'courier_accounts', entityId: adapter.id, before: account?.config ?? null, after: config },
    c.var.db.insert(courierAccounts).values({ courier: adapter.id, ...row }).onConflictDoUpdate({ target: courierAccounts.courier, set: row }),
  );
  return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
});

r.post('/settings/:courier/test', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter) return (noAudit(c, 'unknown courier'), renderError(c, 404));
  const tm = m(c.var.lang);
  const state = await readKeyState(c.env);
  const account = await accountOf(c, adapter.id);
  const credentials = state.ok ? await openCredentials(state.key, account) : null;
  if (!credentials) {
    noAudit(c, 'test refused: no readable keys, nothing called');
    return renderAccount(c, adapter, 409, { errors: { _form: tm('err.keysNeeded') } });
  }
  const check = await adapter.checkCredentials(credentials, courierContext(c.env, CHECK_TIMEOUT_MS));
  const now = Date.now();
  // The result belongs to the keys that were tested: a save in the meantime makes it count for nothing.
  const same = sameKeys(adapter.id, account!.credentialsCipher!);
  const [res] = await c.var.db.batch([
    c.var.db.update(courierAccounts).set({ lastCheckResult: check.kind, lastCheckAt: now, updatedBy: c.var.user.id }).where(same),
    audit(c, { action: 'courierAccount.test', entity: 'courier_accounts', entityId: adapter.id, before: null, after: { result: check.kind } }, { when: same }),
  ]);
  if (changesOf(res) !== 1) return renderAccount(c, adapter, 409, { errors: { _form: tm('err.keysChanged') } });
  return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
});

r.post('/settings/:courier/enable', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter) return (noAudit(c, 'unknown courier'), renderError(c, 404));
  const tm = m(c.var.lang);
  const state = await readKeyState(c.env);
  const account = await accountOf(c, adapter.id);
  const refuse = (key: 'err.keysNeeded' | 'err.notConfirmed' | 'err.originNeeded') => {
    noAudit(c, `enable refused: ${key}`);
    return renderAccount(c, adapter, 409, { errors: { _form: tm(key) } });
  };
  if (!state.ok || !account || (await openCredentials(state.key, account)) === null) return refuse('err.keysNeeded');
  if (!canEnable(adapter, account.lastCheckResult)) return refuse('err.notConfirmed');
  if (adapter.capabilities.needsOriginWilaya && typeof account.config['originWilaya'] !== 'number') return refuse('err.originNeeded');
  // Enable the keys and check result that were read above, not whatever a concurrent save stored.
  const same = and(sameKeys(adapter.id, account.credentialsCipher!), account.lastCheckResult === null ? isNull(courierAccounts.lastCheckResult) : eq(courierAccounts.lastCheckResult, account.lastCheckResult))!;
  const [res] = await c.var.db.batch([
    c.var.db.update(courierAccounts).set({ enabled: true, updatedBy: c.var.user.id }).where(same),
    audit(c, { action: 'courierAccount.enable', entity: 'courier_accounts', entityId: adapter.id, before: { enabled: account.enabled }, after: { enabled: true } }, { when: sql`EXISTS (SELECT 1 FROM ${courierAccounts} WHERE ${same} AND ${courierAccounts.enabled} = 1)` }),
  ]);
  if (changesOf(res) !== 1) return renderAccount(c, adapter, 409, { errors: { _form: tm('err.keysChanged') } });
  return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
});

r.post('/settings/:courier/disable', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter) return (noAudit(c, 'unknown courier'), renderError(c, 404));
  await withAudit(
    c,
    { action: 'courierAccount.disable', entity: 'courier_accounts', entityId: adapter.id, before: null, after: { enabled: false } },
    c.var.db.update(courierAccounts).set({ enabled: false, updatedBy: c.var.user.id }).where(eq(courierAccounts.courier, adapter.id)),
  );
  return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
});

r.post('/settings/:courier/remove-keys', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter) return (noAudit(c, 'unknown courier'), renderError(c, 404));
  await withAudit(
    c,
    { action: 'courierAccount.removeKeys', entity: 'courier_accounts', entityId: adapter.id, before: null, after: { hasKeys: false, enabled: false } },
    c.var.db
      .update(courierAccounts)
      .set({ credentialsCipher: null, credentialsIv: null, keyVersion: null, credentialsHint: {}, enabled: false, lastCheckResult: null, lastCheckAt: null, updatedBy: c.var.user.id })
      .where(eq(courierAccounts.courier, adapter.id)),
  );
  return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
});

/** Absolute URL on the storefront origin when the admin is on `admin.<domain>`; else just the path. */
function webhookUrl(c: Ctx, courier: string, token: string): string {
  const path = `/api/courier-hook/${courier}/${token}`;
  const host = new URL(c.req.url).hostname;
  return host.startsWith('admin.') ? `https://${host.slice('admin.'.length)}${path}` : path;
}

r.post('/settings/:courier/webhook-token', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter || adapter.capabilities.webhook === 'none') return (noAudit(c, 'courier has no webhook'), renderError(c, 404));
  const token = newWebhookToken();
  const row = { webhookTokenHash: await hashWebhookToken(token), updatedBy: c.var.user.id };
  await c.var.db.batch([
    c.var.db.insert(courierAccounts).values({ courier: adapter.id, ...row }).onConflictDoUpdate({ target: courierAccounts.courier, set: row }),
    audit(c, { action: 'courierAccount.webhookToken', entity: 'courier_accounts', entityId: adapter.id, before: null, after: { generated: true } }),
  ]);
  // The token is rendered on this one response and is in no URL, log or audit row of ours.
  return renderAccount(c, adapter, 200, { webhookOnce: webhookUrl(c, adapter.id, token) });
});

r.post('/settings/:courier/webhook-token/remove', requirePerm('delivery.settings'), async (c) => {
  const adapter = courierParam(c);
  if (!adapter) return (noAudit(c, 'unknown courier'), renderError(c, 404));
  await withAudit(
    c,
    { action: 'courierAccount.webhookTokenRemove', entity: 'courier_accounts', entityId: adapter.id, before: null, after: { removed: true } },
    c.var.db.update(courierAccounts).set({ webhookTokenHash: null, updatedBy: c.var.user.id }).where(eq(courierAccounts.courier, adapter.id)),
  );
  return c.redirect(withFlash(`/delivery/settings/${adapter.id}`, 'saved'), 303);
});

export default r;
