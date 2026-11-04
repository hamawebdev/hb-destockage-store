// Post/Redirect/Get flash messages. Only whitelisted dictionary keys travel in the URL
// (`?m=saved`), so no user-supplied text is ever reflected.
import type { MessageKey } from '../i18n/index.ts';
import { useUi } from './context.ts';

export const FLASH = {
  saved: { key: 'flash.saved', tone: 'success' },
  created: { key: 'flash.created', tone: 'success' },
  deleted: { key: 'flash.deleted', tone: 'success' },
  error: { key: 'flash.error', tone: 'danger' },
} as const satisfies Record<string, { key: MessageKey; tone: 'success' | 'danger' }>;

export type FlashCode = keyof typeof FLASH;

export function isFlashCode(x: unknown): x is FlashCode {
  return typeof x === 'string' && Object.hasOwn(FLASH, x);
}

/** `/orders/12` + `saved` → `/orders/12?m=saved` (keeps an existing query). Only same-site paths. */
export function withFlash(path: string, code: FlashCode): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('withFlash: path must be site-relative');
  return `${path}${path.includes('?') ? '&' : '?'}m=${code}`;
}

export function Flash(props: { code: string | undefined }) {
  const { t } = useUi();
  const f = isFlashCode(props.code) ? FLASH[props.code] : undefined;
  return (
    <div class="flash-region" role="status" aria-live="polite">
      {f ? <p class={`flash flash--${f.tone}`}>{t(f.key)}</p> : null}
    </div>
  );
}
