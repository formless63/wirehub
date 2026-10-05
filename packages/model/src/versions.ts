/**
 * Design versions (specs/studio-workbench.md "Design
 * versions"): saved, locked, numbered snapshots of a design together with a
 * frozen copy of every definition it references, so an old revision renders
 * exactly as it was released however the Library changes afterwards.
 *
 * Pure and deterministic: every time stamp and name comes in as an argument;
 * frozen definitions are sorted by id and the file's keys come out in one
 * fixed order, so the same inputs always produce the same bytes.
 */

import type {
  CableDesign,
  ComponentDefinition,
  ConnectorDefinition,
  Db,
  Issue,
  Joint,
  MechanicalDefinition,
  PcbaDefinition,
  WireDefinition,
} from './model.ts';
import type { ConnectorBody, Interface } from './interfaces.ts';
import type { SignalTags } from './vocab.ts';
import { jointMoveText } from './design-edit.ts';
import { terminalKey, validateDesign } from './validate.ts';
import { pinSubassemblies, type AssemblyLibrary } from './subassemblies.ts';

export const DESIGN_VERSION_FORMAT = 'wirehub/design-version@2';
/**
 * The first format: `depictions` held one hash per definition and the artwork
 * itself was not kept. Still read (and rendered against today's artwork);
 * never written.
 */
export const DESIGN_VERSION_FORMAT_V1 = 'wirehub/design-version@1';

/**
 * One definition's artwork as a version keeps it: each file of its depiction
 * directory (`meta.json`, `board-top.svg` …) → `sha256:<hex>` of the file's
 * bytes. The bytes themselves are copied next to the version files, stored
 * once per content hash (`_versions/<id>/artwork/<hex>.<ext>`), so a
 * revision that repeats an earlier one's artwork costs nothing more.
 */
export type ArtworkFiles = Record<string, string>;

/** `sha256:<hex>` → the blob's file name in the artwork store (`<hex>.<ext>`). */
export function artworkBlobName(file: string, hash: string): string | undefined {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(hash)?.[1];
  const dot = file.lastIndexOf('.');
  const ext = dot <= 0 ? '' : file.slice(dot + 1).toLowerCase();
  if (hex === undefined || !/^[a-z0-9]{1,8}$/.test(ext)) return undefined;
  return `${hex}.${ext}`;
}

/** The copied artwork of a version file (a v1 file's hash-only entries are not copies). */
export function versionArtwork(file: Pick<DesignVersionFile, 'depictions'>): Record<string, ArtworkFiles> {
  const out: Record<string, ArtworkFiles> = {};
  for (const [defId, entry] of Object.entries(file.depictions ?? {})) {
    if (entry !== null && typeof entry === 'object') out[defId] = entry;
  }
  return out;
}

/** The definitions a version was released against — only the ones it references. */
export interface FrozenDefinitions {
  connectors: ConnectorDefinition[];
  bodies: ConnectorBody[];
  interfaces: Interface[];
  wires: WireDefinition[];
  components: ComponentDefinition[];
  pcbas: PcbaDefinition[];
  mechanicals: MechanicalDefinition[];
  /** the signal-tag rows for the frozen ids (absent when there are none) */
  tags?: SignalTags;
}

export type VersionHistoryAction = 'save' | 'unlock' | 'edit' | 'relock' | 'submit' | 'approve' | 'reject';

/** Where a saved version stands in release approval: absent on the file means draft (not submitted). */
export type ApprovalState = 'submitted' | 'approved' | 'rejected';

/** The latest approval step of a version (the whole trail is in `history`). */
export interface VersionApproval {
  state: ApprovalState;
  /** ISO time stamp of this step */
  at: string;
  /** who took this step */
  by: string;
  /** what they said (required) */
  comment: string;
  /** who submitted it, once it has been approved or rejected */
  submittedBy?: string;
  submittedAt?: string;
}

