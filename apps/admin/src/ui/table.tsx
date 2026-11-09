// Data table. Columns are declared once; cells render JSX. Sorting is link-based (GET) and
// optional. On narrow screens the table scrolls inside a focusable, labelled region, or stacks
// into cards with `stack`.
import type { Child } from 'hono/jsx';
import { useUi } from './context.ts';
import { EmptyState } from './badge.tsx';
import type { AdminIconName } from './icons.tsx';

export interface Column<Row> {
  key: string;
  header: Child;
  /** Plain-text header for the stacked card label, when `header` is not a string. */
  label?: string;
  cell: (row: Row) => Child;
  /** Right-align numbers in LTR / left in RTL (logical `end`). */
  numeric?: boolean;
  /** Extra class on the column's cells (e.g. to place them in a stacked card). */
  class?: string;
  /** When set, the header is a link to this URL (current sort shown via aria-sort). */
  sortHref?: string;
  sort?: 'ascending' | 'descending';
}

export function Table<Row>(props: {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string | number;
  empty?: Child;
  emptyIcon?: AdminIconName;
  emptyAction?: Child;
  /** Below 600 px, show each row as a card of label/value pairs (CSS only, `.tbl-stack`). */
  stack?: boolean;
  /** Extra classes on the <table>. `table--rows` makes the row's `.row-link` cover the row. */
  class?: string;
}) {
  const { t } = useUi();
  if (props.rows.length === 0) {
    return (
      <EmptyState {...(props.emptyIcon ? { icon: props.emptyIcon } : {})} {...(props.emptyAction ? { action: props.emptyAction } : {})}>
        {props.empty}
      </EmptyState>
    );
  }
  const classes = ['table', props.stack ? 'tbl-stack' : '', props.class ?? ''].filter(Boolean).join(' ');
  const cellClass = (col: Column<Row>) => [col.numeric ? 'num' : '', col.class ?? ''].filter(Boolean).join(' ') || undefined;
  const label = (col: Column<Row>) => col.label ?? (typeof col.header === 'string' ? col.header : '');
  return (
    <div class="table-wrap" role="region" aria-label={`${props.caption} — ${t('table.scrollHint')}`} tabindex={0}>
      <table class={classes}>
        <caption class="table__caption">{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((col) => (
              <th scope="col" class={cellClass(col)} aria-sort={col.sort}>
                {col.sortHref ? <a href={col.sortHref}>{col.header}</a> : col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr data-key={String(props.rowKey(row))}>
              {props.columns.map((col) => (
                <td class={cellClass(col)} data-label={label(col)}>{col.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
