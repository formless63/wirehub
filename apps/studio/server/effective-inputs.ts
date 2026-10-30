/**
 * Effective inputs: what a saved version or a job actually used, captured automatically at that
 * boundary. Capturing is not approving — nothing here asks anyone to freeze or release a child first.
 *
 *   GET /api/designs/:id/versions/:rev/inputs     the captured list, and what differs today (stale)
 *
 * A version saved before capture existed has its list derived from the definitions and artwork it
 * froze (`source: 'derived'`, no covers: today's choice is not evidence of the past one).
 */

import { createHash } from 'node:crypto';

import {
  EFFECTIVE_INPUTS_FORMAT,
  findLibraryRecord,
  freezeDefinitions,
  pinSubassemblies,
  revisionFilePath,
  revisionOfRecord,
  stableJson,
  type ArtworkFiles,
  type CableDesign,
  type Db,
  type DesignVersionFile,
  type EffectiveInput,
  type EffectiveInputKind,
  type EffectiveInputs,
  type FrozenDefinitions,
  type RecordRevisionFile,
} from '@wirehub/model';

import type { Awaitable } from './storage/change-set.ts';
import type { DocStore } from './storage/doc-store.ts';
import type { DesignStore } from './designs.ts';
import type { VersionStore } from './versions.ts';
import { withDesignLibrary } from './assemblies.ts';
import { coverPath } from './representations.ts';

export interface InputDeps {
  designs: DesignStore;
  loadDb: () => Awaitable<Db>;
  versions?: VersionStore;
  docs?: DocStore;
  now?: () => string;
}

/** A reference to a design for a job: its working copy, or one saved version. */
export interface DesignRef {
  id: string;
  rev?: number;
}

const LISTS: readonly Exclude<EffectiveInputKind, 'designs'>[] = ['pcbas', 'connectors', 'bodies', 'interfaces', 'wires', 'components', 'mechanicals'];
/** the lists that keep artwork (depictions are per definition id) */
const ART_LISTS: ReadonlySet<string> = new Set(['pcbas', 'connectors', 'wires', 'components', 'mechanicals']);

