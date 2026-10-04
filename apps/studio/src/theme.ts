/**
 * Light/dark theme: the app's job, not the editor's (`@wirehub/editor-react`
 * never reads or writes this). Defaults to the system preference; once the
 * person picks one explicitly (the header toggle), that choice is persisted
 * and wins over the system from then on. `data-theme` on `<html>` is what
 * `tokens.css` (owned by editor-react, imported here too — see `studio.css`)
 * actually switches on.
 */

const STORAGE_KEY = 'wirehub:theme';

export type Theme = 'light' | 'dark';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** `undefined` means "no explicit choice yet — follow the system" */
function storedTheme(): Theme | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isTheme(raw) ? raw : undefined;
  } catch {
    // private browsing, blocked storage, … — fall back to the system preference
    return undefined;
  }
}

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** the theme this page should open with */
export function initialTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

/** attach `data-theme` to `<html>` — the only thing `tokens.css` reads */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
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
    if (storedTheme() === undefined) onChange(systemTheme());
  };
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
