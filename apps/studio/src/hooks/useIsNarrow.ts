/**
 * Portrait phone widths ( ~360-430px): the studio is
 * desktop-first, and this is the one place that says "narrow enough to
 * restructure content" rather than just "small enough to hide a button" —
 * the latter is a plain `max-sm:` Tailwind class, which needs no JS. This is
 * for the handful of spots where the *data* itself has to lay out
 * differently (the cable list's rows), not just be hidden or shown.
 *
 * 640px matches Tailwind's own `sm` breakpoint, so a component that mixes
 * this hook with `max-sm:`/`sm:` classes never disagrees with itself.
 *
 * Takes an optional query (default the 639px phone one):
 * the cable list's toolbar needs a second, wider threshold (~900px, where the
 * filter chips stop fitting a single row) to *restructure* itself — collapse
 * into one "Filters" popover — rather than just hide/show via a plain
 * `max-[900px]:` class, since which JSX renders differs, not just its style.
 */

import { useEffect, useState } from 'react';

const DEFAULT_QUERY = '(max-width: 639px)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false;
}

export function useIsNarrow(query: string = DEFAULT_QUERY): boolean {
  const [narrow, setNarrow] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (): void => setNarrow(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}
