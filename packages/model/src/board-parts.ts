/**
 * Board parts: the parts placed on each released PCBA,
 * linked to component records, for the "Components on this board" lists.
 *
 * A PCBA is still a black box to the cable: the studio buys the populated
 * board (its 4E number) and the cable BOM carries one line for it. What is on
 * the board is the board's own sub-list — shown on its Library page and in the
 * build view — and never becomes cable BOM lines.
 *
 * Pure: `data/board-parts.json` is read by the catalog, and the builds'
 * population (`data/builds/*.json`) is laid over it at load with
 * `boardPartsWithBuilds`, so an edited build shows at once.
 */

import { buildPopulation, definitionsOfBuild, type BoardBuilds } from './builds.ts';
import type {
  BoardPartsBuild,
  BoardPartsEntry,
  ComponentCategory,
  ComponentDefinition,
  Db,
  PcbaDefinition,
  PlacedPart,
} from './model.ts';

const CATEGORIES: readonly ComponentCategory[] = [
  'ic',
  'regulator',
  'resistor',
  'capacitor',
  'inductor',
  'diode',
  'transistor',
  'switch',
  'jumper',
  'jack',
  'connector',
  'other',
];

/** A record's category: its own, else its `kind` where that is one, else `other`. */
export function componentCategory(component: Pick<ComponentDefinition, 'category' | 'kind'>): ComponentCategory {
  if (component.category !== undefined) return component.category;
  return (CATEGORIES as readonly string[]).includes(component.kind) ? (component.kind as ComponentCategory) : 'other';
}

/** `R2` before `R10`; letters first, then the number. */
export function compareRefs(a: string, b: string): number {
  const ma = /^([A-Za-z_]*)(\d*)(.*)$/.exec(a);
  const mb = /^([A-Za-z_]*)(\d*)(.*)$/.exec(b);
  const pa = ma?.[1] ?? a;
  const pb = mb?.[1] ?? b;
  if (pa !== pb) return pa < pb ? -1 : 1;
  const na = ma?.[2] === '' || ma?.[2] === undefined ? -1 : Number(ma[2]);
  const nb = mb?.[2] === '' || mb?.[2] === undefined ? -1 : Number(mb[2]);
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `["C1","C2","C3","C5"]` → `C1–C3, C5` (runs of three or more collapse). */
export function compressRefs(refs: readonly string[]): string {
  const sorted = [...new Set(refs)].sort(compareRefs);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const m = /^([A-Za-z_]+)(\d+)$/.exec(sorted[i] as string);
    let j = i;
    if (m !== null) {
      while (j + 1 < sorted.length) {
        const n = /^([A-Za-z_]+)(\d+)$/.exec(sorted[j + 1] as string);
        const prev = /^([A-Za-z_]+)(\d+)$/.exec(sorted[j] as string);
        if (n === null || prev === null || n[1] !== m[1] || Number(n[2]) !== Number(prev[2]) + 1) break;
        j += 1;
      }
    }
    if (j - i >= 2) out.push(`${sorted[i] as string}–${sorted[j] as string}`);
    else for (let k = i; k <= j; k++) out.push(sorted[k] as string);
    i = j + 1;
  }
  return out.join(', ');
}

/** The build files for one board revision: its own `<pn> <revision>` file wins over the part-number file. */
function buildFileFor(files: readonly BoardBuilds[], board: string, revision: string): BoardBuilds | undefined {
  return files.find((f) => f.board === board && f.revision === revision) ?? files.find((f) => f.board === board && f.revision === undefined);
}

/**
 * Lay each board's builds over its placed parts: per build, which refs it
 * omits and bridges (`buildPopulation`, settings folded in) and which
 * definitions it produced. A board with no build file has one `as-designed`
 * build with everything fitted.
 */
export function boardPartsWithBuilds(
  entries: readonly BoardPartsEntry[],
  files: readonly BoardBuilds[],
  pcbas: readonly PcbaDefinition[],
): BoardPartsEntry[] {
  return entries.map((entry) => {
    const file = buildFileFor(files, entry.board, entry.revision);
    const ofRevision = pcbas.filter((p) => p.partNumber === entry.board && p.revision === entry.revision && p.status !== 'retired');
    const builds: BoardPartsBuild[] =
      file === undefined
        ? [{ key: 'as-designed', build: 'as-designed', defIds: ofRevision.map((p) => p.id).sort(), omitted: [], bridged: [] }]
        : file.builds.map((build) => {
            const population = buildPopulation(file, build);
            return {
              key: build.key,
              build: build.build,
              defIds: definitionsOfBuild(file, build, ofRevision)
                .map((p) => p.id)
                .sort(),
              omitted: [...(population.omitted ?? [])].sort(compareRefs),
              bridged: [...(population.bridged ?? [])].sort(compareRefs),
            };
          });
    return { ...entry, builds };
  });
}

