// Icons for the admin: the brand set from @hb/ui-tokens plus admin-only glyphs drawn on the same
// grid (24 × 24, 1.5 px stroke, round caps and joins, no fills). Decorative by default: the text
// next to an icon names the control; an icon-only control carries its own accessible name.
import { raw } from 'hono/html';
import { icons, type IconName } from '@hb/ui-tokens';

const ADMIN_GLYPHS = {
  inbox: '<path d="M4 13.5 6.2 5.8A1.5 1.5 0 0 1 7.6 4.7h8.8a1.5 1.5 0 0 1 1.4 1.1L20 13.5"/><path d="M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5h-5l-1 2.25h-4l-1-2.25H4Z"/>',
  users: '<circle cx="9" cy="8.5" r="3.25"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.6a3.25 3.25 0 0 1 0 5.8"/><path d="M17.2 14.4c1.8.7 3 2.3 3.3 4.6"/>',
  box: '<path d="m12 3.5 7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5Z"/><path d="m4.5 7.7 7.5 4.3 7.5-4.3"/><path d="M12 12v8.5"/>',
  layers: '<path d="m12 4 8 4.5-8 4.5-8-4.5L12 4Z"/><path d="m4 12.5 8 4.5 8-4.5"/><path d="m4 16 8 4.5 8-4.5" transform="translate(0 -.5)"/>',
  tag: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h6.3a1.5 1.5 0 0 1 1 .44l6.8 6.8a1.5 1.5 0 0 1 0 2.12l-6.2 6.2a1.5 1.5 0 0 1-2.12 0l-6.84-6.8a1.5 1.5 0 0 1-.44-1.06V5.5Z"/><circle cx="8.5" cy="8.5" r="1.25"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.75" cy="9.75" r="1.5"/><path d="m4 17 4.8-4.2 3 2.4 3.2-3.2 5 5"/>',
  file: '<path d="M7 3.5h6.5l4 4V19A1.5 1.5 0 0 1 16 20.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z"/><path d="M13.5 3.5v4h4"/><path d="M8.5 12.5h6M8.5 16h6"/>',
  upload: '<path d="M12 15.5V5"/><path d="m8 8.5 4-4 4 4"/><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  pin: '<path d="M12 21s7-6.1 7-11.5a7 7 0 1 0-14 0C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  sliders: '<path d="M4 7h9M18 7h2M4 12h2M11 12h9M4 17h7M16 17h4"/><circle cx="15.5" cy="7" r="2"/><circle cx="8.5" cy="12" r="2"/><circle cx="13.5" cy="17" r="2"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="5" cy="6.5" r=".9"/><circle cx="5" cy="12" r=".9"/><circle cx="5" cy="17.5" r=".9"/>',
  chart: '<path d="M4 4.5V18a1.5 1.5 0 0 0 1.5 1.5H20"/><path d="m7.5 15 3.5-4 3 2.5 5-6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  printer: '<path d="M7 8V4h10v4"/><rect x="3.5" y="8" width="17" height="8.5" rx="1.5"/><path d="M7 14h10v6H7z"/>',
  send: '<path d="M4 11.8 20.5 4l-6.5 16.5-3.2-6.3L4 11.8Z"/><path d="m10.8 14.2 4.2-4.7"/>',
  undo: '<path d="M8 6 4 10l4 4"/><path d="M4 10h10.5a5 5 0 0 1 0 10H9"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9L4 14.5"/><path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9L20 9.5"/><path d="M4 19v-4.5h4.5M20 5v4.5h-4.5"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M4 14.75h16M10 9.5V20"/>',
} as const;

export type AdminIconName = IconName | keyof typeof ADMIN_GLYPHS;

const adminSvg = (d: string) =>
  `<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

/** Markup is only ever these constants (no user input). `class` sizes it: ico--sm, ico--lg. */
export function Icon(props: { name: AdminIconName; class?: string }) {
  const svg = props.name in ADMIN_GLYPHS ? adminSvg(ADMIN_GLYPHS[props.name as keyof typeof ADMIN_GLYPHS]) : icons[props.name as IconName].svg;
  return <span class={props.class ? `ico ${props.class}` : 'ico'} aria-hidden="true">{raw(svg)}</span>;
}
