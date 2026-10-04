/**
 * Breakout moulds on the canvas.
 *
 * A breakout (`instances.breakouts`) is a point along the cable — a mould —
 * where a trunk end meets its legs. It has no terminals of its own in the
 * model, so the canvas gives it a node of its own: a compact mould with one
 * row per conductor of the trunk end. Each row has an **in** handle facing
 * the trunk and, when something leaves the mould on it, an **out** handle
 * facing the legs:
 *
 * - a **through** conductor draws one unbroken run: trunk → in, a line
 *   straight across the mould, out → the same conductor on its leg;
 * - a **terminated** one ends inside the mould on a solder dot; the joints it
 *   is soldered with (to a housed jack, spliced onto a leg) leave from the
 *   mould's out handle instead of the trunk's face — which is where they are;
 * - an **NC** one is listed in the mould, cut back, with its reason.
 *
 * Everything here is presentation: the canvas draws a *view* of the design
 * (`canvasDesign`) in which those runs are extra joints (appended after the
 * real ones, so every real joint keeps its index) and the terminated joints
 * are re-sourced to the mould. Nothing of it is ever written back.
 */

import {
  breakoutFates,
  breakoutsOf,
  findConnector,
  findMechanical,
  findWire,
  pigtailIdOf,
  pigtailKey,
  pigtailMembers,
  segmentElectricalPaths,
  terminalKey,
  type BreakoutFate,
  type BreakoutInstance,
  type CableDesign,
  type ConductorElement,
  type Db,
  type Joint,
  type TerminalRef,
} from '@cable-studio/model';
import { bondFoldedPaths, conductorPaint } from '@cable-studio/render-svg';

import { connectorArt, dockCaption, dockedLayout, type ConnectorArt, type ConnectorArtLayout } from './connector-art.ts';

/** The node kind a mould draws as. */
export const MOULD_KIND = 'breakout' as const;

export type MouldRow = {
  /** the trunk terminal key (`w1:core-red.center@b`), or its pigtail's */
  key: string;
  /** short name: `red`, `red braid`, `drain`, `twist aud` */
  label: string;
  fate: BreakoutFate;
  role: 'conductor' | 'shield' | 'drain' | 'pigtail';
  /** css paint of its swatch / run */
  color?: string;
  /** handle the trunk side lands on */
  inHandle?: string;
  /** handle the run or the solder joints leave from */
  outHandle?: string;
  /** through: where it continues; terminated: what it is soldered to; nc: why */
  detail?: string;
  reason?: string;
};

/**
 * A connector the design houses in the mould (`BreakoutInstance.housed`,
 * — the owner, 2026-09-29: "the female TRS is female and
 * inside the breakout"): drawn as part of the mould itself, its opening
 * facing outward, never as a separate plug on a lead. `art`/`layout` are
 * absent only for a connector definition or family the canvas has no
 * drawing for; the mould still lists it, undrawn.
 */
export interface MouldHoused {
  instanceId: string;
  def: string;
  /** `3.5 mm TRS jack (female)` */
  label: string;
  missingDef: boolean;
  art?: ConnectorArt;
  layout?: ConnectorArtLayout;
}

export type MouldNodeData = {
  kind: typeof MOULD_KIND;
  instanceId: string;
  def: string;
  title: string;
  subtitle: string;
  rows: MouldRow[];
  /** the leg ends' own NC conductors, listed under the rows */
  legNotes: string[];
  missingDef: boolean;
  /** connectors housed inside this mould — drawn here, not on a lead */
  housed: MouldHoused[];
};

const SHIELD_PAINT = '#7a8794';
const DRAIN_PAINT = '#b08a4a';

/** `bk1:in:w1:core-red.center@b` — the in handle of a mould row. */
export function mouldHandle(breakout: string, side: 'in' | 'out', key: string): string {
  return `${breakout}:${side}:${key}`;
}

/** The terminal ref the canvas view uses for a mould handle. */
function mouldRef(breakout: string, side: 'in' | 'out', key: string): TerminalRef {
  return { instance: breakout, terminal: `${side}:${key}` };
}

function shortName(path: string): string {
  const base = path.replace(/^core-/, '');
  if (base.endsWith('.center')) return base.slice(0, -'.center'.length);
  if (base.endsWith('.shield')) return `${base.slice(0, -'.shield'.length)} braid`;
  return base;
}

function refText(ref: TerminalRef): string {
  return `${ref.instance} ${ref.terminal}`;
}

/** The trunk end a breakout sits on, and the design's other things about it, for one mould. */
function trunkOf(design: CableDesign, breakout: BreakoutInstance) {
  return design.instances.segments.find((s) => s.id === breakout.trunk.segment);
}

/**
 * The connectors `breakout.housed` names, drawn as themselves (their own
 * body's art — a female jack for a female definition),
 * facing right: out of the mould, the same way the legs run.
 */
