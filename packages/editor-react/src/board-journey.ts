/**
 * The board journey's host contract and its pure reads (data model v2 §8 J3).
 *
 * A board page in the Library walks the steps a new PCB takes — Import,
 * Pads, Connector, Builds, Guides — each with a completion state, so nothing
 * has to be hunted for. The editor never fetches: the build files arrive
 * through a `BuildsAdapter`, and "re-run the import" is the host's
 * (`onImport`), since that is a route and a job, not an edit.
 */

import {
  buildsFileFor,
  conductorLandings,
  definitionsOfBuild,
  footprintPadMap,
  validateBoardBuilds,
  type BoardBuilds,
  type ConductorLanding,
  type Db,
  type Issue,
  type PcbaDefinition,
  type SignalRef,
} from '@wirehub/model';

import type { DepictionMeta, EntryGuide } from './artwork.ts';
import type { Outcome } from './persistence.ts';

/** One build file as the host lists it. */
export interface BuildsFileView {
  /** `data/builds/<name>.json` */
  name: string;
  file: BoardBuilds;
  /** the version this copy is, sent back on save */
  etag?: string;
  /** the checks core runs, the file's own */
  issues: Issue[];
}

export interface BuildsAdapter {
  list(): Promise<Outcome<{ files: BuildsFileView[] }>>;
  /** validate, then write; a refusal carries core's issues */
  save(name: string, file: BoardBuilds, etag?: string): Promise<Outcome<BuildsFileView & { created: boolean }>>;
}

/** Pad-map edits handed to a re-run: `ref#pad` → terminal, `null` = not a terminal. */
export interface PadMapEdits {
  pads?: Record<string, string | null>;
}

