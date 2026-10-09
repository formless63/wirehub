/**
 * Whether the viewer asked the system for less motion. The canvas uses it for the animations it
 * starts itself (centring on a pin, fitting the view); the stylesheet handles the CSS ones with
 * the same media query (`editor.css`).
 */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}
