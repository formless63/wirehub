import { Link } from '@tanstack/react-router';
import type { JSX } from 'react';

import type { ProductMembership } from '../cable-list.ts';

/** Every declared membership links back to its family's variants. */
export function ProductChips({ products }: { products: readonly ProductMembership[] }): JSX.Element | null {
  if (products.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden" aria-label="Product membership">
      {products.map((p) => (
        <Link
          key={`${p.product}/${p.variant}`}
          to="/products/$id"
          params={{ id: p.product }}
          title={`${p.productLabel} · ${p.variantLabel}`}
          className="max-w-40 truncate rounded-sm border border-line2 px-1 text-[11px] leading-[16px] text-dim hover:text-ink"
        >
          {p.productLabel} · {p.variantLabel}
        </Link>
      ))}
    </span>
  );
}
