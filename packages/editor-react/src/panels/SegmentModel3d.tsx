/**
 * A design segment in 3D, in the Inspector: its own
 * stock at its own length, stripped as this build strips it — the bench
 * sheet's strip plan (what `stripFigure` draws: which cores land, which are
 * cut back, whether the drain is used at this end) laid over the bench's
 * strip practice for the stock. Folded shut until asked for, so a design
 * with no one looking costs nothing.
 */

import { findWire, type CableDesign, type Db, type StripPractice } from '@cable-studio/model';
import { deriveBench } from '@cable-studio/docs';
import type { StripPreset } from '@cable-studio/render-svg';
import { useMemo, useState, type JSX } from 'react';

import { DEFAULT_LENGTH_MM, presetsFor, stripFromPlan } from '../wire-view.ts';
import { LazyWireModel3d } from './wire-model-lazy.tsx';

export interface SegmentModel3dProps {
  design: CableDesign;
  db: Db;
  segment: string;
  practice: readonly StripPractice[];
}

/** The build's own strip, as a preset: the plan over the stock's practice (or a bare cut). */
export function buildPreset(design: CableDesign, db: Db, segment: string, presets: readonly StripPreset[]): StripPreset | undefined {
  const base = presets[1] ?? presets[0];
  if (base === undefined) return undefined;
  let bench;
  try {
    bench = deriveBench(design, db);
  } catch {
    return undefined;
  }
  const endOf = (side: 'a' | 'b') => bench.ends.flatMap((e) => e.segmentEnds).find((se) => se.segment === segment && se.end === side);
  const a = endOf('a');
  const b = endOf('b');
  if (a === undefined && b === undefined) return undefined;
  // the board face each of this segment's pigtails is soldered on, per end
  const facesAt = (side: 'a' | 'b'): Map<string, 'top' | 'bottom'> => {
    const faces = new Map<string, 'top' | 'bottom'>();
    for (const end of bench.ends) {
      for (const t of end.terminations) {
        for (const l of t.landings) {
          if (l.segment !== segment || l.segEnd !== side || l.element.kind !== 'pigtail' || l.face === undefined) continue;
          faces.set(l.element.id, l.face);
        }
      }
    }
    return faces;
  };
  return {
    id: 'build',
    label: 'This build',
    src: `The bench sheet's strip plan for ${segment} (packages/docs/src/bench/model.ts stripPlan — the rows stripFigure draws) over "${base.label}": ${base.src}`,
    inferred: base.inferred,
    strip: {
      a: a === undefined ? base.strip.a : stripFromPlan(base.strip.a, a.rows, facesAt('a')),
      b: b === undefined ? base.strip.b : stripFromPlan(base.strip.b, b.rows, facesAt('b')),
    },
  };
}

export function SegmentModel3d(props: SegmentModel3dProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const instance = props.design.instances.segments.find((s) => s.id === props.segment);
  const wire = instance === undefined ? undefined : findWire(props.db, instance.def);
  const presets = useMemo(() => {
    if (!open || wire === undefined) return [];
    const base = presetsFor(wire, props.practice);
    const build = buildPreset(props.design, props.db, props.segment, base);
    return build === undefined ? base : [base[0] as StripPreset, build, ...base.slice(1)];
  }, [open, wire, props.practice, props.design, props.db, props.segment]);
  if (wire === undefined || instance === undefined) return null;
  return (
    <details className="cs-seg3d" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary title="This segment's stock at its length, stripped as the bench sheet strips it">3D</summary>
      {open ? (
        <LazyWireModel3d
          key={`${props.segment}|${instance.lengthMm ?? ''}`}
          wire={wire}
          presets={presets}
          initial={{ lengthMm: instance.lengthMm ?? DEFAULT_LENGTH_MM, ...(presets.some((p) => p.id === 'build') ? { preset: 'build', strip: (presets.find((p) => p.id === 'build') as StripPreset).strip } : {}) }}
          lengthLocked={instance.lengthMm !== undefined}
          height={240}
          compact
        />
      ) : null}
    </details>
  );
}
