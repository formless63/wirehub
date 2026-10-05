/**
 * The connector journey's state, as pure functions (data model v2 §8 J1).
 * `panels/ConnectorJourney.tsx` is the screen; this is
 * everything it computes, so it can be tested without a DOM.
 *
 * A connector is three records: the **body** (shell, gender, positions — the
 * drawing belongs to it), a **pinout** on that body (a signal per position),
 * and the **connector** designs reference (the pair plus its part number;
 * today's ids keep working). The journey edits all three on
 * one screen and saves them in order: body, pinout, connector.
 */

import {
  composePins,
  resolveVocab,
  signalIds,
  type BodyPosition,
  type Confidence,
  type ConnectorBody,
  type ConnectorDefinition,
  type ConnectorGender,
  type Interface,
  type PinFunction,
  type Vocab,
} from '@wirehub/model';

import { CUSTOM_TEMPLATE, numberedPositions, suggestBodyId, templateOfBody, templatesFor } from './body-templates.ts';
import { housingDraftOf, housingOfDraft, type HousingDraft } from './library.ts';
import { connectorNameOf } from './naming.ts';
import { slugify } from './persistence.ts';
import { signalRefOf, signalText } from './vocab.ts';

/* ------------------------------------------------------------------ *
 * Body
 * ------------------------------------------------------------------ */

export interface BodyDraft {
  id: string;
  label: string;
  family: string;
  gender: ConnectorGender;
  /** a `BODY_TEMPLATES` id, or `custom` */
  template: string;
  /** custom layouts: how many numbered positions, and whether the shell is one */
  count: string;
  shell: boolean;
  partNumber: string;
  mates: string;
  /** a vocab `connector-constructions` id, or '' */
  construction: string;
  src: string;
  /** the positions as stored, for an existing body whose layout is kept */
  positions?: BodyPosition[];
  drawing?: string;
  /** the id and name follow the layout until typed */
  idTouched: boolean;
  labelTouched: boolean;
  /** a stored body keeps its own `drawing` (often none: inferred) until its layout is changed */
  keepDrawing?: boolean;
  /** a crimp housing's cavities (`HousingSpec`) — the usual place for them; absent = none */
  housing?: HousingDraft;
}

export function blankBodyDraft(): BodyDraft {
  return {
    id: '',
    label: '',
    family: '',
    gender: 'male',
    template: '',
    count: '8',
    shell: true,
    partNumber: '',
    mates: '',
    construction: '',
    src: '',
    idTouched: false,
    labelTouched: false,
  };
}

export function bodyDraftOf(body: ConnectorBody): BodyDraft {
  const template = templateOfBody(body);
  const numberedCount = body.positions.filter((p) => /^\d+$/.test(p.id)).length;
  return {
    id: body.id,
    label: body.label,
    family: body.family,
    gender: body.gender,
    template: template?.id ?? CUSTOM_TEMPLATE,
    count: String(numberedCount),
    shell: body.positions.some((p) => p.kind === 'shell'),
    partNumber: body.partNumber ?? '',
    mates: body.mates ?? '',
    construction: body.construction ?? '',
    src: body.src,
    positions: body.positions.map((p) => ({ ...p })),
    ...(body.drawing === undefined ? {} : { drawing: body.drawing }),
    ...(body.housing === undefined ? {} : { housing: housingDraftOf(body.housing) }),
    idTouched: true,
    labelTouched: true,
    keepDrawing: true,
  };
}

/** The positions a draft lays out: its template's, a custom count, or the stored ones. */
export function draftPositions(draft: BodyDraft): BodyPosition[] {
  const template = templatesFor(draft.family).find((t) => t.id === draft.template);
  if (template !== undefined) return template.positions.map((p) => ({ ...p }));
  if (draft.template === CUSTOM_TEMPLATE) {
    const count = Number(draft.count);
    // an existing custom body keeps its own position ids (S1/S2/S3 …) until the count changes
    const stored = draft.positions;
    if (stored !== undefined && stored.filter((p) => /^\d+$/.test(p.id)).length === count && stored.some((p) => p.kind === 'shell') === draft.shell) {
      return stored.map((p) => ({ ...p }));
    }
    return Number.isInteger(count) && count > 0 ? numberedPositions(count, draft.shell) : [];
  }
  return draft.positions?.map((p) => ({ ...p })) ?? [];
}

/** The template's drawing, or the stored body's own when it keeps its layout. */
function draftDrawing(draft: BodyDraft): string | undefined {
  if (draft.keepDrawing === true) return draft.drawing;
  const template = templatesFor(draft.family).find((t) => t.id === draft.template);
  return template?.drawing ?? draft.drawing;
}

