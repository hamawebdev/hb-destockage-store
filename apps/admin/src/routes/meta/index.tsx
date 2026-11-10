// Meta settings (MSET-2, artifacts/MSET-0/plan.md §3, D-017). Owner only (`meta.settings`).
// The admin is the only source of the Pixel ID, the consent setting, the Conversions API access token
// and the test event code. Rows in `settings` (keys in @hb/db/meta-settings):
//  - metaPixelId, metaConsentRequired: exported to the snapshot by the publish (browser, next publish);
//  - metaAccessTokenEnc (sealed with SETTINGS_ENCRYPTION_KEY), metaTestEventCode: server only, read by
//    hb-web at send time, never exported.
// The token is write-only: never prefilled, never echoed, shown at most as "····1234". Audit rows for
// the token and the test code carry `present` markers only, never a value, a hint or the ciphertext.
//
//   GET  /meta                      status + forms
//   POST /meta/pixel                Pixel ID + consent        POST /meta/pixel/remove
//   POST /meta/token                seal and store the token  POST /meta/token/remove
//   POST /meta/test-code            test event code           POST /meta/test-code/remove
import { eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import * as v from 'valibot';
import { settings } from '@hb/db';
import type { SecretBoxKey } from '@hb/db/secret-box';
import { importSettingsKey, metaTokenHint, META_SETTING_KEYS, META_TEST_EVENT_CODE_RE, MetaTokenError, openMetaToken, sealMetaToken } from '@hb/db/meta-settings';
import { isMetaPixelId, toAsciiDigits } from '@hb/shared';
import { audit, noAudit } from '../../audit/audit.ts';
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { readForm } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { withFlash } from '../../ui/flash.tsx';
import { mm } from './messages.ts';
import { MetaPage, type MetaErrors, type MetaView } from './view.tsx';

type Ctx = Context<AppEnv>;
type Key = (typeof META_SETTING_KEYS)[keyof typeof META_SETTING_KEYS];
type Tm = ReturnType<typeof mm>;

const r = createRouter({ roles: rolesFor('meta.settings') });
const K = META_SETTING_KEYS;
const ALL_KEYS: readonly Key[] = [K.pixelId, K.consentRequired, K.tokenEnc, K.testEventCode];

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

async function readRows(c: Ctx): Promise<Map<string, unknown>> {
  const rows = await c.var.db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [...ALL_KEYS])).all();
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** The page's view of the stored settings. Decrypts the token only to show its last 4 characters. */
async function loadView(c: Ctx): Promise<MetaView> {
  const rows = await readRows(c);
  const pixel = rows.get(K.pixelId);
  const consent = rows.get(K.consentRequired);
  const code = rows.get(K.testEventCode);
  const enc = rows.get(K.tokenEnc);
  let key: SecretBoxKey | null = null;
  try {
    key = await importSettingsKey(c.env.SETTINGS_ENCRYPTION_KEY);
  } catch {
    key = null;
  }
  let token: MetaView['token'] = { kind: 'absent' };
  if (enc !== undefined) {
    if (key === null) token = { kind: 'locked' };
    else {
      try {
        token = { kind: 'set', hint: metaTokenHint(await openMetaToken(key, enc)) };
      } catch (err) {
        if (!(err instanceof MetaTokenError)) throw err;
        token = { kind: 'unreadable' };
      }
    }
  }
  const keyOk = key !== null;
  return {
    pixelId: isMetaPixelId(pixel) ? pixel : null,
    consentRequired: consent !== false,
    testEventCode: typeof code === 'string' && META_TEST_EVENT_CODE_RE.test(code) ? code : null,
    token,
    keyOk,
  };
}

function render(c: Ctx, view: MetaView, errors?: MetaErrors, values?: Readonly<Record<string, string>>) {
  const tm = mm(c.var.lang);
  return c.render(<MetaPage view={view} errors={errors} values={values ?? {}} tm={tm} />, { title: tm('title') });
}

async function refuse(c: Ctx, status: 409 | 422, errors: MetaErrors, values: Readonly<Record<string, string>>, reason: string) {
  noAudit(c, reason);
  c.status(status);
  return render(c, await loadView(c), errors, values);
}

// ---------------------------------------------------------------------------------------------
// Writes: one batch per request, each changed row next to its audit row
// ---------------------------------------------------------------------------------------------

type Verb = 'set' | 'change' | 'remove';

function upsert(c: Ctx, key: Key, value: unknown) {
  const json = JSON.stringify(value);
  const userId = c.var.user.id;
  // settings.value is JSON text: bind the serialised JSON ourselves (as routes/settings does).
  return c.var.db
    .insert(settings)
    .values({ key, value: sql`${json}`, updatedBy: userId })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`${json}`, updatedBy: userId, updatedAt: Date.now() } });
}

function auditRow(c: Ctx, verb: Verb, key: Key, before: unknown, after: unknown) {
  return audit(c, { action: `metaSettings.${verb}`, entity: 'settings', entityId: key, before, after });
}

async function run(c: Ctx, stmts: ReturnType<typeof upsert | typeof auditRow>[]) {
  await c.var.db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
}

/** Valibot result → per-field route message, never the submitted value. */
function fieldErrors(tm: Tm, issues: readonly v.BaseIssue<unknown>[]): MetaErrors {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const field = v.getDotPath(issue) ?? '_form';
    if (out[field] === undefined) out[field] = tm(issue.message as Parameters<Tm>[0]);
  }
  return out;
}

const digitsOnly = (s: string) => toAsciiDigits(s).trim();