/** The placed parts of one board revision (`revision` omitted: the board's only — or first — entry). */
export function boardPartsOf(db: Pick<Db, 'boardParts'>, board: string, revision?: string): BoardPartsEntry | undefined {
  const all = (db.boardParts ?? []).filter((e) => e.board === board);
  if (revision === undefined) return all[0];
  const want = /^\d+$/.test(revision) ? `Rev${revision}` : revision;
  return all.find((e) => e.revision.toLowerCase() === want.toLowerCase());
}

/** The build of `entry` that produced definition `defId`, if any. */
export function boardBuildOf(entry: BoardPartsEntry, defId: string): BoardPartsBuild | undefined {
  return entry.builds?.find((b) => b.defIds.includes(defId));
}

/** One row of a "Components on this board" table: a component and the refs that place it. */
export interface BoardComponentRow {
  component: string;
  /** the record, when the catalog has it */
  record?: ComponentDefinition;
  category: ComponentCategory;
  /** every ref on the board that places it, natural order */
  refs: string[];
  /** of those, the ones fitted on the build shown (all but omitted and design-DNP) */
  fitted: string[];
  /** fitted as a 0 Ω link / closed jumper on the build shown */
  bridged: string[];
  /** fitted count */
  qty: number;
}

/**
 * Group a board's placed parts by component, with a quantity per group for
 * the build shown (`population`: that build's omitted and bridged refs; none
 * = as designed). Sorted by category (ICs first), then label, then refs.
 */
export function boardComponentRows(
  entry: Pick<BoardPartsEntry, 'parts'>,
  components: readonly ComponentDefinition[],
  population: { omitted?: readonly string[]; bridged?: readonly string[] } = {},
): BoardComponentRow[] {
  const omitted = new Set(population.omitted ?? []);
  const bridged = new Set(population.bridged ?? []);
  const byId = new Map(components.map((c) => [c.id, c]));
  const groups = new Map<string, PlacedPart[]>();
  for (const part of entry.parts) groups.set(part.component, [...(groups.get(part.component) ?? []), part]);
  const rows = [...groups.entries()].map(([id, parts]): BoardComponentRow => {
    const record = byId.get(id);
    const refs = parts.map((p) => p.ref).sort(compareRefs);
    // a design-DNP part is fitted only when a build bridges it (a 0 Ω link across a DNP jumper)
    const fitted = parts.filter((p) => !omitted.has(p.ref) && (p.dnp !== true || bridged.has(p.ref))).map((p) => p.ref).sort(compareRefs);
    return {
      component: id,
      ...(record === undefined ? {} : { record }),
      category: record === undefined ? 'other' : componentCategory(record),
      refs,
      fitted,
      bridged: fitted.filter((r) => bridged.has(r)),
      qty: fitted.length,
    };
  });
  const rank = (c: ComponentCategory): number => CATEGORIES.indexOf(c);
  return rows.sort(
    (a, b) =>
      rank(a.category) - rank(b.category) ||
      (a.record?.label ?? a.component).localeCompare(b.record?.label ?? b.component) ||
      compareRefs(a.refs[0] ?? '', b.refs[0] ?? ''),
  );
}

/** Where a component is used, down to the builds that fit it. */
export interface ComponentBuildUse {
  board: string;
  revision: string;
  refs: string[];
  builds: { key: string; build: string; defIds: string[]; fitted: string[] }[];
}

/** Every board revision and build that places `componentId` (from `db.boardParts`). */
export function componentBuildUses(db: Pick<Db, 'boardParts'>, componentId: string): ComponentBuildUse[] {
  const out: ComponentBuildUse[] = [];
  for (const entry of db.boardParts ?? []) {
    const parts = entry.parts.filter((p) => p.component === componentId);
    if (parts.length === 0) continue;
    const refs = parts.map((p) => p.ref).sort(compareRefs);
    const builds = (entry.builds ?? []).map((b) => {
      const omitted = new Set(b.omitted);
      const bridged = new Set(b.bridged);
      return {
        key: b.key,
        build: b.build,
        defIds: b.defIds,
        fitted: parts.filter((p) => !omitted.has(p.ref) && (p.dnp !== true || bridged.has(p.ref))).map((p) => p.ref).sort(compareRefs),
      };
    });
    out.push({ board: entry.board, revision: entry.revision, refs, builds });
  }
  return out.sort((a, b) => a.board.localeCompare(b.board) || a.revision.localeCompare(b.revision));
}