export const sha256Json = (value: unknown): string => `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
const artworkHash = (files: ArtworkFiles | string | undefined): string | undefined =>
  files === undefined ? undefined : typeof files === 'string' ? files : Object.keys(files).length === 0 ? undefined : sha256Json(files);

const idOf = (record: { id?: string; sku?: string }): string => record.id ?? record.sku ?? '';
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

async function recordRevOf(deps: InputDeps, kind: string, id: string, record: unknown): Promise<number | undefined> {
  const stored = await deps.docs?.read(revisionFilePath(kind, id));
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined;
  return revisionOfRecord(stored as RecordRevisionFile, record)?.rev;
}

async function coverOf(deps: InputDeps, id: string): Promise<{ view: string; lineage: string } | undefined> {
  const choice = await deps.docs?.read(coverPath(id));
  if (typeof choice !== 'object' || choice === null) return undefined;
  const { view, lineage } = choice as { view?: unknown; lineage?: unknown };
  return typeof view === 'string' && typeof lineage === 'string' ? { view, lineage } : undefined;
}

function revisionText(record: Record<string, unknown>): string | undefined {
  const parts = [str(record['revision']), str(record['build'])].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * The list for a design over the definitions it used. `depictions` is the artwork it used (a
 * version's copy or today's hashes); `withCovers` reads today's cover choice (true only when
 * capturing now: a derived list cannot know the cover a past save saw).
 */
export async function inputsOf(
  deps: InputDeps,
  design: CableDesign,
  definitions: FrozenDefinitions,
  depictions: Record<string, ArtworkFiles | string>,
  source: EffectiveInputs['source'],
  options: { withCovers: boolean; at?: string; ref?: DesignRef },
): Promise<EffectiveInputs> {
  const inputs: EffectiveInput[] = [];
  for (const kind of LISTS) {
    for (const def of definitions[kind] as unknown as readonly Record<string, unknown>[]) {
      const id = idOf(def as { id?: string });
      const recordRev = await recordRevOf(deps, kind, id, def);
      const art = ART_LISTS.has(kind) ? artworkHash(depictions[id]) : undefined;
      const cover = kind === 'pcbas' && options.withCovers ? await coverOf(deps, id) : undefined;
      const pn = str(def['partNumber']) ?? str(def['sku']);
      const revision = revisionText(def);
      inputs.push({
        kind,
        id,
        ...(str(def['label']) === undefined ? {} : { label: str(def['label']) }),
        ...(pn === undefined ? {} : { partNumber: pn }),
        ...(revision === undefined ? {} : { revision }),
        ...(recordRev === undefined ? {} : { recordRev }),
        hash: sha256Json(def),
        ...(art === undefined ? {} : { artwork: art }),
        ...(cover === undefined ? {} : { cover }),
      });
    }
  }
  for (const sub of design.instances.subassemblies ?? []) {
    if (inputs.some((i) => i.kind === 'designs' && i.id === sub.def && i.designRev === sub.rev)) continue;
    const placed = sub.rev === undefined ? await deps.designs.read(sub.def) : (await deps.versions?.read(sub.def, sub.rev))?.design;
    inputs.push({
      kind: 'designs',
      id: sub.def,
      ...(placed?.label === undefined ? {} : { label: placed.label }),
      ...(sub.rev === undefined ? {} : { designRev: sub.rev }),
      hash: placed === undefined ? 'missing' : sha256Json({ ...placed, id: sub.def }),
    });
  }
  return {
    format: EFFECTIVE_INPUTS_FORMAT,
    capturedAt: options.at ?? (deps.now ?? (() => new Date().toISOString()))(),
    source,
    ...(options.ref === undefined ? {} : { design: options.ref }),
    inputs,
  };
}

/** A version's own list: stored at save, else derived from what it froze. */
export async function versionInputs(deps: InputDeps, file: DesignVersionFile): Promise<EffectiveInputs> {
  if (file.inputs !== undefined) return file.inputs;
  return inputsOf(deps, file.design, file.definitions, file.depictions, 'derived', { withCovers: false, at: file.savedAt });
}

/**
 * Capture the effective inputs of a design for a job: one saved version's (as it froze them), or
 * the working copy's as the library and artwork stand now. Throws when the design or version is
 * not there.
 */
export async function captureEffectiveInputs(deps: InputDeps, ref: DesignRef): Promise<EffectiveInputs> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  if (ref.rev !== undefined) {
    const file = await deps.versions?.read(ref.id, ref.rev);
    if (file === undefined) throw new Error(`'${ref.id}' has no saved Rev ${ref.rev}`);
    const kept = await versionInputs(deps, file);
    return { ...kept, capturedAt: at, source: 'job', design: { id: ref.id, rev: ref.rev } };
  }
  const working = await deps.designs.read(ref.id);
  if (working === undefined) throw new Error(`there is no design called '${ref.id}'`);
  const live = await withDesignLibrary(deps, working, await deps.loadDb());
  // the job sees each placed design as it stands: a released pin where there is one, else its working copy
  const design = pinSubassemblies(working, live).design;
  const definitions = freezeDefinitions(design, live);
  const ids = LISTS.filter((k) => ART_LISTS.has(k)).flatMap((k) => (definitions[k] as readonly { id: string }[]).map((d) => d.id));
  const art = (await deps.versions?.snapshotArtwork?.(ids))?.files ?? {};
  return inputsOf(deps, design, definitions, art, 'job', { withCovers: true, at, ref: { id: ref.id } });
}

/** `request.design` of a job: `"id"` or `{ id, rev? }`; undefined when the job names no design. */
export function designRefOf(request: Record<string, unknown>): DesignRef | undefined {
  const value = request['design'] ?? request['designId'];
  if (typeof value === 'string' && value !== '') return { id: value };
  if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
    const rev = (value as { rev?: unknown }).rev;
    return { id: (value as { id: string }).id, ...(Number.isInteger(rev) && (rev as number) >= 0 ? { rev: rev as number } : {}) };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * What changed since
 * ------------------------------------------------------------------ */

export interface InputStatus extends EffectiveInput {
  state: 'same' | 'changed' | 'gone';
  /** what differs today: the record itself, its artwork, its chosen cover, a newer saved version */
  changed?: ('record' | 'artwork' | 'cover' | 'newer-version' | 'working-copy')[];
  /** top-level fields of the record that differ (when the version still has its frozen copy) */
  fields?: string[];
  /** today's saved library-record revision it equals, and the newest one */
  nowRecordRev?: number;
  latestRecordRev?: number;
  /** designs: the newest saved version today */
  latestDesignRev?: number;
}

function changedFields(before: Record<string, unknown> | undefined, after: Record<string, unknown>): string[] | undefined {
  if (before === undefined) return undefined;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((k) => stableJson(before[k]) !== stableJson(after[k]));
}

/**
 * Each captured input against today: same, changed (and how), or gone from the library. A
 * version keeps drawing its own copies; this only says the library moved on.
 */
export async function inputsStatus(deps: InputDeps, captured: EffectiveInputs, frozen?: FrozenDefinitions): Promise<InputStatus[]> {
  const db = await deps.loadDb();
  const artIds = captured.inputs.filter((i) => ART_LISTS.has(i.kind) && i.artwork !== undefined).map((i) => i.id);
  const art = artIds.length === 0 ? {} : ((await deps.versions?.snapshotArtwork?.(artIds))?.files ?? {});
  const out: InputStatus[] = [];
  for (const input of captured.inputs) {
    if (input.kind === 'designs') {
      const revs = (await deps.versions?.revisions(input.id)) ?? [];
      const working = await deps.designs.read(input.id);
      if (working === undefined && revs.length === 0) {
        out.push({ ...input, state: 'gone' });
        continue;
      }
      const latest = revs[revs.length - 1];
      const changed: NonNullable<InputStatus['changed']> = [];
      if (input.designRev !== undefined && latest !== undefined && latest > input.designRev) changed.push('newer-version');
      if (input.designRev === undefined && working !== undefined && sha256Json({ ...working, id: input.id }) !== input.hash) changed.push('working-copy');
      out.push({ ...input, state: changed.length === 0 ? 'same' : 'changed', ...(changed.length === 0 ? {} : { changed }), ...(latest === undefined ? {} : { latestDesignRev: latest }) });
      continue;
    }
    const record = findLibraryRecord(db, input.kind, input.id);
    if (record === undefined) {
      out.push({ ...input, state: 'gone' });
      continue;
    }
    const changed: NonNullable<InputStatus['changed']> = [];
    let fields: string[] | undefined;
    if (sha256Json(record) !== input.hash) {
      changed.push('record');
      const before = (frozen?.[input.kind] as unknown as readonly Record<string, unknown>[] | undefined)?.find((d) => idOf(d as { id?: string }) === input.id);
      fields = changedFields(before, record);
    }
    if (input.artwork !== undefined && artworkHash(art[input.id]) !== input.artwork) changed.push('artwork');
    if (input.cover !== undefined) {
      const now = await coverOf(deps, input.id);
      if (now?.view !== input.cover.view || now?.lineage !== input.cover.lineage) changed.push('cover');
    }
    const history = await deps.docs?.read(revisionFilePath(input.kind, input.id));
    const file = typeof history === 'object' && history !== null && !Array.isArray(history) ? (history as RecordRevisionFile) : undefined;
    const nowRev = revisionOfRecord(file, record)?.rev;
    const latestRev = file?.revisions.at(-1)?.rev;
    out.push({
      ...input,
      state: changed.length === 0 ? 'same' : 'changed',
      ...(changed.length === 0 ? {} : { changed }),
      ...(fields === undefined || fields.length === 0 ? {} : { fields }),
      ...(nowRev === undefined ? {} : { nowRecordRev: nowRev }),
      ...(latestRev === undefined ? {} : { latestRecordRev: latestRev }),
    });
  }
  return out;
}

/**
 * The job service's hook (`JobServiceOptions.captureInputs`): the effective inputs of the design a
 * request names, or undefined when it names none. A capture that fails is recorded as such rather
 * than refusing the job: the job reports its own missing design.
 */
export function jobInputCapture(deps: () => InputDeps): (request: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> {
  return async (request) => {
    const ref = designRefOf(request);
    if (ref === undefined) return undefined;
    try {
      return { ...(await captureEffectiveInputs(deps(), ref)) };
    } catch (error) {
      return { format: EFFECTIVE_INPUTS_FORMAT, source: 'job', design: ref, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
