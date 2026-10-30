/** Item references (`specs/knowledge.md`) resolved against what the page already loaded: labels, links, pickers. */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, type JSX } from 'react';
import { Chip, type ComboboxOption } from '@wirehub/editor-react';

import { definitionRecord, designRecord } from '../locks/records.ts';
import { describeRef, firmwareRecord, projectRecord } from '../knowledge.ts';
import { fetchFirmware, firmwareKey } from '../firmware.browser.ts';
import { unwrap } from '../products.browser.ts';
import { fetchKnowledgeIndex, knowledgeIndexKey } from '../knowledge.browser.ts';
import { cableListKey, loadCableList } from '../queries.ts';
import { useStudio } from '../studio-context.tsx';

/** Definition kind → its Library address and noun. Bodies and interfaces are edited with connectors. */
const KINDS: Readonly<Record<string, { url: string; noun: string }>> = {
  connectors: { url: 'connectors', noun: 'Connector' },
  components: { url: 'components', noun: 'Component' },
  wires: { url: 'wires', noun: 'Stock' },
  pcbas: { url: 'boards', noun: 'Board' },
  mechanicals: { url: 'hardware', noun: 'Hardware' },
  kits: { url: 'kits', noun: 'Kit' },
  bodies: { url: 'connectors', noun: 'Body' },
  interfaces: { url: 'connectors', noun: 'Interface' },
};

export interface ResolvedRef {
  record: string;
  label: string;
  noun: string;
  /** a route to open it; absent when it no longer exists */
  to?: { kind: 'library'; urlKind: string; id: string } | { kind: 'design'; id: string } | { kind: 'project'; id: string } | { kind: 'firmware'; id: string };
  missing: boolean;
}

export function useItemRefs(): { resolve: (record: string) => ResolvedRef; options: ComboboxOption[] } {
  const { db } = useStudio();
  const cables = useQuery({ queryKey: cableListKey, queryFn: loadCableList });
  const knowledge = useQuery({ queryKey: knowledgeIndexKey, queryFn: fetchKnowledgeIndex, retry: false });
  const firmware = useQuery({ queryKey: firmwareKey, queryFn: () => unwrap(fetchFirmware()), retry: false, staleTime: 10_000 });
  return useMemo(() => {
    const defs = new Map<string, string>();
    const options: ComboboxOption[] = [];
    for (const [kind, meta] of Object.entries(KINDS)) {
      const list = (db as unknown as Record<string, { id: string; label?: string }[] | undefined>)[kind] ?? [];
      for (const d of list) {
        const record = definitionRecord(kind, d.id);
        defs.set(record, d.label || `Unnamed ${meta.noun.toLowerCase()}`);
        options.push({ value: record, label: d.label || `Unnamed ${meta.noun.toLowerCase()}`, hint: meta.noun });
      }
    }
    const designs = new Map((cables.data?.entries ?? []).map((e) => [designRecord(e.id), e.label]));
    for (const [record, label] of designs) options.push({ value: record, label, hint: 'Design' });
    const projects = new Map((knowledge.data?.projects ?? []).map((p) => [projectRecord(p.id), p.title]));
    for (const [record, label] of projects) options.push({ value: record, label, hint: 'Project' });
    const firmwareProjects = new Map((firmware.data?.projects ?? []).map((p) => [firmwareRecord(p.id), p.label]));
    for (const [record, label] of firmwareProjects) options.push({ value: record, label, hint: 'Firmware' });
    const resolve = (record: string): ResolvedRef => {
      const ref = describeRef(record);
      if (ref.type === 'definition') {
        const meta = KINDS[ref.kind ?? ''];
        const label = defs.get(record);
        return { record, label: label ?? 'Removed item', noun: meta?.noun ?? ref.kind ?? 'Record', missing: label === undefined,
          ...(label === undefined || meta === undefined ? {} : { to: { kind: 'library' as const, urlKind: meta.url, id: ref.id } }) };
      }
      if (ref.type === 'design') {
        const label = designs.get(record);
        // the list may still be loading: only call it missing once it has arrived
        const missing = cables.data !== undefined && label === undefined;
        return { record, label: label ?? (missing ? 'Removed item' : 'Loading…'), noun: 'Design', missing, ...(missing ? {} : { to: { kind: 'design' as const, id: ref.id } }) };
      }
      if (ref.type === 'project') {
        const label = projects.get(record);
        const missing = knowledge.data !== undefined && label === undefined;
        return { record, label: label ?? (missing ? 'Removed item' : 'Loading…'), noun: 'Project', missing, ...(missing ? {} : { to: { kind: 'project' as const, id: ref.id } }) };
      }
      if (ref.type === 'firmware') {
        const label = firmwareProjects.get(record);
        const missing = firmware.data !== undefined && label === undefined;
        return { record, label: label ?? (missing ? 'Removed item' : 'Loading…'), noun: 'Firmware', missing, ...(missing ? {} : { to: { kind: 'firmware' as const, id: ref.id } }) };
      }
      return { record, label: ref.type === 'build' ? 'Build' : 'List', noun: ref.type === 'build' ? 'Build' : 'List', missing: false };
    };
    return { resolve, options };
  }, [db, cables.data, knowledge.data, firmware.data]);
}

/** A reference as a small link chip; a removed record says so instead of pretending. */
export function RefChip({ item, onRemove }: { item: ResolvedRef; onRemove?: () => void }): JSX.Element {
  const text = `${item.noun} · ${item.label}`;
  const body = item.to === undefined ? <span className={item.missing ? 'line-through' : undefined}>{text}</span>
    : item.to.kind === 'library' ? <Link to="/library/$kind/$id" params={{ kind: item.to.urlKind, id: item.to.id }} className="no-underline hover:underline">{text}</Link>
      : item.to.kind === 'design' ? <Link to="/cables/$id" params={{ id: item.to.id }} search={{ view: 'build' }} className="no-underline hover:underline">{text}</Link>
        : item.to.kind === 'firmware' ? <Link to="/firmware/$id" params={{ id: item.to.id }} className="no-underline hover:underline">{text}</Link>
          : <Link to="/projects/$id" params={{ id: item.to.id }} className="no-underline hover:underline">{text}</Link>;
  return <Chip tone={item.missing ? 'warn' : 'neutral'} title={item.missing ? `${item.label} is no longer in this hub` : item.label} {...(onRemove === undefined ? {} : { onRemove, removeLabel: `Remove link to ${item.label}` })}>{body}</Chip>;
}