const PixelForm = v.object({
  pixelId: v.pipe(v.optional(v.string(), ''), v.transform(digitsOnly), v.minLength(1, 'err.pixelRequired'), v.check((s: string) => isMetaPixelId(s), 'err.pixelInvalid')),
  consent: v.picklist(['required', 'off'], 'err.consent'),
});

const TokenForm = v.object({
  token: v.pipe(v.optional(v.string(), ''), v.trim(), v.minLength(1, 'err.tokenRequired'), v.regex(/^[\x21-\x7E]{20,1000}$/, 'err.tokenInvalid')),
});

const TestCodeForm = v.object({
  testEventCode: v.pipe(v.optional(v.string(), ''), v.trim(), v.minLength(1, 'err.testRequired'), v.regex(META_TEST_EVENT_CODE_RE, 'err.testInvalid')),
});

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

r.get('/', requirePerm('meta.settings'), async (c) => render(c, await loadView(c)));

r.post('/pixel', requirePerm('meta.settings'), async (c) => {
  const tm = mm(c.var.lang);
  const raw = await readForm(c);
  const f = v.safeParse(PixelForm, raw, { abortPipeEarly: true });
  const echo = { pixelId: raw['pixelId'] ?? '', consent: raw['consent'] ?? '' };
  if (!f.success) return refuse(c, 422, fieldErrors(tm, f.issues), echo, 'meta pixel form refused, nothing written');
  const rows = await readRows(c);
  const stmts: ReturnType<typeof upsert | typeof auditRow>[] = [];
  const pixelBefore = rows.get(K.pixelId);
  if (pixelBefore !== f.output.pixelId) {
    stmts.push(upsert(c, K.pixelId, f.output.pixelId), auditRow(c, rows.has(K.pixelId) ? 'change' : 'set', K.pixelId, pixelBefore ?? null, f.output.pixelId));
  }
  const consent = f.output.consent === 'required';
  const consentBefore = rows.get(K.consentRequired);
  if (consentBefore !== consent) {
    stmts.push(upsert(c, K.consentRequired, consent), auditRow(c, rows.has(K.consentRequired) ? 'change' : 'set', K.consentRequired, consentBefore ?? null, consent));
  }
  if (stmts.length === 0) noAudit(c, 'meta pixel saved without changes: nothing written');
  else await run(c, stmts);
  return c.redirect(withFlash('/meta', 'saved'), 303);
});

r.post('/token', requirePerm('meta.settings'), async (c) => {
  const tm = mm(c.var.lang);
  const raw = await readForm(c);
  const f = v.safeParse(TokenForm, raw, { abortPipeEarly: true });
  // The token is never echoed back, valid or not.
  if (!f.success) return refuse(c, 422, fieldErrors(tm, f.issues), {}, 'meta token form refused, nothing written');
  if (c.env.ENV === 'production' && f.output.token.startsWith('FAKE')) {
    return refuse(c, 422, { token: tm('err.tokenTest') }, {}, 'meta token is a test value, nothing written');
  }
  let key: SecretBoxKey;
  try {
    key = await importSettingsKey(c.env.SETTINGS_ENCRYPTION_KEY);
  } catch {
    return refuse(c, 409, { token: tm('err.noKey') }, {}, 'meta token refused: no encryption key, nothing written');
  }
  const sealed = await sealMetaToken(key, f.output.token);
  const present = (await readRows(c)).has(K.tokenEnc);
  await run(c, [upsert(c, K.tokenEnc, sealed), auditRow(c, present ? 'change' : 'set', K.tokenEnc, { present }, { present: true })]);
  return c.redirect(withFlash('/meta', 'saved'), 303);
});

r.post('/test-code', requirePerm('meta.settings'), async (c) => {
  const tm = mm(c.var.lang);
  const raw = await readForm(c);
  const f = v.safeParse(TestCodeForm, raw, { abortPipeEarly: true });
  if (!f.success) return refuse(c, 422, fieldErrors(tm, f.issues), { testEventCode: raw['testEventCode'] ?? '' }, 'meta test code form refused, nothing written');
  const rows = await readRows(c);
  const before = rows.get(K.testEventCode);
  if (before === f.output.testEventCode) {
    noAudit(c, 'meta test code unchanged: nothing written');
  } else {
    const present = rows.has(K.testEventCode);
    await run(c, [upsert(c, K.testEventCode, f.output.testEventCode), auditRow(c, present ? 'change' : 'set', K.testEventCode, { present }, { present: true })]);
  }
  return c.redirect(withFlash('/meta', 'saved'), 303);
});

/** Deletes one row; the audit row is written only if the row existed, in the same batch. */
function removeRoute(path: string, key: Key, snapshot: (before: unknown) => unknown) {
  r.post(path, requirePerm('meta.settings'), async (c) => {
    const rows = await readRows(c);
    if (!rows.has(key)) {
      noAudit(c, `meta ${key} already absent: nothing written`);
      return c.redirect(withFlash('/meta', 'deleted'), 303);
    }
    await c.var.db.batch([
      audit(
        c,
        { action: 'metaSettings.remove', entity: 'settings', entityId: key, before: snapshot(rows.get(key)), after: null },
        { when: sql`exists (select 1 from settings where key = ${key})` },
      ),
      c.var.db.delete(settings).where(eq(settings.key, key)),
    ]);
    return c.redirect(withFlash('/meta', 'deleted'), 303);
  });
}

removeRoute('/pixel/remove', K.pixelId, (before) => before);
removeRoute('/token/remove', K.tokenEnc, () => ({ present: true }));
removeRoute('/test-code/remove', K.testEventCode, () => ({ present: true }));

export default r;
