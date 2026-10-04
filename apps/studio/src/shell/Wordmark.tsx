/**
 * The product name and its marks, drawn from the theme's brand tokens
 * (`--brand`, `--brand-ink`, `--brand-copper`, `--brand-wordmark` in
 * `@wirehub/editor-react/tokens.css`) so they follow light and dark. The
 * drawings are the same as `brand/wirehub-mark.svg` and `brand/wirehub-logo.svg`.
 */

import type { JSX } from 'react';

export const PRODUCT_NAME = 'WireHub';

/** The square mark: the "H" of the badge, its crossbar joined at a copper node. */
export function StudioMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={PRODUCT_NAME} className="block">
      <rect width="64" height="64" rx="14" fill="var(--brand)" />
      <path d="M19 15 V49 M45 15 V49 M19 32 H45" fill="none" stroke="var(--brand-ink)" strokeWidth="7" strokeLinecap="round" />
      <circle cx="32" cy="32" r="5.5" fill="var(--brand-copper)" />
    </svg>
  );
}

const WIRE =
  'M0 14 L10 70 L21 30 L32 70 L42 14 M55 36 V70 M70 36 V70 M70 50 C70 40 77 34 88 35 M98 52 H134 C134 41 126 34 116 34 C105 34 98 42 98 52 C98 63 105 70 116 70 C124 70 130 66 133 61';
const HUB =
  'M164 14 V70 M196 14 V70 M164 42 H196 M213 36 V55 C213 64 219 70 227 70 C236 70 242 64 242 55 M242 36 V70 M258 14 V70 M258 52 C258 41 266 34 276 34 C286 34 293 42 293 52 C293 62 286 70 276 70 C266 70 258 63 258 52';

/** "Wire" in monoline strokes, "Hub" in a rounded badge. Height follows the font size. */
export function Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`inline-flex items-center whitespace-nowrap ${className}`}>
      <span className="sr-only">{PRODUCT_NAME}</span>
      <svg viewBox="-8 -8 322 100" height="1.35em" aria-hidden="true" className="block" style={{ width: 'auto' }}>
        <g fill="none" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
          <path d={WIRE} stroke="var(--brand-wordmark)" />
          <rect x="146" y="-2" width="160" height="88" rx="20" fill="var(--brand)" stroke="none" />
          <path d={HUB} stroke="var(--brand-ink)" />
        </g>
        <circle cx="55" cy="18" r="6" fill="var(--brand-copper)" />
      </svg>
    </span>
  );
}
