// Error pages (401/403/404/413/415/500/503). Never show internals: only a title and the request id.
// Without an authenticated user the page is bilingual (no language preference is known and we
// never negotiate on Accept-Language).
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';
import { translator, type Lang } from '../i18n/index.ts';
import { ASSET } from './assets.ts';
import { isDevAuthAllowed } from '../auth/dev-gate.ts';
import { safeReturnPath } from '../lib/redirect.ts';

export type ErrorStatus = 401 | 403 | 404 | 413 | 415 | 500 | 503;

/** Optional explanation under the title (never user input). */
export type ErrorDetail = 'csrf';

const TITLE_KEY = {
  401: 'error.401.title',
  403: 'error.403.title',
  404: 'error.404.title',
  413: 'error.413.title',
  415: 'error.415.title',
  500: 'error.500.title',
  503: 'error.503.title',
} as const;

function Block(props: { lang: Lang; status: ErrorStatus; requestId: string | undefined; withLink: boolean; detail: ErrorDetail | undefined; reloadHref: string | undefined }) {
  const t = translator(props.lang);
  return (
    <section lang={props.lang} dir={props.lang === 'ar' ? 'rtl' : 'ltr'} class="error-block">
      <h1>{t(TITLE_KEY[props.status])}</h1>
      {props.detail === 'csrf' ? <p>{t('error.csrf')}</p> : null}
      {props.reloadHref ? <p><a href={props.reloadHref}>{t('error.reload')}</a></p> : null}
      {props.requestId ? <p class="muted">{t('error.ref')} <bdi dir="ltr">{props.requestId}</bdi></p> : null}
      {props.withLink ? <p><a href="/dashboard">{t('error.back')}</a></p> : null}
    </section>
  );
}

export function renderError(c: Context<AppEnv>, status: ErrorStatus, detail?: ErrorDetail): Response {
  const user = c.get('user') as AppEnv['Variables']['user'] | undefined;
  const requestId = c.get('requestId') as string | undefined;
  const langs: Lang[] = user ? [user.uiLang] : ['fr', 'ar'];
  const first = langs[0]!;
  const withLink = user !== undefined && status !== 503;
  // After a refused form POST, offer to reload the page the form came from (same-site path only).
  const reloadHref = detail === 'csrf' ? sameSiteReferer(c) : undefined;
  // A fresh Response, not c.html(): headers set on the context earlier (Location from a
  // redirect, Set-Cookie, …) must never reach an error page. Security headers are added by the
  // outermost middleware.
  return new Response(
    '<!doctype html>' +
      (
        <html lang={first} dir={first === 'ar' ? 'rtl' : 'ltr'}>
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="robots" content="noindex, nofollow" />
            <title>{String(status)}</title>
            {user ? <link rel="stylesheet" href={ASSET.tokens} /> : null}
            {user ? <link rel="stylesheet" href={ASSET.css} /> : null}
          </head>
          <body class="page page--error">
            <main id="main">
              {langs.map((l) => (
                <Block lang={l} status={status} requestId={requestId} withLink={withLink} detail={detail} reloadHref={reloadHref} />
              ))}
              {status === 401 && isDevAuthAllowed(c) ? (
                <p><a href="/__dev/login">Dev login (local only)</a></p>
              ) : null}
            </main>
          </body>
        </html>
      ).toString(),
    { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } },
  );
}

export function sameSiteReferer(c: Context<AppEnv>): string | undefined {
  const ref = c.req.header('Referer');
  if (!ref) return undefined;
  try {
    const u = new URL(ref);
    if (u.origin !== new URL(c.req.url).origin) return undefined;
    // Review ADMIN-3 r1 nit: a path like "//evil.example/x" would become a protocol-relative link.
    const path = safeReturnPath(`${u.pathname}${u.search}`);
    return path === '/' && u.pathname !== '/' ? undefined : path;
  } catch {
    return undefined;
  }
}
