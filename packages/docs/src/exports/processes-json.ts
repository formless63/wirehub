/**
 * `processes.json`: the manufacturing processes a design needs (`requiredProcesses`,
 * `@wirehub/model` `processes.ts`) — each declared one and each one its parts imply, with where
 * it came from. A revision reads the vocabulary it captured when saved (`vocabulary: "captured"`);
 * the working copy reads the hub's live one (`"live"`). Format: `docs/processes.md`.
 */

import { requiredProcesses, type CableDesign, type Db, type Issue, type RequiredProcess } from '@wirehub/model';

export const PROCESSES_FORMAT = 'wirehub.processes';
export const PROCESSES_VERSION = 1;

export interface ProcessesExport {
  format: typeof PROCESSES_FORMAT;
  version: typeof PROCESSES_VERSION;
  design: { id: string; label: string; productRef?: string; rev?: number };
  vocabulary: 'captured' | 'live';
  processes: RequiredProcess[];
  issues: Issue[];
}

/** The export's value, every object's keys in a fixed order. */
export function deriveProcessesExport(design: CableDesign, db: Db, options: { revisionNumber?: number } = {}): ProcessesExport {
  const { processes, issues } = requiredProcesses(design, db);
  return {
    format: PROCESSES_FORMAT,
    version: PROCESSES_VERSION,
    design: {
      id: design.id,
      label: design.label,
      ...(design.productRef === undefined ? {} : { productRef: design.productRef }),
      ...(options.revisionNumber === undefined ? {} : { rev: options.revisionNumber }),
    },
    vocabulary: options.revisionNumber === undefined ? 'live' : 'captured',
    processes: processes.map((p) => ({
      id: p.id,
      label: p.label,
      known: p.known,
      source: p.source,
      ...(p.declared === undefined ? {} : { declared: p.declared.note === undefined ? {} : { note: p.declared.note } }),
      ...(p.derived === undefined ? {} : { derived: { matches: p.derived.matches.map((m) => ({ each: m.each, subject: m.subject })), more: p.derived.more } }),
    })),
    issues: issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message, ...(i.where === undefined ? {} : { where: i.where }) })),
  };
}

/** 2-space JSON with a trailing newline. */
export const processesJson = (data: ProcessesExport): string => `${JSON.stringify(data, null, 2)}\n`;
