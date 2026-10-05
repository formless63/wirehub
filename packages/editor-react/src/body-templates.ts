/**
 * Position layouts per connector family (data model v2 §8 J1).
 *
 * A new body is picked, not typed: the family (vocab `families`), the gender,
 * then one of the family's standard layouts. The layout generates the
 * positions (`1…n`, plus the metal shell where the family has one) and names
 * the builder drawing the body is, so the canvas draws a new body the moment
 * it exists — no upload, no anchoring. "Custom" is any count, with or
 * without a shell, and no built-in drawing.
 *
 * Pure data and functions; no React.
 */

import type { BodyLayoutRecord } from '@wirehub/catalog';
import type { BodyPosition, ConnectorBody } from '@wirehub/model';

import type { BodyDrawing } from './connector-art.ts';

export interface BodyTemplate {
  /** stable key for the picker */
  id: string;
  /** what the picker shows: "DIN-8 270°" */
  label: string;
  /** the body id stem: `din8-270` → `din8-270-male` */
  stem: string;
  /** a built-in drawing, or the name a pack's connector drawing answers to */
  drawing?: BodyDrawing | string;
  positions: BodyPosition[];
}

const SHELL: BodyPosition = { id: 'shell', kind: 'shell' };

/** `1…n`, then the shell when asked. */
export function numberedPositions(count: number, shell: boolean): BodyPosition[] {
  const positions: BodyPosition[] = Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => ({ id: String(i + 1) }));
  return shell ? [...positions, { ...SHELL }] : positions;
}

function numbered(id: string, label: string, stem: string, count: number, shell: boolean, drawing?: BodyDrawing): BodyTemplate {
  return { id, label, stem, positions: numberedPositions(count, shell), ...(drawing === undefined ? {} : { drawing }) };
}

/**
 * The standard layouts, keyed by vocab family id. Each one the builder can
 * draw names its drawing; the counts are the ones `connector-art.ts` places.
 */
export const BODY_TEMPLATES: Readonly<Record<string, readonly BodyTemplate[]>> = {
  din: [
    numbered('din8-270', 'DIN-8 270°', 'din8-270', 8, true, 'din-270'),
    numbered('din8-262', 'DIN-8 262° (horseshoe)', 'din8-262', 8, true, 'din-262'),
  ],
  'mini-din': [
    numbered('minidin9', 'Mini-DIN 9', 'minidin9', 9, true, 'mini-din'),
    numbered('minidin10', 'Mini-DIN 10', 'minidin10', 10, true, 'mini-din'),
  ],
  'd-sub': [
    numbered('de9', 'DE-9', 'de9', 9, true, 'd-sub'),
    numbered('da15', 'DA-15', 'da15', 15, true, 'd-sub'),
    numbered('db23', 'DB-23', 'db23', 23, true, 'd-sub'),
    numbered('db25', 'DB-25', 'db25', 25, true, 'd-sub'),
    numbered('dc37', 'DC-37', 'dc37', 37, true, 'd-sub'),
  ],
  hd15: [numbered('de15', 'HD15 (DE-15)', 'de15', 15, true, 'hd15')],
  rca: [{ id: 'rca', label: 'RCA (tip, sleeve)', stem: 'rca', drawing: 'rca', positions: [{ id: 'tip' }, { id: 'sleeve' }] }],
  bnc: [{ id: 'bnc', label: 'BNC (tip, shell)', stem: 'bnc', drawing: 'bnc', positions: [{ id: 'tip' }, { ...SHELL }] }],
  'trs-3-5mm': [
    { id: 'trs', label: '3.5 mm TRS (tip, ring, sleeve)', stem: 'trs-3-5mm', drawing: 'trs', positions: [{ id: 'tip' }, { id: 'ring' }, { id: 'sleeve' }] },
  ],
};

export const CUSTOM_TEMPLATE = 'custom';

/**
 * Layouts a catalog pack or module registered (`art/body-layouts.json`),
 * by id. The built-in ones above are the base's own families; a pack's
 * come after them in the picker.
 */
const registered = new Map<string, BodyLayoutRecord>();

/** Register a pack's body layouts; returns the function that removes them again. */
export function registerBodyLayouts(layouts: readonly BodyLayoutRecord[]): () => void {
  for (const layout of layouts) registered.set(layout.id, layout);
  return () => {
    for (const layout of layouts) if (registered.get(layout.id) === layout) registered.delete(layout.id);
  };
}

function templateOfLayout(layout: BodyLayoutRecord): BodyTemplate {
  return {
    id: layout.id,
    label: layout.label,
    stem: layout.stem,
    ...(layout.drawing === undefined ? {} : { drawing: layout.drawing }),
    positions: layout.positions.map((p) => (p.kind === undefined ? { id: p.id } : { id: p.id, kind: p.kind })),
  };
}

/** The layouts a family offers, standard ones first, then a pack's; every family also takes "custom". */
export function templatesFor(family: string): readonly BodyTemplate[] {
  const own = BODY_TEMPLATES[family] ?? [];
  if (registered.size === 0) return own;
  const taken = new Set(own.map((t) => t.id));
  const packs = [...registered.values()].filter((layout) => layout.family === family && !taken.has(layout.id)).map(templateOfLayout);
  return packs.length === 0 ? own : [...own, ...packs];
}

/** The standard layout a stored body matches (same positions), when there is one. */
export function templateOfBody(body: Pick<ConnectorBody, 'family' | 'positions'>): BodyTemplate | undefined {
  const ids = body.positions.map((p) => p.id).join(' ');
  return templatesFor(body.family).find((template) => template.positions.map((p) => p.id).join(' ') === ids);
}

/** `din8-270-male`, `din8-270-male-2` … — the first free id for a new body. */
export function suggestBodyId(stem: string, gender: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${stem}-${gender}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The same body as the other gender: what "opposite gender" starts a mate from. */
export function oppositeGenderBody(body: ConnectorBody, taken: Iterable<string>): ConnectorBody {
  const gender = body.gender === 'male' ? 'female' : 'male';
  const stem = body.id.replace(/-(male|female)(-\d+)?$/, '');
  return {
    id: suggestBodyId(stem, gender, taken),
    label: body.label.replace(/\b(male|female)\b/i, gender),
    family: body.family,
    gender,
    positions: body.positions.map((p) => ({ ...p })),
    mates: body.id,
    ...(body.drawing === undefined ? {} : { drawing: body.drawing }),
    src: `Opposite gender of ${body.id} — same positions; ${body.src}`,
  };
}
