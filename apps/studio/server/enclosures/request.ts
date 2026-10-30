/**
 * An enclosure record → the `enclosure-generate` request the tool pack reads. Native board
 * geometry is read here (TypeScript owns the KiCad reading, `board-geometry.ts`); the pack only
 * sees plain outlines, holes, footprint boxes and ports, so it never parses a board file.
 *
 * Missing facts are passed on as unknown (`height: null`, `basis: 'unknown'`) for the pack to
 * report; a board with no usable outline is left out with a finding rather than failing the rest.
 */

import { ENCLOSURE_DEFAULTS, type EnclosureBoard, type EnclosureFact, type EnclosureSpec, type PcbaDefinition } from '@wirehub/model';

import { tallestParts, type NativeBoardGeometry } from './board-geometry.ts';
import { padsOnly } from './footprint-heights.ts';

export interface PackFinding { level: 'info' | 'warn' | 'error'; message: string }

/** What the builder needs per board: its native geometry, when it has a readable source. */
/** `exported`: the board's own 3D export (board.glb) was found, whether or not it named every part */
export type NativeLookup = (pcba: string) => Promise<{ geometry: NativeBoardGeometry; source: { path: string; sha256: string }; exported?: boolean } | { missing: string }>;

const fact = (f: EnclosureFact | undefined): { value: number | null; basis: string } =>
  f === undefined ? { value: null, basis: 'unknown' } : { value: f.value, basis: f.basis };
/** The record's fact when it states one, else what the board's source states. */
const stated = (own: EnclosureFact | undefined, source: EnclosureFact | undefined): EnclosureFact | undefined =>
  own !== undefined && own.basis !== 'unknown' && own.value !== null ? own : source ?? own;

export interface BuiltRequest {
  params: Record<string, unknown>;
  findings: PackFinding[];
  /** the native sources read, with their hashes (the run's exact inputs) */
  sources: { pcba: string; path: string; sha256: string }[];
  /** boards that could be generated */
  usable: string[];
}

export async function buildEnclosureRequest(spec: EnclosureSpec, boards: readonly PcbaDefinition[], native: NativeLookup): Promise<BuiltRequest> {
  const findings: PackFinding[] = [];
  const sources: BuiltRequest['sources'] = [];
  const packBoards: Record<string, unknown>[] = [];
  for (const b of spec.boards) {
    const record = boards.find((r) => r.id === b.pcba);
    const label = record?.label ?? b.pcba;
    if (record === undefined) findings.push({ level: 'warn', message: `${b.pcba} is not a board in the Library; its outline must be declared.` });
    const built = await boardFor(b, label, native, findings, sources, spec.params?.assumedPartHeightMm ?? ENCLOSURE_DEFAULTS.assumedPartHeightMm);
    if (built !== undefined) packBoards.push(built);
  }
  const usable = packBoards.map((b) => String(b['id']));
  const occurrences = spec.occurrences
    .filter((o) => usable.includes(o.pcba))
    .map((o) => ({ id: o.id, board: o.pcba, ...(o.xMm === undefined ? {} : { x: o.xMm }), ...(o.yMm === undefined ? {} : { y: o.yMm }), rotation: o.rotationDeg ?? 0 }));
  const p = { ...ENCLOSURE_DEFAULTS, ...(spec.params ?? {}) };
  const enclosure = {
    wall: p.wallMm, floor: p.floorMm, lidThickness: p.lidMm, clearance: p.clearanceMm, topClearance: p.topClearanceMm,
    standoffHeight: p.standoffMm, standoffDiameter: p.standoffDiameterMm, pilotDiameter: p.pilotDiameterMm, cornerRadius: p.cornerRadiusMm,
    defaultComponentHeight: p.assumedPartHeightMm, interiorHeight: spec.params?.interiorHeightMm ?? null,
    lid: { mode: p.lid, splitHeight: spec.params?.splitHeightMm ?? null, lipHeight: p.lipHeightMm, fit: p.fitMm, screws: p.lidScrews },
    vents: { lid: p.ventsLid, sides: p.ventsSides },
  };
  const openings = (spec.openings ?? []).map((o) => ({ id: o.id, label: o.label ?? o.id, face: o.face, u: o.uMm, v: o.vMm, width: o.widthMm, height: o.heightMm, shape: o.shape ?? 'rect' }));
  return { params: { boards: packBoards, occurrences, enclosure, openings }, findings, sources, usable };
}

