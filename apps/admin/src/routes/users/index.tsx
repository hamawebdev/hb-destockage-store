// Users and roles (ADMIN-4, owner only): list, create, edit (name, email, role, active, UI
// language), delete. Every change is audited in the same D1 batch. The last ACTIVE owner can
// never be demoted, deactivated or deleted: the guard is evaluated inside the batch (D1 runs
// batches one at a time), so two concurrent demotions of the last two owners cannot both pass.
import { and, asc, count, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import * as v from 'valibot';
import { ADMIN_ROLES, adminUsers, type AdminUser } from '@hb/db';
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { audit, noAudit } from '../../audit/audit.ts';
import type { AppEnv, Role } from '../../env.ts';
import { LANGS, type Lang } from '../../i18n/index.ts';
import { paramId, readForm, validateForm, vCheckbox, vEmail, vPicklist, vText } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { renderError } from '../../ui/error-page.tsx';
import { withFlash } from '../../ui/flash.tsx';
import { Checkbox, ErrorSummary, Form, FormActions, Select, Submit, TextInput, type FieldErrors, type FormValues } from '../../ui/form.tsx';
import { Bdi, DateTime } from '../../ui/format.tsx';
import { Table, type Column } from '../../ui/table.tsx';

const r = createRouter({ roles: rolesFor('users.manage') });

export const UserForm = v.object({
  email: vEmail(),
  name: vText(120),
  role: vPicklist(ADMIN_ROLES),
  active: vCheckbox(),
  ui_lang: vPicklist(LANGS),
});
type UserInput = v.InferOutput<typeof UserForm>;

type Row = Pick<AdminUser, 'id' | 'email' | 'name' | 'role' | 'active' | 'uiLang' | 'createdAt' | 'updatedAt'>;

const SNAPSHOT = (u: Pick<AdminUser, 'email' | 'name' | 'role' | 'active' | 'uiLang'>) => ({
  email: u.email,
  name: u.name,
  role: u.role,
  active: u.active,
  uiLang: u.uiLang,
});

/** SQL: another active owner exists besides `id`. */
export function otherActiveOwner(id: number): SQL {
  return sql`exists (select 1 from admin_users where role = 'owner' and active = 1 and id <> ${id})`;
}

/** True when the change takes away an active owner (demotion, deactivation or deletion). */
export function removesActiveOwner(before: Pick<AdminUser, 'role' | 'active'>, after: Pick<AdminUser, 'role' | 'active'> | null): boolean {
  const wasOwner = before.role === 'owner' && before.active;
  const staysOwner = after !== null && after.role === 'owner' && after.active;
  return wasOwner && !staysOwner;
}

async function loadUser(c: Context<AppEnv>, id: number): Promise<Row | undefined> {
  return c.var.db
    .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, role: adminUsers.role, active: adminUsers.active, uiLang: adminUsers.uiLang, createdAt: adminUsers.createdAt, updatedAt: adminUsers.updatedAt })
    .from(adminUsers)
    .where(eq(adminUsers.id, id))
    .get();
}

async function emailTaken(c: Context<AppEnv>, email: string, exceptId?: number): Promise<boolean> {
  const cond = exceptId === undefined ? eq(adminUsers.email, email) : and(eq(adminUsers.email, email), ne(adminUsers.id, exceptId));
  const row = await c.var.db.select({ n: count() }).from(adminUsers).where(cond).get();
  return (row?.n ?? 0) > 0;
}

function roleOptions(c: Context<AppEnv>) {
  return ADMIN_ROLES.map((role) => ({ value: role, label: c.var.t(`role.${role}` as const) }));
}
function langOptions(c: Context<AppEnv>) {
  return LANGS.map((l) => ({ value: l, label: c.var.t(l === 'fr' ? 'common.fr' : 'common.ar') }));
}

