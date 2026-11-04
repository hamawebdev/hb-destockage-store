// Data table. Columns are declared once; cells render JSX. Sorting is link-based (GET) and
// optional. On narrow screens the table scrolls inside a focusable, labelled region.
import type { Child } from 'hono/jsx';
import { useUi } from './context.ts';
import { EmptyState } from './badge.tsx';

export interface Column<Row> {
  key: string;
  header: string;
  cell: (row: Row) => Child;
  /** Right-align numbers in LTR / left in RTL (logical `end`). */
  numeric?: boolean;
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
}) {
  const { t } = useUi();
  if (props.rows.length === 0) return <EmptyState>{props.empty}</EmptyState>;
  return (
    <div class="table-wrap" role="region" aria-label={`${props.caption} — ${t('table.scrollHint')}`} tabindex={0}>
      <table class="table">
        <caption class="table__caption">{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((col) => (
              <th scope="col" class={col.numeric ? 'num' : undefined} aria-sort={col.sort}>
                {col.sortHref ? <a href={col.sortHref}>{col.header}</a> : col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr data-key={String(props.rowKey(row))}>
              {props.columns.map((col) => (
                <td class={col.numeric ? 'num' : undefined}>{col.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
