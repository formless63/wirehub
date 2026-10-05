/**
 * The Library's part-number helper: check a PN against the deployment's
 * numbering scheme as it is typed, and — on request — suggest one with the
 * rule that produced it. The host hands in the scheme and the numbers in use
 * (`LibraryProps.partNumbers`); without them the Suggest button is not shown.
 *
 * The scheme is pluggable (`PartNumberScheme`, `docs/modules.md`). Nothing is
 * applied until the user presses Use — and even then only to the draft, which
 * they still have to save.
 */

import { createContext, useContext } from 'react';
import {
  knownPartNumbers,
  type CableDesign,
  type ComponentDefinition,
  type ConnectorDefinition,
  type Db,
  type KitDefinition,
  type KnownPartNumber,
  type MechanicalDefinition,
  type PartNumberScheme,
  type PcbaDefinition,
  type PnIssue,
  type PnKind,
  type PnSuggestion,
  type WireDefinition,
} from '@wirehub/model';
import type { DrawingMeta } from '@wirehub/docs';

/** What the host knows about part numbers: the scheme, and the designs and drawings beside the catalog. */
export interface PartNumberData {
  scheme: PartNumberScheme;
  drawings?: Readonly<Record<string, DrawingMeta>>;
  designs?: readonly CableDesign[];
  /** numbers from elsewhere (an external register a module reads) */
  extra?: readonly KnownPartNumber[];
}

/** The definition being edited, as the form would save it. */
export type PartNumberTarget =
  | { kind: 'connector'; def: ConnectorDefinition }
  | { kind: 'component'; def: ComponentDefinition }
  | { kind: 'wire'; def: WireDefinition }
  | { kind: 'pcba'; def: PcbaDefinition }
  | { kind: 'mechanical'; def: MechanicalDefinition }
  | { kind: 'kit'; def: KitDefinition }
  /** a cable: its drawing's PN — `partNumber` is what the drawing form holds now */
  | { kind: 'design'; def: CableDesign; partNumber?: string };

export interface LabeledSuggestion {
  /** what the number is for */
  label: string;
  /** true when "Use" puts it in this field; false for information only */
  forField: boolean;
  suggestion: PnSuggestion;
  /** existing numbers that may already be this part's */
  candidates: { pn: string; description: string }[];
}

/** What Suggest found: the suggestions, or why there are none. */
export interface SuggestResult {
  items: LabeledSuggestion[];
  /** the reason no new number is offered */
  waiting?: string;
  /** existing numbers that may already be its number, even when nothing is suggested */
  candidates: { pn: string; description: string }[];
}

export interface PartNumberScope {
  check: (pn: string, kind: PnKind) => PnIssue[];
  suggest: (target: PartNumberTarget) => SuggestResult;
}

export const PartNumberContext = createContext<PartNumberScope | undefined>(undefined);

export function usePartNumbers(): PartNumberScope | undefined {
  return useContext(PartNumberContext);
}

const DEF_ID = '__draft__';

/** `db` with the draft in place of (or beside) the saved record. */
function withTarget(db: Db, target: PartNumberTarget): { db: Db; id: string } {
  const id = target.def.id.trim() === '' ? DEF_ID : target.def.id;
  const put = <T extends { id: string }>(list: readonly T[], def: T): T[] => [...list.filter((d) => d.id !== id), { ...def, id }];
  switch (target.kind) {
    case 'connector':
      return { db: { ...db, connectors: put(db.connectors, target.def) }, id };
    case 'component':
      return { db: { ...db, components: put(db.components, target.def) }, id };
    case 'wire':
      return { db: { ...db, wires: put(db.wires, target.def) }, id };
    case 'pcba':
      return { db: { ...db, pcbas: put(db.pcbas, target.def) }, id };
    case 'mechanical':
      return { db: { ...db, mechanicals: put(db.mechanicals ?? [], target.def) }, id };
    case 'kit':
      return { db: { ...db, kits: put(db.kits ?? [], target.def) }, id };
    case 'design':
      // a design is not in the db: `partNumberScope` puts it among the designs
      return { db, id };
  }
}

function kindOfTarget(target: PartNumberTarget): PnKind {
  if (target.kind === 'mechanical') {
    return target.def.kind === 'shell' ? 'shell' : target.def.kind === 'fastener' ? 'fastener' : 'mechanical-other';
  }
  if (target.kind === 'pcba') return 'bare-pcb';
  if (target.kind === 'design') return 'design';
  return target.kind;
}

export function partNumberScope(data: PartNumberData, db: Db): PartNumberScope {
  return {
    check: (pn, kind) => (pn.trim() === '' ? [] : data.scheme.check(pn, kind)),
    suggest: (target) => {
      const placed = withTarget(db, target);
      // a cable being numbered: the draft among the designs, its own number set aside (it is what we are suggesting)
      const designs =
        target.kind === 'design'
          ? [...(data.designs ?? []).filter((d) => d.id !== placed.id), { ...target.def, id: placed.id, productRef: undefined }]
          : (data.designs ?? []);
      const drawingPns: KnownPartNumber[] = Object.entries(data.drawings ?? {})
        .filter(([id, meta]) => !(target.kind === 'design' && id === placed.id) && meta.partNumber !== undefined)
        .map(([id, meta]) => ({ pn: meta.partNumber as string, kind: 'design' as const, source: `drawings/${id}` }));
      const known = knownPartNumbers(placed.db, designs, [...drawingPns, ...(data.extra ?? [])]).filter(
        (k) => !(k.source.endsWith(` ${placed.id}`) || k.source === `designs/${placed.id}.json`),
      );
      const own = target.kind === 'design' ? target.partNumber : ((target.def as { partNumber?: string }).partNumber ?? (target.def as { sku?: string }).sku);
      const hasOwn = own !== undefined && data.scheme.parse(own) !== undefined;
      const s: PnSuggestion | undefined = data.scheme.suggest({ kind: kindOfTarget(target), label: target.def.label, id: placed.id }, known);
      const items: LabeledSuggestion[] =
        s === undefined ? [] : [{ label: hasOwn ? 'Suggested (this part already has a number)' : 'Suggested', forField: true, suggestion: s, candidates: [] }];
      return { items, candidates: [] };
    },
  };
}

export { kindOfTarget as partNumberKindOf };