function UserFields(props: { c: Context<AppEnv>; values: FormValues; errors: FieldErrors | undefined; isNew: boolean }) {
  const { c, values, errors } = props;
  const t = c.var.t;
  return (
    <>
      <ErrorSummary errors={errors} labels={{ email: t('users.email'), name: t('users.name'), role: t('users.role'), ui_lang: t('users.uiLang') }} />
      <div class="callout callout--warning">
        <p><strong>{t('users.accessNote.lead')}</strong> {t('users.accessNote')}</p>
      </div>
      <TextInput name="email" type="email" label={t('users.email')} value={values['email']} error={errors?.['email']} required dir="ltr" maxlength={254} autocomplete="off" />
      <TextInput name="name" label={t('users.name')} value={values['name']} error={errors?.['name']} required maxlength={120} dir="auto" />
      <Select name="role" label={t('users.role')} value={values['role']} options={roleOptions(c)} error={errors?.['role']} required hint={t('users.roleHint')} />
      <Select name="ui_lang" label={t('users.uiLang')} value={values['ui_lang'] ?? 'fr'} options={langOptions(c)} error={errors?.['ui_lang']} />
      <Checkbox name="active" label={t('users.active')} checked={props.isNew ? values['active'] !== '0' : values['active'] === '1'} hint={t('users.activeHint')} />
    </>
  );
}

function valuesOf(u: Row): FormValues {
  return { email: u.email, name: u.name, role: u.role, ui_lang: u.uiLang, active: u.active ? '1' : '0' };
}

// ---------------------------------------------------------------------------------------------

r.get('/', requirePerm('users.manage'), async (c) => {
  const t = c.var.t;
  const rows = await c.var.db
    .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, role: adminUsers.role, active: adminUsers.active, uiLang: adminUsers.uiLang, createdAt: adminUsers.createdAt, updatedAt: adminUsers.updatedAt })
    .from(adminUsers)
    .orderBy(asc(adminUsers.email))
    .all();
  const columns: Column<Row>[] = [
    { key: 'email', header: t('users.email'), cell: (u) => <Bdi>{u.email}</Bdi> },
    { key: 'name', header: t('users.name'), cell: (u) => <bdi>{u.name}</bdi> },
    { key: 'role', header: t('users.role'), cell: (u) => t(`role.${u.role}` as const) },
    { key: 'active', header: t('users.status'), cell: (u) => (u.active ? <StatusBadge tone="success" label={t('users.active')} /> : <StatusBadge tone="neutral" label={t('users.inactive')} />) },
    { key: 'lang', header: t('users.uiLang'), cell: (u) => t(u.uiLang === 'fr' ? 'common.fr' : 'common.ar') },
    { key: 'updated', header: t('users.updated'), cell: (u) => <DateTime ms={u.updatedAt} /> },
    { key: 'edit', header: t('common.actions'), cell: (u) => <a href={`/users/${u.id}/edit`}>{t('common.edit')} <span class="visually-hidden"><bdi dir="ltr">{u.email}</bdi></span></a> },
  ];
  return c.render(<Table caption={t('nav.users')} columns={columns} rows={rows} rowKey={(u) => u.id} />, {
    title: t('nav.users'),
    actions: <a class="btn btn--primary" href="/users/new">{t('users.new')}</a>,
  });
});

function renderNew(c: Context<AppEnv>, values: FormValues, errors?: FieldErrors) {
  const t = c.var.t;
  return c.render(
    <Form action="/users">
      <UserFields c={c} values={values} errors={errors} isNew />
      <FormActions>
        <Submit>{t('common.create')}</Submit>
        <a class="btn btn--secondary" href="/users">{t('common.cancel')}</a>
      </FormActions>
    </Form>,
    { title: t('users.new'), breadcrumbs: [{ label: t('nav.users'), href: '/users' }, { label: t('users.new') }] },
  );
}

r.get('/new', requirePerm('users.manage'), (c) => renderNew(c, { active: '1', ui_lang: 'fr', role: 'confirmer' }));

r.post('/', requirePerm('users.manage'), async (c) => {
  const raw = await readForm(c);
  const f = validateForm(c, UserForm, raw);
  if (!f.ok) {
    c.status(422);
    return renderNew(c, { ...raw, active: raw['active'] ? '1' : '0' }, f.errors);
  }
  const d: UserInput = f.data;
  if (await emailTaken(c, d.email)) {
    c.status(422);
    return renderNew(c, { ...raw, active: d.active ? '1' : '0' }, { email: c.var.t('users.emailTaken') });
  }
  const after = { email: d.email, name: d.name, role: d.role, active: d.active, uiLang: d.ui_lang };
  await c.var.db.batch([
    c.var.db.insert(adminUsers).values({ email: d.email, name: d.name, role: d.role, active: d.active, uiLang: d.ui_lang }),
    audit(c, { action: 'adminUser.create', entity: 'admin_users', entityId: sql`(select id from admin_users where email = ${d.email})`, before: null, after }),
  ]);
  return c.redirect(withFlash('/users', 'created'), 303);
});

