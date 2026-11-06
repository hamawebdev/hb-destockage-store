// Settings (admin-core): per-user UI language (every role) and store settings (owner, ADMIN-5).
import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { adminUsers } from '@hb/db';
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { noAudit, withAudit } from '../../audit/audit.ts';
import { LANGS } from '../../i18n/index.ts';
import { parseForm, vPicklist } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { renderError } from '../../ui/error-page.tsx';

const r = createRouter({ roles: rolesFor('self.lang') });

r.get('/', requirePerm('settings.edit'), (c) =>
  c.render(<p>{c.var.t('common.comingSoon')}</p>, { title: c.var.t('nav.settings') }),
);

const LanguageForm = v.object({
  lang: vPicklist(LANGS),
  return_to: v.optional(v.string(), '/'),
});

/** Same-site path only (no scheme, no `//host`, no backslashes). */
export function safeReturnPath(p: string): string {
  return /^\/(?![/\\])[^\s\\]*$/.test(p) && p.length <= 512 ? p : '/';
}

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

export default r;
