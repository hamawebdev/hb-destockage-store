import type { Child } from 'hono/jsx';
import { useUi } from './context.ts';
import { Icon, type AdminIconName } from './icons.tsx';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Status pill: text carries the meaning, colour only reinforces it. */
export function StatusBadge(props: { tone: Tone; label: string }) {
  return <span class={`badge badge--${props.tone}`}>{props.label}</span>;
}

/** Nothing here yet (or nothing matches). Optional icon, heading and one action. */
export function EmptyState(props: { children?: Child; icon?: AdminIconName; title?: string; action?: Child }) {
  const { t } = useUi();
  return (
    <div class="empty">
      {props.icon ? <span class="empty__icon"><Icon name={props.icon} class="ico--lg" /></span> : null}
      {props.title ? <p class="empty__title">{props.title}</p> : null}
      <p class="empty__text">{props.children ?? t('table.empty')}</p>
      {props.action ?? null}
    </div>
  );
}
