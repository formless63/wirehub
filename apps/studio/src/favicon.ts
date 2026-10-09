/**
 * The tab icon has two states: the mark, and the mark with a copper dot for a development build
 * (`pnpm dev`), so a dev tab is never mistaken for a real hub. A production bundle keeps the
 * `<link rel="icon">` of `index.html` untouched.
 */

export const FAVICON_DEV = { svg: '/favicon-dev.svg', png: '/favicon-dev-32.png' } as const;

/** Point the page's icon links at the development favicon when `dev` is true; returns whether it did. */
export function applyFavicon(dev: boolean, doc: Document = document): boolean {
  if (!dev) return false;
  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'))) {
    link.href = link.type === 'image/png' ? FAVICON_DEV.png : FAVICON_DEV.svg;
  }
  return true;
}
