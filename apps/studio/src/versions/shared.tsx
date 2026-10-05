/**
 * Pieces the version panel and the version view share:
 * the queries, a diff list, a history list and the small buttons.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DesignVersionFile, VersionHistoryEntry } from '@wirehub/model';
import { useCallback, type JSX, type ReactNode } from 'react';

import { cableListKey } from '../queries.ts';
import { getVersion, listVersions, shortTime, versionKey, versionsKey, type VersionListing } from '../versions.browser.ts';

/** The version list for one design; `undefined` while loading or when the API is down. */
export function useVersionListing(id: string | undefined): {
  listing: VersionListing | undefined;
  error: string | undefined;
  refresh: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: versionsKey(id ?? ''),
    queryFn: async () => {
      const out = await listVersions(id as string);
      if (!out.ok) throw new Error(out.message);
      return out.value;
    },
    enabled: id !== undefined,
    retry: false,
  });
  const refresh = useCallback(async (): Promise<void> => {
    if (id === undefined) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: versionsKey(id) }),
      queryClient.invalidateQueries({ queryKey: ['studio', 'version', id] }),
      queryClient.invalidateQueries({ queryKey: cableListKey }),
    ]);
  }, [id, queryClient]);
  return { listing: query.data, error: query.error === null ? undefined : query.error.message, refresh };
}

export type VersionFileWithArt = DesignVersionFile & { artworkChanged?: string[] };

export function useVersionFile(id: string, rev: number | undefined): {
  file: VersionFileWithArt | undefined;
  error: string | undefined;
} {
  const query = useQuery({
    queryKey: versionKey(id, rev ?? -1),
    queryFn: async () => {
      const out = await getVersion(id, rev as number);
      if (!out.ok) throw new Error(`${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
      return out.value as VersionFileWithArt;
    },
    enabled: rev !== undefined,
    retry: false,
    staleTime: 30_000,
  });
  return { file: query.data, error: query.error === null ? undefined : query.error.message };
}

/** Diff lines (`diffLines`), coloured by their sign. */
export function DiffList(props: { lines: string[]; empty?: string }): JSX.Element {
  if (props.lines.length === 0) {
    return <p className="m-0 px-1 py-1 text-[12px] text-faint">{props.empty ?? 'No differences.'}</p>;
  }
  return (
    <ul className="m-0 max-h-[300px] list-none overflow-y-auto p-0 font-mono text-[11.5px] leading-[18px]" data-testid="version-diff">
      {props.lines.map((line, index) => (
        <li
          key={`${index}:${line}`}
          className={`truncate px-1 ${line.startsWith('+') ? 'text-ok' : line.startsWith('−') ? 'text-err' : 'text-warn'}`}
          title={line}
        >
          {line}
        </li>
      ))}
    </ul>
  );
}

const ACTION_LABEL: Record<VersionHistoryEntry['action'], string> = {
  save: 'saved',
  unlock: 'unlocked',
  edit: 'edited',
  relock: 'locked',
  submit: 'submitted for approval',
  approve: 'approved',
  reject: 'rejected',
};

export function HistoryList(props: { history: VersionHistoryEntry[] }): JSX.Element {
  return (
    <ol className="m-0 list-none space-y-1 p-0 text-[11.5px]" data-testid="version-history">
      {props.history.map((entry, index) => (
        <li key={`${index}:${entry.at}`} className="rounded border border-line bg-bg px-2 py-1">
          <div className="flex flex-wrap items-center gap-x-1.5">
            <span
              className={`font-mono text-[10px] uppercase ${
                entry.action === 'unlock' || entry.action === 'edit' ? 'text-warn' : 'text-dim'
              }`}
            >
              {ACTION_LABEL[entry.action]}
            </span>
            <span className="text-ink">{entry.by}</span>
            <span className="text-faint">{shortTime(entry.at)}</span>
          </div>
          {entry.note === undefined ? null : <div className="text-dim">{entry.note}</div>}
          {entry.changes === undefined || entry.changes.length === 0 ? null : (
            <div className="mt-0.5 border-t border-line pt-0.5">
              <DiffList lines={entry.changes} />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A 24px icon button with a tooltip — the panel's row actions. */
export function RowButton(props: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  tone?: 'accent' | 'warn';
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded border border-transparent bg-transparent px-1 text-[11.5px] hover:border-line2 hover:bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent ${
        props.tone === 'accent' ? 'text-accent' : props.tone === 'warn' ? 'text-warn' : 'text-dim hover:text-ink'
      }`}
    >
      {props.children}
    </button>
  );
}

export const TEXT_INPUT =
  'h-7 min-w-0 flex-1 rounded-md border border-line2 bg-bg px-2 text-[12.5px] text-ink outline-none placeholder:text-faint focus:border-accent';
export const PRIMARY_BUTTON =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 bg-accent px-2.5 text-[12px] font-semibold text-accent-ink disabled:cursor-default disabled:bg-raised disabled:text-faint';
export const PLAIN_BUTTON =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line2 bg-raised px-2.5 text-[12px] text-ink hover:bg-hover disabled:cursor-default disabled:opacity-50';