async function boardFor(b: EnclosureBoard, label: string, native: NativeLookup, findings: PackFinding[], sources: BuiltRequest['sources'], assumedMm: number): Promise<Record<string, unknown> | undefined> {
  const base = { id: b.pcba, label, heightAbove: fact(b.heightAboveMm), heightBelow: fact(b.heightBelowMm) };
  const userPorts = b.ports?.map((q) => ({ id: q.id, label: q.label ?? q.id, edge: q.edge, at: q.atMm, z: q.zMm, width: q.widthMm, height: q.heightMm, shape: q.shape ?? 'rect', protrude: q.protrudeMm ?? 0 }));
  if (b.geometry === 'native') {
    const found = await native(b.pcba);
    if ('missing' in found) {
      findings.push({ level: 'warn', message: `${label}: ${found.missing}` });
      if (b.widthMm?.value == null || b.lengthMm?.value == null) return undefined;
      findings.push({ level: 'info', message: `${label}: using the declared ${b.widthMm.value} × ${b.lengthMm.value} mm rectangle instead.` });
    } else {
      const g = found.geometry;
      sources.push({ pcba: b.pcba, ...found.source });
      if (g.innerLoops > 0) findings.push({ level: 'info', message: `${label}: ${g.innerLoops} inner cut-out(s) in the outline are not modelled in the enclosure dummy.` });
      const facts = g.facts;
      // the record's own per-part heights win over what the source states; the tallest part follows them
      const overrides = Object.fromEntries(Object.entries(b.componentHeights ?? {}).filter(([, f]) => f.value !== null));
      const heights: Record<string, EnclosureFact> = { ...(facts?.componentHeights ?? {}), ...overrides };
      const recomputed = Object.keys(overrides).length === 0 ? undefined : tallestParts(g.footprints, heights);
      // below: the source's figure includes through-hole leads, which an override does not restate
      const tallest = recomputed === undefined ? facts : { heightAboveMm: recomputed.heightAboveMm, heightBelowMm: facts?.heightBelowMm ?? recomputed.heightBelowMm };
      const thickness = stated(b.thicknessMm, facts?.thicknessMm)?.value ?? g.thicknessMm;
      // pads, mounting holes and other footprints nothing stands on are not parts
      const bare = new Set(g.footprints.filter((f) => overrides[f.ref] === undefined && padsOnly({ footprint: f.footprint, models: f.models ?? [], attrs: f.attrs ?? [] })).map((f) => f.ref));
      const counts = { native: 0, estimated: 0, set: Object.keys(overrides).length };
      for (const [ref, f] of Object.entries(facts?.componentHeights ?? {})) if (overrides[ref] === undefined && f.value !== null && !bare.has(ref)) counts[f.basis === 'estimated' ? 'estimated' : 'native'] += 1;
      const unknown = g.footprints.filter((f) => heights[f.ref]?.value == null && !bare.has(f.ref)).map((f) => f.ref);
      if (g.footprints.length > 0) {
        const parts = [
          counts.native > 0 ? `${counts.native} from KiCad source` : '',
          counts.estimated > 0 ? `${counts.estimated} estimated from footprint names` : '',
          counts.set > 0 ? `${counts.set} set on this enclosure` : '',
          unknown.length > 0 ? `unknown: ${unknown.join(', ')} (assumed ${assumedMm} mm until set)` : '',
          bare.size > 0 ? `${bare.size} pad or hole footprint(s) with no part on them left out` : '',
        ].filter((x) => x !== '');
        findings.push({ level: 'info', message: `${label}: part heights — ${parts.join('; ')}.` });
        if (found.exported !== true && !Object.values(facts?.componentHeights ?? {}).some((f) => f.note?.includes('3D model bounds'))) findings.push({ level: 'info', message: `${label}: run the board's 3D export (board outputs) to read part heights from KiCad's own 3D models instead of estimates.` });
      }
      const ports = userPorts ?? g.suggestedPorts.map((q) => ({ id: q.id, label: q.label ?? q.id, edge: q.edge, at: q.atMm, z: q.zMm, width: q.widthMm, height: q.heightMm, shape: q.shape ?? 'rect', protrude: q.protrudeMm ?? 0 }));
      const estimated = g.suggestedPorts.filter((q) => q.basis === 'estimated').length;
      if (b.ports === undefined && ports.length > 0) findings.push({ level: 'info', message: `${label}: ${ports.length} opening(s) placed at edge connectors from the board file; ${estimated === 0 ? 'their heights come from the parts\' 3D models (KiCad source)' : `${estimated} height(s) are estimates until you set them`}.` });
      return {
        ...base, heightAbove: fact(stated(b.heightAboveMm, tallest?.heightAboveMm)), heightBelow: fact(stated(b.heightBelowMm, tallest?.heightBelowMm)),
        basis: 'native', thickness, outline: g.outline,
        // the board's 3D export ran: a part still estimated has no 3D model in the board file
        ...(found.exported === true ? { exported3d: true } : {}),
        holes: g.holes.map((h) => ({ x: h.xMm, y: h.yMm, d: h.diameterMm })),
        components: g.footprints.map((f) => ({ ref: f.ref, x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, side: f.side, height: heights[f.ref]?.value ?? null, basis: heights[f.ref]?.basis ?? 'unknown' })),
        ports,
      };
    }
  }
  const w = b.widthMm?.value;
  const l = b.lengthMm?.value;
  if (w == null || l == null || w <= 0 || l <= 0) {
    findings.push({ level: 'warn', message: `${label}: no outline — declare its width and length, or give the board a KiCad board file.` });
    return undefined;
  }
  const basis = [b.widthMm?.basis, b.lengthMm?.basis].includes('estimated') ? 'estimated' : b.widthMm?.basis === 'measured' && b.lengthMm?.basis === 'measured' ? 'measured' : 'declared';
  return {
    ...base, basis, thickness: b.thicknessMm?.value ?? 1.6,
    outline: [[0, 0], [w, 0], [w, l], [0, l]],
    holes: (b.holes ?? []).map((h) => ({ x: h.xMm, y: h.yMm, d: h.diameterMm })),
    components: [],
    ports: userPorts ?? [],
  };
}