function renderEdit(c: Context<AppEnv>, u: Row, values: FormValues, errors?: FieldErrors) {
  const t = c.var.t;
  return c.render(
    <>
      <Form action={`/users/${u.id}`}>
        <UserFields c={c} values={values} errors={errors} isNew={false} />
        <FormActions>
          <Submit>{t('common.save')}</Submit>
          <a class="btn btn--secondary" href="/users">{t('common.cancel')}</a>
        </FormActions>
      </Form>
      <section class="panel">
        <h2>{t('users.deleteTitle')}</h2>
        <p>{t('users.deleteHint')}</p>
        <Form action={`/users/${u.id}/delete`} confirm={t('users.deleteConfirm', { email: u.email })}>
          <Submit variant="danger">{t('common.delete')}</Submit>
        </Form>
      </section>
    </>,
    { title: t('users.editTitle'), breadcrumbs: [{ label: t('nav.users'), href: '/users' }, { label: u.email }] },
  );
}

r.get('/:id/edit', requirePerm('users.manage'), async (c) => {
  const id = paramId(c);
  const u = id === null ? undefined : await loadUser(c, id);
  if (!u) return renderError(c, 404);
  return renderEdit(c, u, valuesOf(u));
});

r.post('/:id', requirePerm('users.manage'), async (c) => {
  const id = paramId(c);
  const u = id === null ? undefined : await loadUser(c, id);
  if (!u) return renderError(c, 404);
  const raw = await readForm(c);
  const f = validateForm(c, UserForm, raw);
  const shown = { ...raw, active: raw['active'] ? '1' : '0' };
  if (!f.ok) {
    c.status(422);
    return renderEdit(c, u, shown, f.errors);
  }
  const d = f.data;
  if (d.email !== u.email && (await emailTaken(c, d.email, u.id))) {
    c.status(422);
    return renderEdit(c, u, shown, { email: c.var.t('users.emailTaken') });
  }
  const before = SNAPSHOT(u);
  const after = { email: d.email, name: d.name, role: d.role as Role, active: d.active, uiLang: d.ui_lang as Lang };
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return noChange(c);
  }
  const guard = removesActiveOwner(u, after) ? otherActiveOwner(u.id) : undefined;
  const results = await c.var.db.batch([
    audit(c, { action: 'adminUser.update', entity: 'admin_users', entityId: u.id, before, after }, guard ? { when: guard } : {}),
    c.var.db
      .update(adminUsers)
      .set({ email: d.email, name: d.name, role: d.role, active: d.active, uiLang: d.ui_lang })
      .where(guard ? and(eq(adminUsers.id, u.id), guard) : eq(adminUsers.id, u.id)),
  ]);
  if (changes(results[1]) === 0) {
    c.status(409);
    return renderEdit(c, u, shown, { role: c.var.t('users.lastOwner') });
  }
  return c.redirect(withFlash('/users', 'saved'), 303);
});

function noChange(c: Context<AppEnv>) {
  noAudit(c, 'user saved without changes: nothing written');
  return c.redirect(withFlash('/users', 'saved'), 303);
}

r.post('/:id/delete', requirePerm('users.manage'), async (c) => {
  const id = paramId(c);
  const u = id === null ? undefined : await loadUser(c, id);
  if (!u) return renderError(c, 404);
  const guard = removesActiveOwner(u, null) ? otherActiveOwner(u.id) : undefined;
  let results: unknown[];
  try {
    results = await c.var.db.batch([
      audit(c, { action: 'adminUser.delete', entity: 'admin_users', entityId: u.id, before: SNAPSHOT(u), after: null }, guard ? { when: guard } : {}),
      c.var.db.delete(adminUsers).where(guard ? and(eq(adminUsers.id, u.id), guard) : eq(adminUsers.id, u.id)),
    ]);
  } catch (err) {
    // FOREIGN KEY (audit_log / order_events / … reference this user): history must stay
    // attributable, so the account can only be deactivated. The batch rolled back as a whole.
    if (/FOREIGN KEY/i.test(String(err))) {
      c.status(409);
      return renderEdit(c, u, valuesOf(u), { role: c.var.t('users.hasHistory') });
    }
    throw err;
  }
  if (changes(results[1]) === 0) {
    c.status(409);
    return renderEdit(c, u, valuesOf(u), { role: c.var.t('users.lastOwner') });
  }
  return c.redirect(withFlash('/users', 'deleted'), 303);
});

/** Rows changed by a D1 run result inside a batch. */
function changes(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | undefined)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

export default r;