/** The body record a draft describes. Key order follows bodies.json. */
export function bodyOfDraft(draft: BodyDraft): ConnectorBody {
  const drawing = draftDrawing(draft);
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    family: draft.family,
    gender: draft.gender,
    positions: draftPositions(draft),
    ...(draft.mates.trim() === '' ? {} : { mates: draft.mates.trim() }),
    ...(draft.partNumber.trim() === '' ? {} : { partNumber: draft.partNumber.trim() }),
    ...(draft.construction === '' ? {} : { construction: draft.construction }),
    ...(drawing === undefined ? {} : { drawing }),
    ...(draft.housing === undefined ? {} : { housing: housingOfDraft(draft.housing) }),
    src: draft.src.trim(),
  };
}

/**
 * A field change, with the id and name following the layout until the user
 * types their own: family DIN + layout 270° + male → `din8-270-male`,
 * "DIN-8 270° male".
 */
export function withBodyField(draft: BodyDraft, patch: Partial<BodyDraft>, taken: readonly string[]): BodyDraft {
  const next: BodyDraft = { ...draft, ...patch };
  if ((patch.family !== undefined && patch.family !== draft.family) || (patch.template !== undefined && patch.template !== draft.template)) {
    next.keepDrawing = false;
  }
  if (patch.family !== undefined && patch.family !== draft.family) {
    // a new family's first standard layout is the likely one
    next.template = templatesFor(next.family)[0]?.id ?? CUSTOM_TEMPLATE;
  }
  const template = templatesFor(next.family).find((t) => t.id === next.template);
  const stem = template?.stem ?? (next.family === '' ? '' : `${next.family}-${draftPositions(next).filter((p) => /^\d+$/.test(p.id)).length}`);
  if (!next.idTouched && stem !== '') next.id = suggestBodyId(stem, next.gender, taken);
  if (!next.labelTouched && template !== undefined) next.label = `${template.label} ${next.gender}`;
  return next;
}

/* ------------------------------------------------------------------ *
 * Pinout
 * ------------------------------------------------------------------ */

export const PIN_DIRS = ['out', 'in', 'bidir', 'passive'] as const;
export const CONFIDENCES: readonly Confidence[] = ['net-verified', 'documented', 'inferred', 'unknown'];

export interface PinoutRow {
  /** vocab signal id, or `a|b` for a `{ oneOf }` */
  signal: string;
  label: string;
  dir: '' | (typeof PIN_DIRS)[number];
  confidence: '' | Confidence;
  note: string;
  /** fields the form does not show (aliases, src), kept as read */
  extra?: Omit<PinFunction, 'signal' | 'label' | 'dir' | 'confidence' | 'note'>;
}

export interface PinoutDraft {
  id: string;
  label: string;
  /** every body it is found on; the journey's body is always one of them */
  bodies: string[];
  /** keyed by body position id; a blank signal leaves the position unassigned */
  rows: Record<string, PinoutRow>;
  src: string;
  /** fields the form does not show (modes, confidence, note), kept as read */
  extra?: Omit<Interface, 'id' | 'label' | 'bodies' | 'pins' | 'src'>;
  idTouched: boolean;
}

