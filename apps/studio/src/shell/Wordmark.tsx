/**
 * The product name and its mark. The mark is a neutral placeholder (the same
 * drawing as `public/favicon.svg`); a deployment's branding module may
 * replace both.
 */

import type { JSX } from 'react';

export const PRODUCT_NAME = 'Cable Studio';

export function StudioMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={PRODUCT_NAME} className="block">
      <rect width="64" height="64" rx="14" fill="#1f2937" />
      <path d="M14 40c10 0 10-16 20-16s10 16 16 16" fill="none" stroke="#9ca3af" strokeWidth="5" strokeLinecap="round" />
      <rect x="6" y="34" width="12" height="12" rx="3" fill="#e5e7eb" />
      <rect x="46" y="34" width="12" height="12" rx="3" fill="#e5e7eb" />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`font-wordmark whitespace-nowrap tracking-wide text-ink ${className}`}>
      <span className="sr-only">{PRODUCT_NAME}</span>
      <span aria-hidden="true">CABLE</span> <span aria-hidden="true">STUDIO</span>
    </span>
  );
}
