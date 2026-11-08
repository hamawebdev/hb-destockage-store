import type { Child } from 'hono/jsx';
import { useUi } from './context.ts';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Status pill: text carries the meaning, colour only reinforces it. */
export function StatusBadge(props: { tone: Tone; label: string }) {
  return <span class={`badge badge--${props.tone}`}>{props.label}</span>;
}

export function EmptyState(props: { children?: Child }) {
  const { t } = useUi();
  return <p class="empty">{props.children ?? t('table.empty')}</p>;
}