function housedOf(design: CableDesign, db: Db, breakout: BreakoutInstance): MouldHoused[] {
  return (breakout.housed ?? []).map((id): MouldHoused => {
    const instance = design.instances.connectors.find((c) => c.id === id);
    const def = instance === undefined ? undefined : findConnector(db, instance.def);
    const label = def?.label ?? instance?.def ?? id;
    if (instance === undefined || def === undefined) {
      return { instanceId: id, def: instance?.def ?? id, label, missingDef: true };
    }
    const body = def.body === undefined ? undefined : (db.bodies ?? []).find((candidate) => candidate.id === def.body);
    const art = connectorArt({ def, facing: 'right', ...(body === undefined ? {} : { body }) });
    if (art === undefined) return { instanceId: id, def: instance.def, label, missingDef: false };
    return { instanceId: id, def: instance.def, label, missingDef: false, art, layout: dockedLayout(art, dockCaption(art, id)) };
  });
}

/** The node data of every mould. */
export function mouldNodes(design: CableDesign, db: Db): { id: string; data: MouldNodeData }[] {
  const fates = breakoutFates(design, db);
  return breakoutsOf(design).map((breakout) => {
    const trunk = trunkOf(design, breakout);
    const wire = trunk === undefined ? undefined : findWire(db, trunk.def);
    const end = breakout.trunk.end;
    const rows: MouldRow[] = [];
    const landings = (key: string): TerminalRef[] =>
      design.joints.flatMap((j) => (terminalKey(j.a) === key ? [j.b] : terminalKey(j.b) === key ? [j.a] : []));
    if (trunk !== undefined && wire !== undefined) {
      const folded = bondFoldedPaths(wire);
      const twisted = new Map<string, string>();
      for (const p of trunk.pigtails ?? []) {
        if (p.end !== end) continue;
        for (const m of pigtailMembers(wire, p)) twisted.set(m, p.id);
      }
      for (const path of segmentElectricalPaths(wire, trunk)) {
        if (folded.has(path)) continue;
        const key = terminalKey({ instance: trunk.id, terminal: path, end });
        const fate = fates.get(key);
        const element = wire.structure && findElement(wire, path);
        const role: MouldRow['role'] =
          element?.kind === 'shield' ? 'shield' : element?.kind === 'conductor' && element.bare === true ? 'drain' : 'conductor';
        // a conductor's theme token when it has one (black reads on the dark theme too)
        const name = (element as ConductorElement | undefined)?.color?.toLowerCase();
        const color =
          role === 'shield'
            ? SHIELD_PAINT
            : role === 'drain'
              ? DRAIN_PAINT
              : name === undefined
                ? conductorPaint(undefined)
                : `var(--cond-${name}, ${conductorPaint(name)})`;
        const kind = fate?.fate ?? 'nc';
        const row: MouldRow = { key, label: shortName(path), fate: kind, role, color };
        if (kind === 'through') {
          row.inHandle = mouldHandle(breakout.id, 'in', key);
          row.outHandle = mouldHandle(breakout.id, 'out', key);
          if (fate?.peer !== undefined) row.detail = `→ ${fate.peer.instance}`;
        } else if (kind === 'terminated') {
          row.inHandle = mouldHandle(breakout.id, 'in', key);
          const own = landings(key);
          const tail = twisted.get(path);
          if (own.length > 0) {
            row.outHandle = mouldHandle(breakout.id, 'out', key);
            row.detail = `→ ${own.map(refText).join(', ')}`;
          } else if (tail !== undefined) row.detail = `twist ${tail}`;
        } else if (fate?.reason !== undefined) row.reason = fate.reason;
        rows.push(row);
      }
      for (const p of trunk.pigtails ?? []) {
        if (p.end !== end) continue;
        const key = pigtailKey(trunk.id, p);
        const own = landings(key);
        rows.push({
          key,
          label: `twist ${p.id}`,
          fate: 'terminated',
          role: 'pigtail',
          color: SHIELD_PAINT,
          ...(own.length > 0 ? { outHandle: mouldHandle(breakout.id, 'out', key), detail: `→ ${own.map(refText).join(', ')}` } : {}),
        });
      }
    }
    const legNotes: string[] = [];
    for (const leg of breakout.legs) {
      const seg = design.instances.segments.find((s) => s.id === leg.segment);
      const legWire = seg === undefined ? undefined : findWire(db, seg.def);
      if (seg === undefined || legWire === undefined) continue;
      for (const path of segmentElectricalPaths(legWire, seg)) {
        const fate = fates.get(terminalKey({ instance: seg.id, terminal: path, end: leg.end }));
        if (fate?.fate === 'nc') legNotes.push(`${seg.id} ${shortName(path)} NC${fate.reason === undefined ? '' : ` — ${fate.reason}`}`);
      }
    }
    const mould = breakout.mould === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === breakout.mould);
    const mouldDef = mould === undefined ? undefined : findMechanical(db, mould.def);
    const count = (fate: BreakoutFate): number => rows.filter((row) => row.fate === fate && row.role !== 'pigtail').length;
    return {
      id: breakout.id,
      data: {
        kind: MOULD_KIND,
        instanceId: breakout.id,
        def: mould?.def ?? 'breakout',
        title: mouldDef?.label ?? breakout.role ?? 'Breakout mould',
        subtitle: `${count('through')} through · ${count('terminated')} terminated · ${count('nc')} NC`,
        rows,
        legNotes,
        missingDef: mould !== undefined && mouldDef === undefined,
        housed: housedOf(design, db, breakout),
      },
    };
  });
}

