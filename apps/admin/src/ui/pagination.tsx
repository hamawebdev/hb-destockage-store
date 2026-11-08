// Link-based pagination. Offset (`?page=`) for small tables; keyset (`?after=<at>.<id>`) for
// large, append-heavy ones (orders, audit log).
import { useUi } from './context.ts';

/** Replaces/sets one query parameter on a site-relative URL. */
export function hrefWith(baseUrl: string, key: string, value: string | undefined): string {
  const u = new URL(baseUrl, 'http://x');
  if (value === undefined) u.searchParams.delete(key);
  else u.searchParams.set(key, value);
  u.searchParams.delete('m');
  const q = u.searchParams.toString();
  return `${u.pathname}${q ? `?${q}` : ''}`;
}

export function Pagination(props: { page: number; pages: number; baseUrl: string }) {
  const { t } = useUi();
  if (props.pages <= 1) return null;
  const prev = props.page > 1 ? hrefWith(props.baseUrl, 'page', String(props.page - 1)) : undefined;
  const next = props.page < props.pages ? hrefWith(props.baseUrl, 'page', String(props.page + 1)) : undefined;
  return (
    <nav class="pagination" aria-label={t('pagination.label')}>
      {prev ? <a class="btn btn--secondary" rel="prev" href={prev}>{t('pagination.prev')}</a> : null}
      <span class="pagination__status">{t('pagination.page', { page: props.page, pages: props.pages })}</span>
      {next ? <a class="btn btn--secondary" rel="next" href={next}>{t('pagination.next')}</a> : null}
    </nav>
  );
}

/** Keyset pagination: "first page" and "next" only (cursors are not reversible cheaply). */
export function CursorPagination(props: { next: string | null; baseUrl: string; isFirst: boolean }) {
  const { t } = useUi();
  if (props.isFirst && props.next === null) return null;
  return (
    <nav class="pagination" aria-label={t('pagination.label')}>
      {!props.isFirst ? <a class="btn btn--secondary" href={hrefWith(props.baseUrl, 'after', undefined)}>{t('pagination.first')}</a> : null}
      {props.next !== null ? <a class="btn btn--secondary" rel="next" href={hrefWith(props.baseUrl, 'after', props.next)}>{t('pagination.next')}</a> : null}
    </nav>
  );
}
