/**
 * The design-status chip: a compact mono tag for a
 * `development`, `legacy` or `retired` design, shown on the cable list row and in the
 * workspace header's breadcrumb. An `active` design — the default, and most
 * of the catalog — shows nothing, so the chip only ever marks the exceptions.
 */

import type { DesignStatus } from '@wirehub/model';
import type { JSX } from 'react';

const TITLES: Record<Exclude<DesignStatus, 'active'>, string> = {
  development: 'Development design — its board is not released to production yet',
  legacy: 'Legacy design — still approved, built while its board inventory lasts',
  retired: 'Retired design — no longer built, kept for reference',
};

export function StatusChip(props: { status: DesignStatus | undefined }): JSX.Element | null {
  const status = props.status ?? 'active';
  if (status === 'active') return null;
  return (
    <span
      title={TITLES[status]}
      data-status={status}
      className={`shrink-0 rounded-sm border px-1 font-mono text-[9.5px] leading-[14px] tracking-wide uppercase ${
        status === 'development'
          ? 'border-accent text-accent'
          : status === 'retired'
            ? 'border-line2 text-faint'
            : 'border-warn text-warn'
      }`}
    >
      {status === 'development' ? 'dev' : status}
    </span>
  );
}