function findElement(wire: NonNullable<ReturnType<typeof findWire>>, path: string) {
  let children = wire.structure.children;
  let found: (typeof children)[number] | undefined;
  for (const id of path.split('.')) {
    found = children.find((c) => c.id === id);
    if (found === undefined) return undefined;
    children = found.kind === 'group' ? found.children : [];
  }
  return found;
}

/** The canvas view of a design: moulds wired in, real joints at their own indices. */
export interface CanvasView {
  design: CableDesign;
  /** a canvas terminal key → the design terminal it stands for (a mould handle → its trunk terminal) */
  origin: ReadonlyMap<string, TerminalRef>;
  /** joints from this index on are the mould's own runs, not solder joints */
  virtualFrom: number;
}

/**
 * The design as the canvas draws it (see the module comment). A design with
 * no breakouts is returned as it is.
 */
export function canvasView(design: CableDesign, db: Db): CanvasView {
  const breakouts = breakoutsOf(design);
  if (breakouts.length === 0) return { design, origin: new Map(), virtualFrom: design.joints.length };
  const fates = breakoutFates(design, db);
  const origin = new Map<string, TerminalRef>();
  const outOf = new Map<string, TerminalRef>();
  const virtual: Joint[] = [];
  for (const breakout of breakouts) {
    const trunk = trunkOf(design, breakout);
    const wire = trunk === undefined ? undefined : findWire(db, trunk.def);
    if (trunk === undefined || wire === undefined) continue;
    const end = breakout.trunk.end;
    const folded = bondFoldedPaths(wire);
    for (const path of segmentElectricalPaths(wire, trunk)) {
      const ref: TerminalRef = { instance: trunk.id, terminal: path, end };
      const key = terminalKey(ref);
      const fate = fates.get(key);
      if (fate === undefined || fate.fate === 'nc' || folded.has(path)) continue;
      const inRef = mouldRef(breakout.id, 'in', key);
      const outRef = mouldRef(breakout.id, 'out', key);
      origin.set(terminalKey(inRef), ref);
      origin.set(terminalKey(outRef), ref);
      virtual.push({ a: ref, b: inRef });
      if (fate.fate === 'through' && fate.peer !== undefined) virtual.push({ a: outRef, b: fate.peer });
      else outOf.set(key, outRef);
    }
    for (const p of trunk.pigtails ?? []) {
      if (p.end !== end) continue;
      const key = pigtailKey(trunk.id, p);
      const outRef = mouldRef(breakout.id, 'out', key);
      origin.set(terminalKey(outRef), { instance: trunk.id, terminal: `pigtail:${p.id}`, end });
      outOf.set(key, outRef);
    }
  }
  // the solder joints of a terminated conductor leave from the mould
  const resource = (ref: TerminalRef): TerminalRef => outOf.get(terminalKey(ref)) ?? ref;
  const joints = design.joints.map((j) => {
    const a = resource(j.a);
    const b = resource(j.b);
    return a === j.a && b === j.b ? j : { ...j, a, b };
  });
  return {
    design: { ...design, joints: [...joints, ...virtual] },
    origin,
    virtualFrom: design.joints.length,
  };
}

/**
 * The same view as the column ranking sees it: each mould a part of its own,
 * so it takes a column between its trunk and its legs.
 */
export function rankView(view: CanvasView): CableDesign {
  const breakouts = breakoutsOf(view.design);
  if (breakouts.length === 0) return view.design;
  return {
    ...view.design,
    instances: {
      ...view.design.instances,
      components: [...view.design.instances.components, ...breakouts.map((b) => ({ id: b.id, def: MOULD_KIND }))],
    },
  };
}

/** The ids of the design's moulds. */
export function mouldIds(design: CableDesign): Set<string> {
  return new Set(breakoutsOf(design).map((b) => b.id));
}

/** Is this handle id a mould's? */
export function isMouldHandle(design: CableDesign, handle: string): boolean {
  const colon = handle.indexOf(':');
  const id = colon < 0 ? handle : handle.slice(0, colon);
  return breakoutsOf(design).some((b) => b.id === id) && pigtailIdOf(handle) === undefined;
}
