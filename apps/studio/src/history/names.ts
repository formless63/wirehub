/**
 * Readable names for the ids History and Jobs carry (a design's, a library
 * record's, a firmware project's), looked up in what the page already has
 * loaded: the studio's library and designs list, and the firmware list (one
 * shared query). Never a fetch per row; an id nobody knows stays an id.
 */

import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState } from 'react';

import { fetchFirmware, firmwareKey, type FirmwareList } from '../firmware.browser.ts';
import { fetchKnowledgeIndex, knowledgeIndexKey } from '../knowledge.browser.ts';
import type { KnowledgeIndex } from '../knowledge.ts';
import { unwrap } from '../products.browser.ts';
import { useOptionalStudio } from '../studio-context.tsx';
import type { RecordNames } from './labels.ts';

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function useRecordNames(): RecordNames {
  const studio = useOptionalStudio();
  // the firmware list through the shared query cache when there is one (the app), else one plain read
  const client = useContext(QueryClientContext);
  const [projects, setProjects] = useState<FirmwareList['projects']>();
  const [knowledge, setKnowledge] = useState<KnowledgeIndex>();
  useEffect(() => {
    let live = true;
    (client === undefined ? fetchKnowledgeIndex() : client.fetchQuery({ queryKey: knowledgeIndexKey, queryFn: fetchKnowledgeIndex, staleTime: 60_000, retry: false }))
      .then((index) => {
        if (live) setKnowledge(index);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);
  useEffect(() => {
    let live = true;
    const read = (): Promise<FirmwareList> => unwrap(fetchFirmware());
    (client === undefined ? read() : client.fetchQuery({ queryKey: firmwareKey, queryFn: read, staleTime: 60_000, retry: false }))
      .then((list) => {
        if (live) setProjects(list.projects);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);
  const db = studio?.db;
  const designs = studio?.designs;
  return useMemo(() => {
    const byKind = new Map<string, Map<string, Record<string, unknown>>>();
    const any = new Map<string, Record<string, unknown>>();
    for (const [kind, list] of Object.entries(db ?? {})) {
      if (!Array.isArray(list)) continue;
      const m = new Map<string, Record<string, unknown>>();
      for (const r of list as unknown[]) {
        if (typeof r !== 'object' || r === null || typeof (r as { id?: unknown }).id !== 'string') continue;
        const rec = r as Record<string, unknown>;
        m.set(rec['id'] as string, rec);
        if (!any.has(rec['id'] as string)) any.set(rec['id'] as string, rec);
      }
      byKind.set(kind, m);
    }
    const designLabels = new Map((designs ?? []).map((d) => [d.id, d.label] as const));
    const fw = new Map((projects ?? []).map((p) => [p.id, p.label] as const));
    const notes = new Map((knowledge?.notes ?? []).map((n) => [n.id, n.title] as const));
    const kprojects = new Map((knowledge?.projects ?? []).map((p) => [p.id, p.title] as const));
    const record = (kind: string | undefined, id: string): Record<string, unknown> | undefined => (kind === undefined ? any.get(id) : byKind.get(kind)?.get(id));
    return {
      design: (id) => text(designLabels.get(id)),
      definition: (kind, id) => text(record(kind, id)?.['label']),
      board: (id, revision) => {
        const r = record('pcbas', id);
        if (r === undefined) return undefined;
        const pn = text(r['partNumber']);
        const rev = text(revision) ?? text(r['revision']);
        return pn === undefined ? text(r['label']) : rev === undefined ? pn : `${pn} ${rev}`;
      },
      firmware: (id) => text(fw.get(id)),
      knowledge: (type, id) => text((type === 'note' ? notes : kprojects).get(id)),
    };
  }, [db, designs, projects, knowledge]);
}
