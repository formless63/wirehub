/**
 * Light/dark theme: the app's job, not the editor's (`@wirehub/editor-react`
 * never reads or writes this). The person's choice is light, dark or system
 * (the default, also for an account with no choice saved): system follows
 * `prefers-color-scheme` live, a pinned light or dark wins over it. The choice
 * lives with the account (`theme` preference) and this browser keeps a copy for
 * the first paint. `data-theme` on `<html>` is what
 * `tokens.css` (owned by editor-react, imported here too — see `studio.css`)
 * actually switches on.
 */

const STORAGE_KEY = 'wirehub:theme';

export type Theme = 'light' | 'dark';

/** what the person chose: a pinned theme, or follow the system */
export type ThemeChoice = Theme | 'system';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return isTheme(value) || value === 'system';
}

/** this browser's copy of the choice; nothing stored means system */
export function storedChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isTheme(raw) ? raw : 'system';
  } catch {
    // private browsing, blocked storage, … — fall back to the system preference
    return 'system';
  }
}

export function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** the theme this page should open with */
export function initialTheme(): Theme {
  return resolveTheme(storedChoice());
}

export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === 'system' ? systemTheme() : choice;
}

/** attach `data-theme` to `<html>` — the only thing `tokens.css` reads */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** this browser's copy, for the first paint (and the sign-in page); system is stored as nothing */
export function persistTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // best effort: the theme still applies for this tab, it just won't stick
  }
}

/**
 * Keep following the system preference live — but only until the person has
 * pinned an explicit choice, at which point their pick wins and this stops
 * calling back. Returns an unsubscribe function.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mql = matchMedia('(prefers-color-scheme: dark)');
  const listener = (): void => {
    if (storedChoice() === 'system') onChange(systemTheme());
  };
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
