/** Build-time copy for the consent choice (public/js/meta.js), per language. Missing keys fail the build. */
import type { LayoutProps } from '@hb/catalog';

export function metaUiJson(layout: Pick<LayoutProps, 'strings' | 'footerLinks'>): string {
  const need = (k: string): string => {
    const v = layout.strings[k];
    if (v === undefined) throw new Error(`missing UI string "${k}"`);
    return v;
  };
  // The fixture catalogue has no privacy page; this route is also built, then removed, when Meta is off.
  const privacy = layout.footerLinks.find((f) => f.key === 'privacy')?.href ?? null;
  return JSON.stringify({ text: need('consent.text'), accept: need('consent.accept'), decline: need('consent.decline'), more: need('consent.more'), privacy });
}
