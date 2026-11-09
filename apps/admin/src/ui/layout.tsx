// Page layout for every authenticated admin page. Handlers call
//   return c.render(<Content />, { title: 'Commandes', breadcrumbs: [...] })
// `variant: 'print'` drops the chrome (order slips).
//
// Shell: a sidebar from 1024 px. Below that a top bar opens the same sidebar as a drawer (native
// `popover`, no JS needed) and a bottom tab bar keeps the role's four main destinations in reach.
import type { Child } from 'hono/jsx';
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';
import { Ui, type UiContext } from './context.ts';
import { Flash } from './flash.tsx';
import { Icon } from './icons.tsx';
import { activeHref, navFor, tabsFor, type NavItem } from './nav.ts';
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
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="same-origin" />
      <title>{`${props.title} · ${props.appName}`}</title>
      <link rel="icon" href={ASSET.monogram} type="image/svg+xml" />
      <link rel="stylesheet" href={ASSET.tokens} />
      <link rel="stylesheet" href={ASSET.css} />
      <link rel="stylesheet" href={ASSET.print} media={props.variant === 'print' ? 'all' : 'print'} />
      <script src={ASSET.js} defer></script>
    </head>
  );
}

function NavRow(props: { ui: UiContext; item: NavItem; current: string | undefined; sub?: boolean }) {
  const { item, ui } = props;
  return (
    <a class={props.sub ? 'nav__link nav__link--sub' : 'nav__link'} href={item.href} aria-current={item.href === props.current ? 'page' : undefined}>
      {props.sub ? null : <Icon name={item.icon} />}
      <span class="nav__label">{ui.t(item.label)}</span>
    </a>
  );
}

function Nav(props: { ui: UiContext }) {
  const { ui } = props;
  if (!ui.user) return null;
  const groups = navFor(ui.user);
  const all = groups.flatMap((g) => g.items);
  const current = activeHref(ui.path, all);
  const hrefs = new Set(all.map((i) => i.href));
  return (
    <nav class="nav" aria-label={ui.t('nav.label')}>
      {groups.map((g) => (
        <ul class="nav__group">
          {g.items
            .filter((i) => i.parent === undefined || !hrefs.has(i.parent))
            .map((i) => {
              const kids = g.items.filter((k) => k.parent === i.href);
              const inSection = i.href === current || kids.some((k) => k.href === current);
              return (
                <li class="nav__item">
                  <NavRow ui={ui} item={i} current={current} />
                  {kids.length > 0 ? (
                    <details class="nav__more" open={inSection}>
                      <summary class="nav__toggle">
                        <span class="visually-hidden">{ui.t('nav.more', { label: ui.t(i.label) })}</span>
                        <Icon name="chevron-down" class="ico--sm" />
                      </summary>
                      <ul class="nav__sub">
                        {kids.map((k) => (
                          <li>
                            <NavRow ui={ui} item={k} current={current} sub />
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
        </ul>
      ))}
    </nav>
  );
}

function Brand(props: { ui: UiContext }) {
  return (
    <a class="brand" href="/dashboard">
      <img class="brand__mark" src={ASSET.monogram} width="32" height="32" alt="" />
      <span class="brand__name"><bdi lang="fr" dir="ltr">HB Destockage</bdi></span>
      <span class="visually-hidden">{props.ui.t('app.name')}</span>
    </a>
  );
}

/** Sidebar footer: who is signed in, language, logout. */
function SideFoot(props: { ui: UiContext }) {
  const { ui } = props;
  if (!ui.user) return null;
  const other = ui.lang === 'fr' ? 'ar' : 'fr';
  return (
    <div class="side__foot">
      <p class="who">
        <span class="visually-hidden">{ui.t('user.signedInAs')} </span>
        <span class="who__mail"><bdi dir="ltr">{ui.user.email}</bdi></span>
        <span class="who__role">{ui.t(`role.${ui.user.role}`)}</span>
      </p>
      <div class="side__actions">
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
    </div>
  );
}

function TabBar(props: { ui: UiContext }) {
  const { ui } = props;
  if (!ui.user) return null;
  const groups = navFor(ui.user);
  const current = activeHref(ui.path, groups.flatMap((g) => g.items));
  return (
    <nav class="tabbar" aria-label={ui.t('nav.tabs')}>
      {tabsFor(groups).map((i) => (
        <a class="tabbar__item" href={i.href} aria-current={i.href === current ? 'page' : undefined}>
          <Icon name={i.icon} />
          <span class="tabbar__label">{ui.t(i.tabLabel ?? i.label)}</span>
        </a>
      ))}
      <button type="button" class="tabbar__item" popovertarget="side">
        <Icon name="menu" />
        <span class="tabbar__label">{ui.t('nav.menu')}</span>
      </button>
    </nav>
  );
}

/** The styled confirm dialog admin.js opens for `data-confirm` forms (no JS: forms submit directly). */
function ConfirmDialog(props: { ui: UiContext }) {
  const { t } = props.ui;
  return (
    <dialog class="dialog" id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-text">
      <h2 class="dialog__title" id="confirm-title">{t('dialog.title')}</h2>
      <p id="confirm-text" class="dialog__text"></p>
      <form method="dialog" class="dialog__actions">
        <button type="submit" class="btn btn--secondary" value="cancel">{t('dialog.cancel')}</button>
        <button type="submit" class="btn btn--primary" value="ok">{t('dialog.ok')}</button>
      </form>
    </dialog>
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
              <header class="topbar">
                <Brand ui={ui} />
                {ui.user ? (
                  <button type="button" class="btn btn--quiet btn--icon" popovertarget="side">
                    <Icon name="menu" />
                    <span class="visually-hidden">{ui.t('nav.menu')}</span>
                  </button>
                ) : null}
              </header>
              <aside class="side" id="side" popover="auto">
                <div class="side__head">
                  <Brand ui={ui} />
                  <button type="button" class="btn btn--quiet btn--icon side__close" popovertarget="side" popovertargetaction="hide">
                    <Icon name="close" />
                    <span class="visually-hidden">{ui.t('nav.close')}</span>
                  </button>
                </div>
                <Nav ui={ui} />
                <SideFoot ui={ui} />
              </aside>
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
              <TabBar ui={ui} />
              <ConfirmDialog ui={ui} />
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
