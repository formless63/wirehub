/**
 * Editing a breakout, in the inspector.
 *
 * Owner, 2026-09-25: "we likely want the ability to add breakout points
 * visually". Every action is one undoable step (`apply-design`, recorded as a
 * hand edit on a recipe design) built from core's pure edits:
 *
 * - **split** a segment at a point into a breakout — everything passes through;
 * - mark each conductor **pass-through / terminated / NC** (terminating a
 *   pass-through splices it back onto its leg in the mould; NC asks why);
 * - **attach a leg** of a stock; **remove** a breakout that is only a split.
 */

import {
  attachBreakoutLeg,
  breakoutAt,
  breakoutFates,
  breakoutsOf,
  findWire,
  isTrimmedFoil,
  removeBreakout,
  segmentElectricalPaths,
  setBreakoutFate,
  splitSegmentAtBreakout,
  terminalKey,
  type BreakoutFate,
  type BreakoutInstance,
  type CableDesign,
  type Db,
} from '@wirehub/model';
import { wireDisplayName } from '@wirehub/docs';
import { bondFoldedPaths } from '@wirehub/render-svg';
import { useState, type JSX } from 'react';

import { useEditorApi } from '../context.ts';
import type { EditorState } from '../store.ts';

const FATES: readonly { value: BreakoutFate; label: string }[] = [
  { value: 'through', label: 'passes through' },
  { value: 'terminated', label: 'terminated here' },
  { value: 'nc', label: 'NC' },
];

function short(path: string): string {
  return path.replace(/^core-/, '').replace(/\.center$/, '').replace(/\.shield$/, ' braid');
}