/** One line of a version's append-only history. */
export interface VersionHistoryEntry {
  action: VersionHistoryAction;
  /** ISO time stamp */
  at: string;
  by: string;
  /** save: the release note · unlock/edit: why it was unlocked · relock: optional */
  note?: string;
  /** edit only: what changed, one line each (`diffLines`) */
  changes?: string[];
}

export interface VersionUnlock {
  at: string;
  by: string;
  reason: string;
}

/** `data/designs/_versions/<id>/<rev>.json`. */
export interface DesignVersionFile {
  format: typeof DESIGN_VERSION_FORMAT | typeof DESIGN_VERSION_FORMAT_V1;
  designId: string;
  rev: number;
  savedAt: string;
  savedBy: string;
  note: string;
  /** the revision the working copy descended from when this one was saved */
  basedOnRev?: number;
  design: CableDesign;
  definitions: FrozenDefinitions;
  /**
   * definition id → its artwork files, copied at save time (`ArtworkFiles`);
   * the revision renders these, never today's artwork. A definition with no
   * artwork when saved has no entry. (v1 files: one hash string, no copy.)
   */
  depictions: Record<string, ArtworkFiles | string>;
  /** present only while the version is unlocked for an edit */
  unlocked?: VersionUnlock;
  /** release approval (cs-5k1.11): absent = draft; an approved version is the released one */
  approval?: VersionApproval;
  history: VersionHistoryEntry[];
}

/** What a version list shows per revision — everything but the heavy payload. */
export interface VersionSummary {
  rev: number;
  savedAt: string;
  savedBy: string;
  note: string;
  basedOnRev?: number;
  locked: boolean;
  /** how many recorded edits since it was saved */
  edits: number;
  /** the approval state, name, time and comment of the latest step; absent = draft */
  approval?: VersionApproval;
}

export function versionSummary(file: DesignVersionFile): VersionSummary {
  return {
    rev: file.rev,
    savedAt: file.savedAt,
    savedBy: file.savedBy,
    note: file.note,
    ...(file.basedOnRev === undefined ? {} : { basedOnRev: file.basedOnRev }),
    locked: file.unlocked === undefined,
    edits: file.history.filter((entry) => entry.action === 'edit').length,
    ...(file.approval === undefined ? {} : { approval: file.approval }),
  };
}

/* ------------------------------------------------------------------ *
 * Freezing
 * ------------------------------------------------------------------ */

