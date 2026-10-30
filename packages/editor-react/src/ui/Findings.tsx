/**
 * Findings: what a check says about a record, a save or a run, shown the same way everywhere.
 * `FindingsChip` is the compact form (a toned count; click for the list), `FindingsList` the
 * inline one. Advisory findings never block a draft save; the tone says how loud they are.
 */

import type { JSX } from 'react';

import { Popover } from './Overlays.tsx';
import { cx } from './cx.ts';

export type FindingLevel = 'error' | 'warn' | 'info';

export interface Finding {
  level: FindingLevel;
  message: string;
  /** where it applies, shown quiet before the message (an id, a pin, a layer) */
  at?: string;
}

/** plain lines from an older API, all at one level */
export function asFindings(lines: readonly string[], level: FindingLevel = 'warn'): Finding[] {
  return lines.map((message) => ({ level, message }));
}

const TONE: Readonly<Record<FindingLevel, 'err' | 'warn' | 'info'>> = { error: 'err', warn: 'warn', info: 'info' };

function worst(findings: readonly Finding[]): FindingLevel {
  return findings.some((f) => f.level === 'error') ? 'error' : findings.some((f) => f.level === 'warn') ? 'warn' : 'info';
}

/** "2 errors · 1 warning", or "3 findings" when they are all one level */
export function findingsSummary(findings: readonly Finding[]): string {
  const n = (level: FindingLevel): number => findings.filter((f) => f.level === level).length;
  const parts = [
    [n('error'), 'error'],
    [n('warn'), 'warning'],
    [n('info'), 'note'],
  ].filter(([count]) => (count as number) > 0) as [number, string][];
  if (parts.length <= 1) return `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
  return parts.map(([count, word]) => `${count} ${word}${count === 1 ? '' : 's'}`).join(' · ');
}

/** `onSelect` makes each message a button (select what it is about). */
export function FindingsList({ findings, max, className, onSelect }: { findings: readonly Finding[]; max?: number; className?: string; onSelect?: (finding: Finding, index: number) => void }): JSX.Element | null {
  if (findings.length === 0) return null;
  const shown = max === undefined ? findings : findings.slice(0, max);
  return (
    <ul className={cx('cs-ui-findings', className)} aria-label="Findings">
      {shown.map((f, i) => (
        <li key={`${f.level}:${f.at ?? ''}:${f.message}:${i}`} data-level={f.level}>
          <span className="cs-ui-findings-dot" data-tone={TONE[f.level]} aria-label={f.level} role="img" />
          {f.at === undefined ? null : <span className="cs-ui-findings-at">{f.at}</span>}
          {onSelect === undefined ? <span>{f.message}</span> : <button type="button" className="cs-ui-findings-go" onClick={() => onSelect(f, i)}>{f.message}</button>}
        </li>
      ))}
      {shown.length < findings.length ? <li className="cs-ui-findings-more">+{findings.length - shown.length} more</li> : null}
    </ul>
  );
}

/** A toned count; click (or Enter) shows the list. Nothing when there are none. */
export function FindingsChip({ findings, testId, label }: { findings: readonly Finding[]; testId?: string; label?: string }): JSX.Element | null {
  if (findings.length === 0) return null;
  const level = worst(findings);
  return (
    <Popover
      aria-label={label ?? 'Findings'}
      className="cs-ui-findings-pop"
      trigger={
        <button type="button" className="cs-ui-chip cs-ui-findings-chip" data-tone={TONE[level]} data-testid={testId} title={findings.map((f) => f.message).join('\n')}>
          {findingsSummary(findings)}
        </button>
      }
    >
      <FindingsList findings={findings} />
    </Popover>
  );
}
