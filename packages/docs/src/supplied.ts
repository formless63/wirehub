/**
 * Ends the contract manufacturer delivers terminated (pre-made "stripped to X"
 * cable stock): a design
 * carries the sub-assembly as a mechanical instance whose definition says
 * which end it `supplies` and whether the trunk comes with it. Everything on
 * that end — plugs, jacks, boards, moulds, breakout runs, their shells — and
 * the trunk (when it comes with it) is inside the sub-assembly: the BOM buys
 * the one sub-assembly instead, and the bench builds only the other end.
 */

import { findMechanical, type CableDesign, type Db, type MechanicalDefinition } from '@wirehub/model';

import { trunkSides } from './bench/model.ts';
import { trunkSegment } from './drawing/model.ts';

export interface SuppliedEnd {
  side: 'a' | 'b';
  /** the sub-assembly's mechanical instance */
  instance: string;
  def: MechanicalDefinition;
  /** every instance id the sub-assembly delivers (the trunk too, when it comes with it) */
  covers: Set<string>;
}

export function suppliedEnds(design: CableDesign, db: Db): SuppliedEnd[] {
  const out: SuppliedEnd[] = [];
  for (const m of design.instances.mechanical ?? []) {
    const def = findMechanical(db, m.def);
    if (def?.supplies === undefined) continue;
    const side = def.supplies.end === 'source' ? 'a' : 'b';
    const trunk = trunkSegment(design, db)?.id;
    const covers = new Set<string>();
    for (const [id, s] of trunkSides(design, db)) if (s === side) covers.add(id);
    // a breakout mould on this end of the trunk: its runs and what they carry
    for (const bk of design.instances.breakouts ?? []) {
      if (bk.trunk.segment !== trunk || bk.trunk.end !== side) continue;
      if (bk.mould !== undefined) covers.add(bk.mould);
      for (const h of bk.housed ?? []) covers.add(h);
      for (const leg of bk.legs) covers.add(leg.segment);
    }
    // whatever is soldered to a covered segment, and the parts a covered instance carries
    let grew = true;
    while (grew) {
      grew = false;
      for (const j of design.joints) {
        for (const [x, y] of [
          [j.a, j.b],
          [j.b, j.a],
        ] as const) {
          if (x.instance === trunk || !covers.has(x.instance) || covers.has(y.instance) || y.instance === trunk) continue;
          covers.add(y.instance);
          grew = true;
        }
      }
      for (const mech of design.instances.mechanical ?? []) {
        if (mech.attachedTo !== undefined && covers.has(mech.attachedTo) && !covers.has(mech.id)) {
          covers.add(mech.id);
          grew = true;
        }
      }
    }
    if (def.supplies.trunk && trunk !== undefined) covers.add(trunk);
    covers.delete(m.id);
    out.push({ side, instance: m.id, def, covers });
  }
  return out;
}
