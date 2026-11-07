// Page layout for every authenticated admin page. Handlers call
//   return c.render(<Content />, { title: 'Commandes', breadcrumbs: [...] })
// `variant: 'print'` drops the chrome (order slips).
import type { Child } from 'hono/jsx';
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';
import { Ui, type UiContext } from './context.ts';
import { Flash } from './flash.tsx';
import { activeHref, navFor } from './nav.ts';
import { ASSET } from './assets.ts';

export interface Crumb {
  label: string;
  href?: string;
}

export interface PageProps {
  title: string;
  breadcrumbs?: readonly Crumb[];
  /** Page-level action buttons/links shown next to the title. */
  actions?: Child;
  variant?: 'default' | 'print';
}

declare module 'hono' {
  interface ContextRenderer {
    (content: Child, props: PageProps): Response | Promise<Response>;
  }
}

export const LOGOUT_URL = '/cdn-cgi/access/logout';

function Head(props: { title: string; appName: string; variant: 'default' | 'print' }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="same-origin" />
      <title>{`${props.title} · ${props.appName}`}</title>
      <link rel="stylesheet" href={ASSET.tokens} />
      <link rel="stylesheet" href={ASSET.css} />
      <link rel="stylesheet" href={ASSET.print} media={props.variant === 'print' ? 'all' : 'print'} />
      <script src={ASSET.js} defer></script>
    </head>
  );
}

function Nav(props: { ui: UiContext }) {
  const { ui } = props;
  if (!ui.user) return null;
  const groups = navFor(ui.user);
  const current = activeHref(ui.path, groups.flatMap((g) => g.items));
  return (
    <nav class="nav" aria-label={ui.t('nav.label')}>
      {groups.map((g) => (
        <ul class="nav__group">
          {g.items.map((i) => (
            <li>
              <a class="nav__link" href={i.href} aria-current={i.href === current ? 'page' : undefined}>
                {ui.t(i.label)}
              </a>
            </li>
          ))}
        </ul>
      ))}
    </nav>
  );
}

function TopBar(props: { ui: UiContext }) {
  const { ui } = props;
  const other = ui.lang === 'fr' ? 'ar' : 'fr';
  return (
    <header class="topbar">
      <a class="topbar__brand" href="/dashboard">{ui.t('app.name')}</a>
      {ui.user ? (
        <div class="topbar__user">
          <span class="topbar__who">
            {ui.t('user.signedInAs')} <bdi dir="ltr">{ui.user.email}</bdi>
          </span>
          <form method="post" action="/settings/language" class="inline-form">
            <input type="hidden" name="_csrf" value={ui.csrfToken} />
            <input type="hidden" name="lang" value={other} />
            <input type="hidden" name="return_to" value={ui.path} />
            {/* No aria-label: the accessible name must contain the visible text (WCAG 2.5.3,
                review ADMIN-1 r1 F3); the explanation is appended as visually hidden text. */}
            <button type="submit" class="btn btn--quiet">
              <span lang={other}>{ui.t('lang.switch')}</span>
              <span class="visually-hidden"> — {ui.t('lang.switchLabel')}</span>
            </button>
          </form>
          <a class="btn btn--quiet" href={LOGOUT_URL}>{ui.t('user.logout')}</a>
        </div>
      ) : null}
    </header>
  );
}

export function Layout(props: PageProps & { ui: UiContext; flash: string | undefined; children: Child }) {
  const { ui } = props;
  const variant = props.variant ?? 'default';
  return (
    <html lang={ui.lang} dir={ui.dir}>
      <Head title={props.title} appName={ui.t('app.name')} variant={variant} />
      <body class={variant === 'print' ? 'page page--print' : 'page'}>
        <Ui.Provider value={ui}>
          {variant === 'print' ? (
            <main id="main">{props.children}</main>
          ) : (
            <>
              <a class="skip-link" href="#main">{ui.t('app.skip')}</a>
              <TopBar ui={ui} />
              {/* Closed in the HTML: on phones the menu does not push the page down (main starts
                  under the top bar). From 768 px the nav is always shown (admin.css
                  ::details-content; admin.js opens it as a fallback). */}
              <details class="nav-disclosure">
                <summary class="nav-disclosure__summary">{ui.t('nav.menu')}</summary>
                <Nav ui={ui} />
              </details>
              <main id="main" class="main" tabindex={-1}>
                {props.breadcrumbs && props.breadcrumbs.length > 0 ? (
                  <nav class="breadcrumbs" aria-label={ui.t('nav.breadcrumbs')}>
                    <ol>
                      {props.breadcrumbs.map((b) => (
                        <li>{b.href ? <a href={b.href}>{b.label}</a> : <span aria-current="page">{b.label}</span>}</li>
                      ))}
                    </ol>
                  </nav>
                ) : null}
                <div class="page-head">
                  <h1 class="page-head__title">{props.title}</h1>
                  {props.actions ? <div class="page-head__actions">{props.actions}</div> : null}
                </div>
                <Flash code={props.flash} />
                {props.children}
              </main>
            </>
          )}
        </Ui.Provider>
      </body>
    </html>
  );
}

export function uiContextOf(c: Context<AppEnv>): UiContext {
  return {
    lang: c.var.lang,
    dir: c.var.dir,
    t: c.var.t,
    csrfToken: c.var.csrfToken,
    user: c.var.user,
    path: c.req.path,
  };
}

/** Ids that occur more than once in an HTML document (kit guard, dev/test only). */
export function duplicateIds(html: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    const id = m[1]!;
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}

export class DuplicateIdError extends Error {
  override name = 'DuplicateIdError';
}

/** Installs `c.render` for the request. */
export function setLayoutRenderer(c: Context<AppEnv>): void {
  c.setRenderer(async (content, props) => {
    const page = (
      <Layout {...props} ui={uiContextOf(c)} flash={c.req.query('m')}>
        {content}
      </Layout>
    );
    if (c.env.ENV === 'production') return c.html(page);
    // Development and tests: a page with duplicate ids (e.g. a form repeated per row without
    // idSuffix) breaks label/for and aria links. Fail loudly so it never ships.
    const html = (await page.toString()).toString();
    const dups = duplicateIds(html);
    if (dups.length > 0) throw new DuplicateIdError(`duplicate id(s) on ${c.req.path}: ${dups.slice(0, 5).join(', ')} (use idSuffix)`);
    return c.html(html);
  });
}
