// Request-scoped values the UI kit needs (translator, language, CSRF token, user), provided by
// the Layout so components do not take them as props.
import { createContext, useContext } from 'hono/jsx';
import type { CurrentUser } from '../env.ts';
import { translator, type Lang, type Translator } from '../i18n/index.ts';

export interface UiContext {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  t: Translator;
  csrfToken: string;
  user: CurrentUser | undefined;
  /** Current path, for `aria-current` in the nav. */
  path: string;
  /** Where the language switch comes back to: this page, or the page a failed POST was sent from. */
  returnTo: string;
}

const fallback: UiContext = { lang: 'fr', dir: 'ltr', t: translator('fr'), csrfToken: '', user: undefined, path: '/', returnTo: '/' };

export const Ui = createContext<UiContext>(fallback);

export function useUi(): UiContext {
  return useContext(Ui);
}