/** One design edit, as one undo step; a refused edit says why instead. */
function useApply(): { apply: (description: string, edit: () => CableDesign) => void; error: string | undefined } {
  const { dispatch } = useEditorApi();
  const [error, setError] = useState<string | undefined>(undefined);
  return {
    error,
    apply: (description, edit) => {
      try {
        const design = edit();
        setError(undefined);
        dispatch({ type: 'apply-design', design, description, record: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** A segment's place in the breakouts: split it here, or where its end already sits. */
export function SegmentBreakoutSection({ state, segment }: { state: EditorState; segment: string }): JSX.Element {
  const { dispatch } = useEditorApi();
  const { design, db } = state;
  const { apply, error } = useApply();
  const [atMm, setAtMm] = useState('');
  const seg = design.instances.segments.find((s) => s.id === segment);
  const ends = (['a', 'b'] as const).map((end) => ({ end, at: breakoutAt(design, segment, end) }));
  const free = breakoutAt(design, segment, 'b') === undefined;
  return (
    <section className="cs-breakout-section" aria-label="breakout">
      <h3>breakout</h3>
      {ends
        .filter((e) => e.at !== undefined)
        .map((e) => (
          <p key={e.end} className="cs-meta">
            end {e.end} is the {e.at!.role} of{' '}
            <button type="button" className="cs-link" onClick={() => dispatch({ type: 'select', selection: { kind: 'instance', id: e.at!.breakout.id } })}>
              {e.at!.breakout.id}
            </button>
          </p>
        ))}
      {free ? (
        <div className="cs-breakout-split">
          <input
            className="cs-input"
            type="number"
            min={1}
            placeholder={seg?.lengthMm === undefined ? 'at mm from a' : `at mm from a (of ${seg.lengthMm})`}
            value={atMm}
            onChange={(event) => setAtMm(event.target.value)}
            aria-label="split point, mm from end a"
          />
          <button
            type="button"
            className="cs-btn"
            onClick={() =>
              apply(`split ${segment} into a breakout`, () =>
                splitSegmentAtBreakout(design, db, segment, atMm === '' ? {} : { atMm: Number(atMm) }),
              )
            }
          >
            add breakout
          </button>
        </div>
      ) : null}
      {error === undefined ? null : <p className="cs-error">{error}</p>}
    </section>
  );
}

interface FateRow {
  segment: string;
  path: string;
  fate: BreakoutFate;
  leg?: string;
  reason?: string;
  /** a through row seen from its leg: edited on the trunk's row */
  mirrored: boolean;
}

function rowsOf(design: CableDesign, db: Db, breakout: BreakoutInstance): FateRow[] {
  const fates = breakoutFates(design, db);
  const out: FateRow[] = [];
  for (const e of [breakout.trunk, ...breakout.legs]) {
    const seg = design.instances.segments.find((s) => s.id === e.segment);
    const wire = seg === undefined ? undefined : findWire(db, seg.def);
    if (seg === undefined || wire === undefined) continue;
    const folded = bondFoldedPaths(wire);
    for (const path of segmentElectricalPaths(wire, seg)) {
      if (folded.has(path)) continue;
      const fate = fates.get(terminalKey({ instance: seg.id, terminal: path, end: e.end }));
      const mirrored = fate?.fate === 'through' && e !== breakout.trunk;
      if (mirrored) continue;
      out.push({
        segment: seg.id,
        path,
        fate: fate?.fate ?? 'nc',
        ...(fate?.peer === undefined ? {} : { leg: fate.peer.instance }),
        ...(fate?.reason === undefined ? {} : { reason: fate.reason }),
        mirrored,
      });
    }
  }
  return out;
}

/** The breakout itself: every conductor's fate, its legs, its mould. */
export function BreakoutPanel({ state, id }: { state: EditorState; id: string }): JSX.Element {
  const { design, db } = state;
  const { apply, error } = useApply();
  const [legDef, setLegDef] = useState('');
  const [legMm, setLegMm] = useState('');
  const breakout = breakoutsOf(design).find((b) => b.id === id);
  if (breakout === undefined) return <p className="cs-empty">breakout {id} is gone</p>;
  const rows = rowsOf(design, db, breakout);
  const trunk = design.instances.segments.find((s) => s.id === breakout.trunk.segment);
  // a bonded screen's folded members (the mini-coax foil behind its drain) follow it:
  // the foil is never shown on its own (owner 2026-09-25)
  const followers = (row: FateRow): string[] => {
    const seg = design.instances.segments.find((s) => s.id === row.segment);
    const wire = seg === undefined ? undefined : findWire(db, seg.def);
    if (wire === undefined) return [];
    const folded = bondFoldedPaths(wire);
    return (wire.bonded ?? []).find((set) => set.members.includes(row.path))?.members.filter((m) => folded.has(m)) ?? [];
  };
  const setFate = (row: FateRow, fate: BreakoutFate, reason?: string): void =>
    apply(`${id}: ${row.segment} ${short(row.path)} ${fate === 'nc' ? 'NC' : fate}`, () => {
      const options = reason === undefined ? {} : { reason };
      let next = setBreakoutFate(design, db, id, row.segment, row.path, fate, options);
      const wire = findWire(db, design.instances.segments.find((s) => s.id === row.segment)?.def ?? '');
      for (const path of followers(row)) {
        // soldering the drain never lands the foil: it is trimmed back
        const foil = wire !== undefined && isTrimmedFoil(wire, path) && fate === 'terminated';
        next = foil
          ? setBreakoutFate(next, db, id, row.segment, path, 'nc', { reason: 'foil trimmed back, never landed (owner 2026-09-25)' })
          : setBreakoutFate(next, db, id, row.segment, path, fate, options);
      }
      return next;
    });
  const mould = breakout.mould === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === breakout.mould);
  return (
    <section className="cs-breakout-panel" aria-label={`breakout ${id}`}>
      <dl className="cs-facts">
        <dt>breakout</dt>
        <dd className="cs-mono">{id}</dd>
        <dt>mould</dt>
        <dd className="cs-mono">{mould === undefined ? '—' : `${mould.id} · ${mould.def}`}</dd>
        <dt>trunk</dt>
        <dd className="cs-mono">
          {breakout.trunk.segment} @{breakout.trunk.end}
        </dd>
        <dt>legs</dt>
        <dd className="cs-mono">
          {breakout.legs.map((l) => {
            const seg = design.instances.segments.find((s) => s.id === l.segment);
            return `${l.segment} (${seg?.lengthMm === undefined ? 'length TBD' : `${seg.lengthMm} mm`})`;
          }).join(', ')}
        </dd>
      </dl>
      <ul className="cs-breakout-rows">
        {rows.map((row) => (
          <li key={`${row.segment}:${row.path}`} className={`is-${row.fate}`} data-row={`${row.segment}:${row.path}`}>
            <span className="cs-mono cs-breakout-name" title={`${row.segment}:${row.path}`}>
              {row.segment === breakout.trunk.segment ? '' : `${row.segment} `}
              {short(row.path)}
              {row.fate === 'through' ? <span className="cs-breakout-to"> → {row.leg}</span> : null}
            </span>
            <select
              className="cs-select"
              value={row.fate}
              aria-label={`${row.segment} ${row.path} at the mould`}
              onChange={(event) => setFate(row, event.target.value as BreakoutFate, event.target.value === 'nc' ? 'not used' : undefined)}
            >
              {FATES.map((f) => (
                <option key={f.value} value={f.value} disabled={f.value === 'through' && row.segment !== breakout.trunk.segment}>
                  {f.label}
                </option>
              ))}
            </select>
            {row.fate === 'nc' ? (
              <input
                className="cs-input cs-breakout-why"
                defaultValue={row.reason ?? ''}
                placeholder="why NC"
                aria-label={`why ${row.segment} ${row.path} is NC`}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value !== '' && value !== row.reason) setFate(row, 'nc', value);
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <select className="cs-select" value={legDef} onChange={(event) => setLegDef(event.target.value)} aria-label="leg stock">
        <option value="">new leg of {trunk?.def ?? 'the trunk’s stock'}</option>
        {db.wires.map((w) => (
          <option key={w.id} value={w.id}>
            new leg of {wireDisplayName(db, w.id)}
          </option>
        ))}
      </select>
      <div className="cs-breakout-leg">
        <input className="cs-input" type="number" min={1} placeholder="length mm" value={legMm} onChange={(event) => setLegMm(event.target.value)} aria-label="leg length mm" />
        <button
          type="button"
          className="cs-btn"
          onClick={() =>
            apply(`${id}: attach a leg`, () =>
              attachBreakoutLeg(design, db, id, { ...(legDef === '' ? {} : { def: legDef }), ...(legMm === '' ? {} : { lengthMm: Number(legMm) }) }),
            )
          }
        >
          attach leg
        </button>
      </div>
      <button type="button" className="cs-danger" onClick={() => apply(`remove ${id}`, () => removeBreakout(design, db, id))}>
        remove breakout (a plain split only)
      </button>
      {error === undefined ? null : <p className="cs-error">{error}</p>}
    </section>
  );
}