function byId<T extends { id: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function pick<T extends { id: string }>(list: readonly T[] | undefined, ids: ReadonlySet<string>): T[] {
  return byId((list ?? []).filter((item) => ids.has(item.id)));
}

function pickRecord<V>(record: Record<string, V> | undefined, ids: ReadonlySet<string>): Record<string, V> | undefined {
  if (record === undefined) return undefined;
  const out: Record<string, V> = {};
  for (const key of Object.keys(record).sort()) {
    if (ids.has(key)) out[key] = record[key] as V;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The definition ids a design names, by list. */
export function referencedDefinitionIds(design: CableDesign, db: Db): {
  connectors: Set<string>;
  wires: Set<string>;
  components: Set<string>;
  pcbas: Set<string>;
  mechanicals: Set<string>;
} {
  const connectors = new Set(design.instances.connectors.map((i) => i.def));
  const pcbas = new Set(design.instances.pcbas.map((i) => i.def));
  // a board's own connector (a SCART head on the PCB) is drawn from its definition
  for (const pcba of db.pcbas) {
    if (!pcbas.has(pcba.id)) continue;
    for (const integrated of pcba.integratedConnectors ?? []) connectors.add(integrated.connectorDefId);
  }
  const mechanicals = new Set((design.instances.mechanical ?? []).map((i) => i.def));
  // the contacts, seals and plugs in its cavities, and the tools that crimp them
  for (const instance of design.instances.connectors) {
    for (const cavity of instance.cavities ?? []) {
      for (const id of [cavity.contact, cavity.seal, cavity.plug]) {
        if (id === undefined) continue;
        mechanicals.add(id);
        const spec = (db.mechanicals ?? []).find((m) => m.id === id)?.termination;
        if (spec?.tool !== undefined) mechanicals.add(spec.tool);
        for (const extra of spec?.tools ?? []) mechanicals.add(extra.tool);
      }
      if (cavity.tool !== undefined) mechanicals.add(cavity.tool);
    }
  }
  return {
    connectors,
    wires: new Set(design.instances.segments.map((i) => i.def)),
    components: new Set(design.instances.components.map((i) => i.def)),
    pcbas,
    mechanicals,
  };
}

/** A frozen copy of every definition `design` references in `db`. Deep copies. */
export function freezeDefinitions(design: CableDesign, db: Db): FrozenDefinitions {
  const ids = referencedDefinitionIds(design, db);
  const connectors = pick(db.connectors, ids.connectors);
  const bodyIds = new Set(connectors.flatMap((c) => (c.body === undefined ? [] : [c.body])));
  const interfaceIds = new Set(connectors.flatMap((c) => (c.interface === undefined ? [] : [c.interface])));
  const tags: SignalTags | undefined =
    db.tags === undefined
      ? undefined
      : (() => {
          const connectorsTags = pickRecord(db.tags.connectors, ids.connectors);
          const pcbaTags = pickRecord(db.tags.pcbas, ids.pcbas);
          const wireTags = pickRecord(db.tags.wires, ids.wires);
          if (connectorsTags === undefined && pcbaTags === undefined && wireTags === undefined) return undefined;
          return {
            src: db.tags.src,
            ...(connectorsTags === undefined ? {} : { connectors: connectorsTags }),
            ...(pcbaTags === undefined ? {} : { pcbas: pcbaTags }),
            ...(wireTags === undefined ? {} : { wires: wireTags }),
          };
        })();
  const frozen: FrozenDefinitions = {
    connectors,
    bodies: pick(db.bodies, bodyIds),
    interfaces: pick(db.interfaces, interfaceIds),
    wires: pick(db.wires, ids.wires),
    components: pick(db.components, ids.components),
    pcbas: pick(db.pcbas, ids.pcbas),
    mechanicals: pick(db.mechanicals, ids.mechanicals),
    ...(tags === undefined ? {} : { tags }),
  };
  return JSON.parse(JSON.stringify(frozen)) as FrozenDefinitions;
}

function overlay<T extends { id: string }>(frozen: readonly T[], live: readonly T[] | undefined): T[] {
  const ids = new Set(frozen.map((item) => item.id));
  return [...frozen, ...(live ?? []).filter((item) => !ids.has(item.id))];
}

/**
 * The library a version renders and validates against: its frozen
 * definitions win; the live library only supplies what the version never
 * referenced (vocab, kits, and parts added while an unlocked version is edited).
 * Without `live`, the frozen definitions alone.
 */
export function versionDb(definitions: FrozenDefinitions, live?: Db): Db {
  const tags: SignalTags | undefined =
    definitions.tags === undefined
      ? live?.tags
      : {
          src: definitions.tags.src,
          connectors: { ...(live?.tags?.connectors ?? {}), ...(definitions.tags.connectors ?? {}) },
          pcbas: { ...(live?.tags?.pcbas ?? {}), ...(definitions.tags.pcbas ?? {}) },
          wires: { ...(live?.tags?.wires ?? {}), ...(definitions.tags.wires ?? {}) },
        };
  return {
    connectors: overlay(definitions.connectors, live?.connectors),
    wires: overlay(definitions.wires, live?.wires),
    components: overlay(definitions.components, live?.components),
    pcbas: overlay(definitions.pcbas, live?.pcbas),
    mechanicals: overlay(definitions.mechanicals, live?.mechanicals),
    bodies: overlay(definitions.bodies, live?.bodies),
    interfaces: overlay(definitions.interfaces, live?.interfaces),
    ...(live?.vocab === undefined ? {} : { vocab: live.vocab }),
    ...(live?.kits === undefined ? {} : { kits: live.kits }),
    ...(tags === undefined ? {} : { tags }),
  };
}

/**
 * A version must validate against its own frozen definitions. Given the
 * sub-assembly library, the designs it places are checked too (they are
 * pinned to saved versions, so they are as frozen as it is).
 */
export function validateVersion(file: DesignVersionFile, assemblies?: AssemblyLibrary): Issue[] {
  const issues: Issue[] = [];
  if (file.format !== DESIGN_VERSION_FORMAT && file.format !== DESIGN_VERSION_FORMAT_V1) {
    issues.push({ code: 'version-format', severity: 'error', message: `unknown version format '${String(file.format)}'` });
  }
  if (!Number.isInteger(file.rev) || file.rev < 0) {
    issues.push({ code: 'version-rev', severity: 'error', message: `revision ${String(file.rev)} is not a whole number` });
  }
  if (file.design?.id !== file.designId) {
    issues.push({ code: 'version-id', severity: 'error', message: `the snapshot is of '${String(file.design?.id)}', not '${file.designId}'` });
  }
  if (typeof file.note !== 'string' || file.note.trim() === '') {
    issues.push({ code: 'version-note', severity: 'error', message: 'a saved version needs a note' });
  }
  for (const [defId, files] of Object.entries(versionArtwork(file))) {
    for (const [name, hash] of Object.entries(files)) {
      if (name.includes('/') || name.includes('\\') || name.startsWith('.') || artworkBlobName(name, hash) === undefined) {
        issues.push({ code: 'version-artwork', severity: 'error', message: `the artwork copy of '${defId}' names an unusable file '${name}' (${hash})` });
      }
    }
  }
  if (issues.some((issue) => issue.severity === 'error')) return issues;
  const db = versionDb(file.definitions);
  return [...issues, ...validateDesign(file.design, assemblies === undefined ? db : { ...db, assemblies })];
}

/* ------------------------------------------------------------------ *
 * Building and editing files
 * ------------------------------------------------------------------ */

/**
 * The number the next saved version takes: `latest + 1`, or — for a design's
 * first version — the drawing's own numeric revision when it has one (the
 * paper already says that number), else 0.
 */
export function nextRevision(existing: readonly number[], drawingRevision?: string): number {
  if (existing.length > 0) return Math.max(...existing) + 1;
  const match = drawingRevision === undefined ? null : /^\s*(?:rev\.?\s*)?(\d+)\s*$/i.exec(drawingRevision);
  return match === null ? 0 : Number(match[1]);
}

function sortedKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The file's keys in one fixed order, so the same version is always the same bytes. */
export function canonicalVersionFile(file: DesignVersionFile): DesignVersionFile {
  const d = file.definitions;
  return {
    format: file.format === DESIGN_VERSION_FORMAT_V1 ? DESIGN_VERSION_FORMAT_V1 : DESIGN_VERSION_FORMAT,
    designId: file.designId,
    rev: file.rev,
    savedAt: file.savedAt,
    savedBy: file.savedBy,
    note: file.note,
    ...(file.basedOnRev === undefined ? {} : { basedOnRev: file.basedOnRev }),
    design: file.design,
    definitions: {
      connectors: byId(d.connectors),
      bodies: byId(d.bodies),
      interfaces: byId(d.interfaces),
      wires: byId(d.wires),
      components: byId(d.components),
      pcbas: byId(d.pcbas),
      mechanicals: byId(d.mechanicals),
      ...(d.tags === undefined ? {} : { tags: d.tags }),
    },
    depictions: Object.fromEntries(
      Object.entries(file.depictions)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([defId, entry]) => [defId, typeof entry === 'string' ? entry : sortedKeys(entry)]),
    ),
    ...(file.unlocked === undefined ? {} : { unlocked: file.unlocked }),
    ...(file.approval === undefined ? {} : { approval: file.approval }),
    history: file.history,
  };
}

/** 2-space JSON with a trailing newline, keys in the canonical order. */
export function formatVersionJson(file: DesignVersionFile): string {
  return `${JSON.stringify(canonicalVersionFile(file), null, 2)}\n`;
}

export interface NewVersionInput {
  design: CableDesign;
  db: Db;
  rev: number;
  at: string;
  by: string;
  note: string;
  basedOnRev?: number;
  /** defId → its artwork files' hashes, from the host (it owns and copies the bytes) */
  depictions?: Record<string, ArtworkFiles>;
}

/**
 * A new saved version. With `db.assemblies`, every sub-assembly that follows
 * a working copy is pinned to that design's released revision
 * (`pinSubassemblies`), so the version always names the same parts; callers
 * refuse the save first when one has nothing released.
 */
export function createVersion(input: NewVersionInput): DesignVersionFile {
  const note = input.note.trim();
  const design = pinSubassemblies(input.design, input.db).design;
  return canonicalVersionFile({
    format: DESIGN_VERSION_FORMAT,
    designId: input.design.id,
    rev: input.rev,
    savedAt: input.at,
    savedBy: input.by,
    note,
    ...(input.basedOnRev === undefined ? {} : { basedOnRev: input.basedOnRev }),
    design: JSON.parse(JSON.stringify(design)) as CableDesign,
    definitions: freezeDefinitions(design, input.db),
    depictions: input.depictions ?? {},
    history: [{ action: 'save', at: input.at, by: input.by, note }],
  });
}

export function unlockVersion(file: DesignVersionFile, at: string, by: string, reason: string): DesignVersionFile {
  const why = reason.trim();
  return canonicalVersionFile({
    ...file,
    unlocked: { at, by, reason: why },
    history: [...file.history, { action: 'unlock', at, by, note: why }],
  });
}

export function relockVersion(file: DesignVersionFile, at: string, by: string, note?: string): DesignVersionFile {
  const { unlocked: _unlocked, ...rest } = file;
  const why = note?.trim();
  return canonicalVersionFile({
    ...rest,
    history: [...file.history, { action: 'relock', at, by, ...(why === undefined || why === '' ? {} : { note: why }) }],
  });
}

/** What an approval step is refused for, or `undefined` when it may go ahead. */
export function approvalStepProblem(file: DesignVersionFile, step: 'submit' | 'approve' | 'reject'): string | undefined {
  const state = file.approval?.state;
  if (file.unlocked !== undefined) return `Rev ${file.rev} is unlocked for an edit — lock it again first.`;
  if (step === 'submit') {
    if (state === 'submitted') return `Rev ${file.rev} is already waiting for approval.`;
    if (state === 'approved') return `Rev ${file.rev} is already approved.`;
    return undefined;
  }
  if (state !== 'submitted') return `Rev ${file.rev} is ${state === undefined ? 'a draft that has not been submitted' : state}, so there is nothing to ${step}.`;
  return undefined;
}

/** Submit a version for approval (a rejected one may be submitted again). A comment is required. */
export function submitVersion(file: DesignVersionFile, at: string, by: string, comment: string): DesignVersionFile {
  const note = comment.trim();
  return canonicalVersionFile({
    ...file,
    approval: { state: 'submitted', at, by, comment: note },
    history: [...file.history, { action: 'submit', at, by, note }],
  });
}

function decideVersion(file: DesignVersionFile, state: 'approved' | 'rejected', at: string, by: string, comment: string): DesignVersionFile {
  const note = comment.trim();
  const submitted = file.approval?.state === 'submitted' ? file.approval : undefined;
  return canonicalVersionFile({
    ...file,
    approval: {
      state,
      at,
      by,
      comment: note,
      ...(submitted === undefined ? {} : { submittedBy: submitted.by, submittedAt: submitted.at }),
    },
    history: [...file.history, { action: state === 'approved' ? 'approve' : 'reject', at, by, note }],
  });
}

export const approveVersion = (file: DesignVersionFile, at: string, by: string, comment: string): DesignVersionFile => decideVersion(file, 'approved', at, by, comment);
export const rejectVersion = (file: DesignVersionFile, at: string, by: string, comment: string): DesignVersionFile => decideVersion(file, 'rejected', at, by, comment);

/** The released revision of a design: the latest approved one when approvals are on, else the latest saved. */
export function releasedRevision(summaries: readonly Pick<VersionSummary, 'rev' | 'approval'>[], approvalsOn: boolean): number | undefined {
  const pool = approvalsOn ? summaries.filter((s) => s.approval?.state === 'approved') : summaries;
  return pool.length === 0 ? undefined : Math.max(...pool.map((s) => s.rev));
}

/**
 * An unlocked version's edit: the new design, re-frozen (definitions the
 * version already had stay frozen; new ones come from `live`), the change
 * recorded under the unlock's reason, and the version locked again.
 */
export function editVersion(
  file: DesignVersionFile,
  design: CableDesign,
  live: Db,
  at: string,
  by: string,
  depictions?: Record<string, ArtworkFiles>,
): DesignVersionFile {
  const reason = file.unlocked?.reason ?? '';
  const db = versionDb(file.definitions, live);
  // a sub-assembly added in the edit is frozen like the rest
  design = pinSubassemblies(design, live.assemblies === undefined ? db : { ...db, assemblies: live.assemblies }).design;
  const definitions = freezeDefinitions(design, db);
  const before = { design: file.design, definitions: file.definitions };
  const after = { design, definitions };
  const changes = diffLines(diffVersions(before, after));
  // changed content is no longer what was approved: it goes back to draft (the trail stays in history)
  const { unlocked: _unlocked, approval: _approval, ...rest } = file;
  return canonicalVersionFile({
    ...rest,
    design: JSON.parse(JSON.stringify(design)) as CableDesign,
    definitions,
    // artwork the version already kept stays its own; only parts new to it take today's copy
    depictions: { ...(depictions ?? {}), ...file.depictions },
    history: [...file.history, { action: 'edit', at, by, note: reason, changes }],
  });
}

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

type InstanceList = 'connectors' | 'segments' | 'components' | 'pcbas' | 'mechanical' | 'breakouts' | 'subassemblies';
const INSTANCE_LISTS: readonly InstanceList[] = ['connectors', 'segments', 'components', 'pcbas', 'mechanical', 'breakouts', 'subassemblies'];
const LIST_NOUN: Record<InstanceList, string> = {
  subassemblies: 'sub-assembly',
  connectors: 'connector',
  segments: 'wire',
  components: 'component',
  pcbas: 'board',
  mechanical: 'mechanical',
  breakouts: 'breakout',
};

type DefinitionList = Exclude<keyof FrozenDefinitions, 'tags'>;
const DEFINITION_LISTS: readonly DefinitionList[] = ['connectors', 'bodies', 'interfaces', 'wires', 'components', 'pcbas', 'mechanicals'];
const DEF_NOUN: Record<DefinitionList, string> = {
  connectors: 'connector',
  bodies: 'body',
  interfaces: 'interface',
  wires: 'wire stock',
  components: 'component',
  pcbas: 'board',
  mechanicals: 'mechanical',
};

export interface InstanceChange {
  kind: string;
  id: string;
  /** added/removed: the definition; changed: which fields */
  detail: string;
}

export interface DesignDiff {
  instances: { added: InstanceChange[]; removed: InstanceChange[]; changed: InstanceChange[] };
  /**
   * `moved`: a joint that lost one landing and gained
   * another while keeping its other end — a re-pin — as one line, with the
   * note it carried when the move dropped it: "moved w1:core-purple.center@b
   * from j1:15 to j1:4 (note was: "…")". Such a pair is in neither
   * `added` nor `removed`.
   */
  joints: { added: string[]; removed: string[]; moved: string[] };
  definitions: { added: string[]; removed: string[]; changed: string[] };
  /** top-level facts: label, status, notes, recipe, src … */
  fields: string[];
}

/** Stable JSON: object keys sorted at every level. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function refText(ref: Joint['a']): string {
  return `${terminalKey(ref)}${ref.pad === undefined ? '' : ` [${ref.pad}]`}`;
}

/** A joint as one line, the same whichever way round it was drawn. */
export function jointText(joint: Joint): string {
  const [a, b] = [refText(joint.a), refText(joint.b)].sort();
  return `${a} — ${b}`;
}

/**
 * Joints added, removed and moved. A removed joint and an added one that
 * share exactly one landing (and are not the same terminal twice) are a
 * re-pin: the shared landing is the end that stayed, and the pair is
 * reported once as a move. Pairing is greedy in joint-list order, which is
 * what a re-pin keeps (`moveJointEnds` edits the joint in place).
 */
function diffJoints(before: readonly Joint[], after: readonly Joint[]): { added: string[]; removed: string[]; moved: string[] } {
  const textsBefore = new Set(before.map(jointText));
  const textsAfter = new Set(after.map(jointText));
  const gone = before.filter((j) => !textsAfter.has(jointText(j)));
  const fresh = after.filter((j) => !textsBefore.has(jointText(j)));
  const moved: string[] = [];
  const usedFresh = new Set<number>();
  const pairedGone = new Set<number>();
  gone.forEach((old, g) => {
    const oldEnds = [refText(old.a), refText(old.b)];
    if (oldEnds[0] === oldEnds[1]) return;
    const at = fresh.findIndex((next, f) => {
      if (usedFresh.has(f)) return false;
      const newEnds = [refText(next.a), refText(next.b)];
      if (newEnds[0] === newEnds[1]) return false;
      return oldEnds.filter((end) => newEnds.includes(end)).length === 1;
    });
    const next = fresh[at];
    if (next === undefined) return;
    usedFresh.add(at);
    pairedGone.add(g);
    const newEnds = [refText(next.a), refText(next.b)];
    const kept = oldEnds.find((end) => newEnds.includes(end))!;
    const from = oldEnds.find((end) => end !== kept)!;
    const to = newEnds.find((end) => end !== kept)!;
    moved.push(jointMoveText(kept, from, to, next.note === undefined ? old.note : undefined));
  });
  return {
    added: [...new Set(fresh.filter((_, f) => !usedFresh.has(f)).map(jointText))].sort(),
    removed: [...new Set(gone.filter((_, g) => !pairedGone.has(g)).map(jointText))].sort(),
    moved: moved.sort(),
  };
}

/**
 * A design-only change log: `diffLines` of two designs with no frozen
 * definitions — what the studio's backup commit lists under a design save.
 */
export function designChangeLines(before: CableDesign, after: CableDesign): string[] {
  const none: FrozenDefinitions = { connectors: [], bodies: [], interfaces: [], wires: [], components: [], pcbas: [], mechanicals: [] };
  return diffLines(diffVersions({ design: before, definitions: none }, { design: after, definitions: none }));
}

export interface VersionContent {
  design: CableDesign;
  definitions: FrozenDefinitions;
}

/** What changed from `before` to `after`. */
export function diffVersions(before: VersionContent, after: VersionContent): DesignDiff {
  const diff: DesignDiff = {
    instances: { added: [], removed: [], changed: [] },
    joints: { added: [], removed: [], moved: [] },
    definitions: { added: [], removed: [], changed: [] },
    fields: [],
  };
  for (const list of INSTANCE_LISTS) {
    const from = new Map(((before.design.instances[list] ?? []) as { id: string; def: string }[]).map((i) => [i.id, i]));
    const to = new Map(((after.design.instances[list] ?? []) as { id: string; def: string }[]).map((i) => [i.id, i]));
    for (const [id, item] of to) {
      const old = from.get(id);
      if (old === undefined) {
        diff.instances.added.push({ kind: LIST_NOUN[list], id, detail: item.def ?? '' });
        continue;
      }
      const keys = [...new Set([...Object.keys(old), ...Object.keys(item)])].sort();
      const fields = keys.filter(
        (key) => stableJson((old as unknown as Record<string, unknown>)[key]) !== stableJson((item as unknown as Record<string, unknown>)[key]),
      );
      if (fields.length > 0) diff.instances.changed.push({ kind: LIST_NOUN[list], id, detail: fields.join(', ') });
    }
    for (const [id, item] of from) {
      if (!to.has(id)) diff.instances.removed.push({ kind: LIST_NOUN[list], id, detail: item.def ?? '' });
    }
  }
  Object.assign(diff.joints, diffJoints(before.design.joints, after.design.joints));

  for (const list of DEFINITION_LISTS) {
    const from = new Map((before.definitions[list] as { id: string }[]).map((d) => [d.id, stableJson(d)]));
    const to = new Map((after.definitions[list] as { id: string }[]).map((d) => [d.id, stableJson(d)]));
    for (const [id, text] of to) {
      const old = from.get(id);
      if (old === undefined) diff.definitions.added.push(`${DEF_NOUN[list]} ${id}`);
      else if (old !== text) diff.definitions.changed.push(`${DEF_NOUN[list]} ${id}`);
    }
    for (const id of from.keys()) {
      if (!to.has(id)) diff.definitions.removed.push(`${DEF_NOUN[list]} ${id}`);
    }
  }

  const b = before.design as unknown as Record<string, unknown>;
  const a = after.design as unknown as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    if (key === 'instances' || key === 'joints') continue;
    if (stableJson(b[key]) !== stableJson(a[key])) diff.fields.push(key);
  }
  return diff;
}

export function diffIsEmpty(diff: DesignDiff): boolean {
  return diffLines(diff).length === 0;
}

/** The diff as short lines, `+` added, `−` removed, `~` changed. */
export function diffLines(diff: DesignDiff): string[] {
  return [
    ...diff.fields.map((field) => `~ ${field}`),
    ...diff.instances.added.map((c) => `+ ${c.kind} ${c.id} (${c.detail})`),
    ...diff.instances.removed.map((c) => `− ${c.kind} ${c.id} (${c.detail})`),
    ...diff.instances.changed.map((c) => `~ ${c.kind} ${c.id}: ${c.detail}`),
    ...diff.joints.added.map((j) => `+ joint ${j}`),
    ...diff.joints.removed.map((j) => `− joint ${j}`),
    ...diff.joints.moved.map((j) => `~ ${j}`),
    ...diff.definitions.added.map((d) => `+ definition ${d}`),
    ...diff.definitions.removed.map((d) => `− definition ${d}`),
    ...diff.definitions.changed.map((d) => `~ definition ${d}`),
  ];
}

/** Whether the design bodies differ (what "unreleased changes" means). */
export function designsDiffer(a: CableDesign, b: CableDesign): boolean {
  return stableJson(a) !== stableJson(b);
}

/**
 * Whether a working copy differs from the version it descends from, setting
 * aside the pins the save added: a sub-assembly that follows a working copy
 * in `working` and was frozen to a revision in `saved` (`pinSubassemblies`)
 * is the same reference.
 */
export function workingDiffers(working: CableDesign, saved: CableDesign): boolean {
  const follows = new Map((working.instances.subassemblies ?? []).filter((s) => s.rev === undefined).map((s) => [s.id, s.def]));
  if (follows.size === 0 || saved.instances.subassemblies === undefined) return designsDiffer(working, saved);
  const subassemblies = saved.instances.subassemblies.map((s) => {
    if (s.rev === undefined || follows.get(s.id) !== s.def) return s;
    const { rev: _frozen, ...rest } = s;
    return rest;
  });
  return designsDiffer(working, { ...saved, instances: { ...saved.instances, subassemblies } });
}
