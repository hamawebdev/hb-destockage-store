// Page-level pieces shared by the work screens: tabs with counts, stat strip, filter chips, cards,
// the bulk bar. Server-rendered; CSS does the showing and hiding, admin.js only refines it.
import type { Child } from 'hono/jsx';
import { useUi } from './context.ts';
import { Icon, type AdminIconName } from './icons.tsx';

export interface TabItem {
  href: string;
  label: string;
  count?: number;
  current?: boolean;
}

/** Link tabs. The current one carries aria-current, so colour is never the only cue. */
export function Tabs(props: { label: string; items: readonly TabItem[] }) {
  return (
    <nav class="tabs" aria-label={props.label}>
      {props.items.map((i) => (
        <a class="tab" href={i.href} aria-current={i.current ? 'page' : undefined}>
          {i.label}
          {i.count !== undefined ? <span class="tab__count">{String(i.count)}</span> : null}
        </a>
      ))}
    </nav>
  );
}

export interface StatItem {
  label: string;
  value: Child;
  sub?: string;
}

export function Stats(props: { items: readonly StatItem[] }) {
  return (
    <div class="stats">
      {props.items.map((s) => (
        <div class="stat">
          <p class="stat__label">{s.label}</p>
          <p class="stat__value">{s.value}</p>
          {s.sub ? <p class="stat__sub">{s.sub}</p> : null}
        </div>
      ))}
    </div>
  );
}

/** The large search field at the top of a list (inside a GET form). */
export function SearchField(props: { name: string; label: string; placeholder: string; value: string; maxlength?: number }) {
  const id = `f-${props.name}`;
  return (
    <div class="search">
      <label class="visually-hidden" for={id}>{props.label}</label>
      <Icon name="search" />
      <input id={id} class="input" type="search" name={props.name} value={props.value} placeholder={props.placeholder} maxlength={props.maxlength} dir="auto" autocomplete="off" />
    </div>
  );
}

/** One filter in the chip row: a disclosure whose fields belong to the surrounding GET form. */
export function FilterChip(props: { label: string; value?: string | undefined; wide?: boolean; apply: string; children: Child }) {
  const on = props.value !== undefined && props.value !== '';
  return (
    <details class={on ? 'chip chip--on' : 'chip'}>
      <summary class="chip__summary">
        <Icon name={on ? 'check' : 'plus'} class="ico--sm" />
        {props.label}
        {on ? <span class="chip__value">{props.value}</span> : null}
      </summary>
      <div class={props.wide ? 'chip__pop chip__pop--wide' : 'chip__pop'}>
        {props.children}
        <button type="submit" class="btn btn--primary">{props.apply}</button>
      </div>
    </details>
  );
}

export function Card(props: { title: string; id?: string; icon?: AdminIconName; actions?: Child; children: Child }) {
  const headingId = props.id ? `${props.id}-title` : undefined;
  return (
    <section class="card" id={props.id} aria-labelledby={headingId}>
      <div class="card__head">
        <h2 class="card__title" id={headingId}>{props.title}</h2>
        {props.actions ?? null}
      </div>
      <div class="card__body">{props.children}</div>
    </section>
  );
}

/** Sticky bar of a bulk form; appears as soon as a `.pick` box in the form is ticked. */
export function BulkBar(props: { selected: string; children: Child }) {
  return (
    <div class="bulk">
      <p class="bulk__count">{props.selected}</p>
      {props.children}
    </div>
  );
}

/** Row checkbox of a bulk table. */
export function Pick(props: { name: string; value: string; label: string }) {
  return (
    <label class="pick-cell">
      <input type="checkbox" class="check pick" name={props.name} value={props.value} aria-label={props.label} />
    </label>
  );
}

/** Tick-all box for the header of a bulk table (shown only when admin.js runs). */
export function PickAll(props: { label: string }) {
  const { t } = useUi();
  return (
    <label class="pick-cell">
      <input type="checkbox" class="check pick-all" data-pick-all="" aria-label={props.label || t('common.actions')} />
    </label>
  );
}