export interface BoardJourneyHost {
  builds?: BuildsAdapter;
  /** open the board's import (a re-run), carrying pad-map edits for it to apply */
  onImport?: (board: { partNumber: string; revision: string }, edits?: PadMapEdits) => void;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** Every definition of the same board revision (one per build). */
export function boardSiblings(db: Db, def: Pick<PcbaDefinition, 'partNumber' | 'revision'>): PcbaDefinition[] {
  return db.pcbas.filter((p) => p.partNumber === def.partNumber && p.revision === def.revision);
}

/** The build file this board revision reads, with its name. */
export function boardBuildsFile(files: readonly BuildsFileView[], def: Pick<PcbaDefinition, 'partNumber' | 'revision'>): BuildsFileView | undefined {
  const hit = buildsFileFor(
    files.map((f) => f.file),
    def.partNumber,
    def.revision,
  );
  return hit === undefined ? undefined : files.find((f) => f.file === hit);
}

/** A terminal's tags: the record's own, else the side table's. */
export function padTags(db: Db, def: PcbaDefinition, terminal: string): { role?: string; signal?: SignalRef } {
  const own = def.terminals.find((t) => t.id === terminal);
  const table = db.tags?.pcbas?.[def.id]?.[terminal];
  const role = own?.role ?? table?.role;
  const signal = own?.signal ?? table?.signal;
  return { ...(role === undefined ? {} : { role }), ...(signal === undefined ? {} : { signal }) };
}

/**
 * The conductor landing on each footprint pad's copper (`conductorLandings`
 * with this board's tags): what lets the connector step read a pad that takes
 * both the carrier's T-join and a wire as a double landing, not a mismatch.
 */
export function padLandings(db: Db, def: PcbaDefinition): Record<string, ConductorLanding> {
  return conductorLandings(def, (terminal) => padTags(db, def, terminal));
}

/** Cable pads (not `j.5`-style connector pins). */
export function cablePads(def: PcbaDefinition): string[] {
  return def.terminals.map((t) => t.id).filter((id) => !id.includes('.'));
}

/** Connector prefixes the board's terminals use (`j`, `mo`, `scart`). */
export function connectorPrefixes(def: PcbaDefinition): string[] {
  const ids = [...def.terminals.map((t) => t.id), ...def.internalLinks.flatMap((l) => [l.from, l.to])];
  return [...new Set(ids.filter((id) => id.includes('.')).map((id) => id.slice(0, id.indexOf('.'))))].sort();
}

/** Every terminal the board names, pads and connector pins, once. */
export function allTerminals(def: PcbaDefinition): string[] {
  return [...new Set([...def.terminals.map((t) => t.id), ...def.internalLinks.flatMap((l) => [l.from, l.to])])];
}

/** A pad needs a person when it has no pad role, or no anchor on the art. */
export function uncertainPads(db: Db, def: PcbaDefinition, meta: DepictionMeta | undefined): string[] {
  return cablePads(def).filter((id) => padTags(db, def, id).role === undefined || (meta !== undefined && meta.pinAnchors[id] === undefined));
}

/* ------------------------------------------------------------------ *
 * Step states
 * ------------------------------------------------------------------ */

export type StepId = 'import' | 'pads' | 'connector' | 'builds' | 'guides';
export type StepState = 'done' | 'todo' | 'warn' | 'none';

export interface StepStatus {
  id: StepId;
  state: StepState;
  /** a few words, for the chip */
  note: string;
  /** the tooltip */
  title: string;
}

export interface JourneyInput {
  db: Db;
  def: PcbaDefinition;
  meta: DepictionMeta | undefined;
  /** undefined: still loading */
  files: readonly BuildsFileView[] | undefined;
  /** the build file being edited (the draft), if any */
  draft: BoardBuilds | undefined;
  /** the guides a face needs (the defaults), and what is stored */
  guidesNeeded: readonly EntryGuide[];
}

export function journeySteps(input: JourneyInput): StepStatus[] {
  const { db, def, meta, draft } = input;
  const gerber = meta?.views['board-top']?.sourceKind === 'gerber';
  const builds = draft?.builds ?? [];
  const unemitted = builds.filter((b) => draft !== undefined && definitionsOfBuild(draft, b, db.pcbas).length === 0);
  const importStep: StepStatus = !gerber
    ? { id: 'import', state: 'todo', note: 'no gerber art', title: 'Run an importer: art, pads and definitions come from the board files' }
    : unemitted.length > 0
      ? {
          id: 'import',
          state: 'warn',
          note: `${unemitted.length} build${unemitted.length === 1 ? '' : 's'} not emitted`,
          title: `Re-run the import to make definitions for: ${unemitted.map((b) => b.key).join(', ')}`,
        }
      : { id: 'import', state: 'done', note: 'imported', title: 'Art, pads and definitions come from the production files' };

  const uncertain = uncertainPads(db, def, meta);
  const padsStep: StepStatus =
    uncertain.length === 0
      ? { id: 'pads', state: 'done', note: `${cablePads(def).length} pads`, title: 'Every cable pad has a role and sits on the art' }
      : { id: 'pads', state: 'todo', note: `${uncertain.length} to check`, title: `No role or no anchor: ${uncertain.join(', ')}` };

  const prefixes = connectorPrefixes(def);
  let connectorStep: StepStatus;
  if (prefixes.length === 0) {
    connectorStep = { id: 'connector', state: 'none', note: 'none', title: 'This board carries no connector footprint' };
  } else {
    const terms = allTerminals(def);
    const signals = Object.fromEntries(terms.map((t) => [t, padTags(db, def, t).signal]));
    const landings = padLandings(db, def);
    let missing = 0;
    let mismatches = 0;
    for (const prefix of prefixes) {
      const fp = draft?.footprints?.find((f) => f.prefix === prefix);
      const iface = fp === undefined ? undefined : (db.interfaces ?? []).find((i) => i.id === fp.interface);
      if (fp === undefined || iface === undefined) {
        missing += 1;
        continue;
      }
      mismatches += footprintPadMap(fp, iface, terms, signals, db.vocab, { landings }).mismatches;
    }
    connectorStep =
      missing > 0
        ? { id: 'connector', state: 'todo', note: `${missing} to pick`, title: 'Pick the interface each connector footprint carries' }
        : mismatches > 0
          ? { id: 'connector', state: 'warn', note: `${mismatches} mismatch${mismatches === 1 ? '' : 'es'}`, title: 'Some footprint pads do not land on the interface as tagged' }
          : { id: 'connector', state: 'done', note: prefixes.join(' · '), title: 'Every footprint pad lands on its interface' };
  }

  let buildsStep: StepStatus;
  if (input.files === undefined) buildsStep = { id: 'builds', state: 'todo', note: '…', title: 'Reading the build files' };
  else if (draft === undefined) buildsStep = { id: 'builds', state: 'todo', note: 'no file', title: 'This board has no build file yet' };
  else {
    const issues = validateBoardBuilds([draft], {
      pcbas: db.pcbas,
      ...(db.interfaces === undefined ? {} : { interfaces: db.interfaces }),
      ...(db.vocab === undefined ? {} : { vocab: db.vocab }),
    });
    const errs = issues.filter((i) => i.severity === 'error').length;
    buildsStep =
      errs > 0
        ? { id: 'builds', state: 'warn', note: `${errs} issue${errs === 1 ? '' : 's'}`, title: issues.map((i) => i.message).join('\n') }
        : { id: 'builds', state: 'done', note: `${builds.length} build${builds.length === 1 ? '' : 's'}`, title: 'Every build checks out' };
  }

  const stored = meta?.entryGuides ?? [];
  const sides = new Set(input.guidesNeeded.map((g) => g.side));
  const unset = [...sides].filter((s) => !stored.some((g) => g.side === s));
  const guidesStep: StepStatus = !gerber
    ? { id: 'guides', state: 'todo', note: 'no art', title: 'Guides are set on the gerber art' }
    : sides.size === 0
      ? { id: 'guides', state: 'none', note: 'not needed', title: 'No angled pad row: wires go straight in' }
      : unset.length === 0
        ? { id: 'guides', state: 'done', note: `${stored.length} set`, title: 'Entry guides are saved' }
        : { id: 'guides', state: 'todo', note: `${unset.join(' + ')} default`, title: 'Check the default entry guides and save them' };

  return [importStep, padsStep, connectorStep, buildsStep, guidesStep];
}