function rowOf(fn: PinFunction): PinoutRow {
  const { signal, label, dir, confidence, note, ...extra } = fn;
  return {
    signal: signalText(signal),
    label: label ?? '',
    dir: dir ?? '',
    confidence: confidence ?? '',
    note: note ?? '',
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

export function blankPinoutDraft(bodyId: string): PinoutDraft {
  return { id: '', label: '', bodies: bodyId === '' ? [] : [bodyId], rows: {}, src: '', idTouched: false };
}

export function pinoutDraftOf(iface: Interface): PinoutDraft {
  const { id, label, bodies, pins, src, ...extra } = iface;
  return {
    id,
    label,
    bodies: [...bodies],
    rows: Object.fromEntries(Object.entries(pins).map(([position, fn]) => [position, rowOf(fn)])),
    src,
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
    idTouched: true,
  };
}

/**
 * The pinout record a draft describes, pins in the body's position order
 * (positions of the draft's other bodies that this body lacks are kept after).
 */
export function pinoutOfDraft(draft: PinoutDraft, body: ConnectorBody | undefined): Interface {
  const order = [...(body?.positions.map((p) => p.id) ?? []), ...Object.keys(draft.rows)];
  const pins: Record<string, PinFunction> = {};
  for (const position of order) {
    if (position in pins) continue;
    const row = draft.rows[position];
    if (row === undefined) continue;
    const signal = signalRefOf(row.signal);
    if (signal === undefined) continue;
    pins[position] = {
      signal,
      ...(row.dir === '' ? {} : { dir: row.dir }),
      ...(row.label.trim() === '' ? {} : { label: row.label.trim() }),
      ...(row.extra ?? {}),
      ...(row.note.trim() === '' ? {} : { note: row.note.trim() }),
      ...(row.confidence === '' ? {} : { confidence: row.confidence }),
    };
  }
  return {
    id: draft.id.trim(),
    label: draft.label.trim(),
    bodies: [...draft.bodies],
    pins,
    ...(draft.extra ?? {}),
    src: draft.src.trim(),
  };
}

/** Whether `a` and `b` state the same facts, whatever their key order. */
export function sameRecord(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

const FLIP: Record<string, PinoutRow['dir']> = { out: 'in', in: 'out', bidir: 'bidir', passive: 'passive' };

/**
 * "Copy from…": the rows of `source` laid onto `rows`, position by position,
 * for every position the body has. `mirror` flips each direction — the
 * socket side of a plug's pinout (a console's out is the cable's in).
 */
export function copyPinout(
  rows: Record<string, PinoutRow>,
  source: Interface,
  body: ConnectorBody,
  mirror = false,
): Record<string, PinoutRow> {
  const next = { ...rows };
  for (const position of body.positions) {
    const fn = source.pins[position.id];
    if (fn === undefined) continue;
    const row = rowOf(fn);
    next[position.id] = mirror ? { ...row, dir: row.dir === '' ? '' : (FLIP[row.dir] ?? row.dir) } : row;
  }
  return next;
}

/** How many of `body`'s positions `source` assigns — the "copy from" picker's ranking. */
export function overlap(source: Interface, body: ConnectorBody): number {
  return body.positions.filter((p) => source.pins[p.id] !== undefined).length;
}

/** Suggested pinout id from its label; the label's slug. */
export function suggestPinoutId(label: string, taken: readonly string[]): string {
  const base = slugify(label);
  if (base === '' || !taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/* ------------------------------------------------------------------ *
 * Connector
 * ------------------------------------------------------------------ */

export interface ConnectorIdentity {
  id: string;
  label: string;
  partNumber: string;
  /** a vocab `connector-constructions` id, or '' — the body's applies then */
  construction: string;
  /** a vocab `connector-sourcing` id, or '' — terminated on the bench as normal */
  sourcing: string;
  src: string;
  idTouched: boolean;
  labelTouched: boolean;
}

/**
 * The connector record: identity + the pair, pins composed from them — what
 * every design and renderer reads (the host stores it without the pins).
 * `family` keeps the connector's own words when they already name the body's
 * family; a new connector takes the family's label.
 */
export function composeJourneyConnector(
  identity: ConnectorIdentity,
  body: ConnectorBody,
  iface: Interface,
  vocab: Vocab | undefined,
  baseline?: ConnectorDefinition,
): ConnectorDefinition {
  // a connector's family words are its own (JP21 on the SCART body) while it stays on its body
  const familyWords =
    baseline !== undefined &&
    (baseline.body === body.id || resolveVocab(vocab, 'families', baseline.family)?.entry.id === body.family)
      ? baseline.family
      : (vocab?.['families']?.entries.find((entry) => entry.id === body.family)?.label ?? body.family);
  const partNumber = identity.partNumber.trim();
  const construction = identity.construction.trim();
  const sourcing = identity.sourcing.trim();
  const label = identity.label.trim();
  // a renamed connector keeps its earlier names, so a search for one still finds it
  const earlier = baseline?.aliases ?? [];
  const aliases = baseline !== undefined && baseline.label !== label && !earlier.includes(baseline.label) ? [...earlier, baseline.label] : earlier;
  return {
    id: identity.id.trim(),
    label,
    ...(aliases.length === 0 ? {} : { aliases }),
    family: familyWords,
    gender: body.gender,
    ...(partNumber === '' ? {} : { partNumber }),
    ...(construction === '' ? {} : { construction }),
    ...(sourcing === '' ? {} : { sourcing }),
    pins: composePins(body, iface, vocab),
    src: identity.src.trim(),
    body: body.id,
    interface: iface.id,
  };
}

/**
 * "DIN-8 270° male, PCB mount (the source device / CD AV)" — what a new connector
 * is called until named: the naming rule (`naming.ts`).
 */
export function suggestConnectorLabel(body: ConnectorBody | undefined, iface: Interface | undefined, construction?: string): string {
  return connectorNameOf(body, iface, construction === '' ? undefined : (construction ?? body?.construction));
}

/** The signals a pinout assigns, for a one-line summary. */
export function pinoutSignals(iface: Interface): string[] {
  return Object.values(iface.pins).flatMap((fn) => signalIds(fn.signal));
}
