// Error pages (401/403/404/500/503). Never show internals: only a title and the request id.
// Without an authenticated user the page is bilingual (no language preference is known and we
// never negotiate on Accept-Language).
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';
import { translator, type Lang } from '../i18n/index.ts';
import { ASSET } from './assets.ts';

export type ErrorStatus = 401 | 403 | 404 | 500 | 503;

const TITLE_KEY = {
  401: 'error.401.title',
  403: 'error.403.title',
  404: 'error.404.title',
  500: 'error.500.title',
  503: 'error.503.title',
} as const;

function Block(props: { lang: Lang; status: ErrorStatus; requestId: string | undefined; withLink: boolean }) {
  const t = translator(props.lang);
  return (
    <section lang={props.lang} dir={props.lang === 'ar' ? 'rtl' : 'ltr'} class="error-block">
      <h1>{t(TITLE_KEY[props.status])}</h1>
      {props.requestId ? <p class="muted">{t('error.ref')} <bdi dir="ltr">{props.requestId}</bdi></p> : null}
      {props.withLink ? <p><a href="/dashboard">{t('error.back')}</a></p> : null}
    </section>
  );
}

export function renderError(c: Context<AppEnv>, status: ErrorStatus): Response {
  const user = c.get('user') as AppEnv['Variables']['user'] | undefined;
  const requestId = c.get('requestId') as string | undefined;
  const langs: Lang[] = user ? [user.uiLang] : ['fr', 'ar'];
  const first = langs[0]!;
  const withLink = user !== undefined && status !== 503;
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
                <Block lang={l} status={status} requestId={requestId} withLink={withLink} />
              ))}
            </main>
          </body>
        </html>
      ).toString(),
    { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } },
  );
}
