/**
 * A `Connection` (see `connection.ts`) turned into the rows the Connection
 * tab draws: one per joint, PAD/SIDE/CONDUCTOR; a pigtail's landing joint
 * becomes a group row that expands to the screens twisted into it (shield
 * bonding, specs/shield-bonding.md §2.5).
 *
 * Pure — `resolveTerminal` and `elementOf` do the actual lookups against
 * `(design, db)`; this file only shapes the result into rows and decides
 * which rows are one ground bundle. No React, no DOM.
 */

import {
  findInstance,
  findPcba,
  findWire,
  isFullyBonded,
  pigtailMembers,
  resolveTerminal,
  type CableDesign,
  type Db,
  type TerminalRef,
} from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import type { PinAnchor } from '../artwork.ts';
import { orientJoint, type Connection } from '../connection.ts';
import { elementOf } from '../derive.ts';

export type BoardPadSide = 'top' | 'bottom' | 'both';

/** One joint of a connection, ready to draw as a table row. */
export interface ConnectionRow {
  jointIndex: number;
  pad: TerminalRef;
  /** the pad side's own terminal id, as its definition names it (`R`, `j.3`) */
  padId: string;
  padOk: boolean;
  padSide?: BoardPadSide;
  wire: TerminalRef;
  /** the far side's terminal id (`core-red.center`, `6`, a component terminal) */
  wireId: string;
  wireOk: boolean;
  /** a shield, a bare drain, or a pigtail of them */
  ground: boolean;
  /** the pigtail this joint lands, when the wire side is one */
  pigtail?: PigtailInfo;
  /** the landing's physical pad qualifier (`GND2`) */
  landingPad?: string;
  /** the pads the pad-side terminal declares, for the pad picker */
  pads?: { ref: string; side?: string }[];
  /** domain colour name, conductor rows only */
  colorName?: string;
  /** the dim column: a definition's own label for the row, or the joint's note */
  note?: string;
  jointNote?: string;
}

/** A pigtail of the design, as the Connection tab needs it. */
export interface PigtailInfo {
  segment: string;
  id: string;
  end: 'a' | 'b';
  /** a mass pigtail on a fully bonded stock: no member list */
  mass: boolean;
  /** the screens it twists (for a mass: every screen of the stock) */
  members: string[];
  note?: string;
}

/** A pigtail's landing, drawn as one line that expands to its screens. */
export interface GroundGroup {
  kind: 'group';
  padId: string;
  padSide?: BoardPadSide;
  pigtail: PigtailInfo;
  /** the landing joint's row (a pigtail lands once) */
  rows: ConnectionRow[];
}

export type ConnectionRowOrGroup = ConnectionRow | GroundGroup;

/** Which copper side(s) a PCBA terminal's anchor pads sit on, when the depiction says. */
function boardPadSide(
  depictions: DepictionSource | undefined,
  defId: string,
  terminal: string,
): BoardPadSide | undefined {
  const anchor: PinAnchor | undefined = depictions?.meta(defId)?.pinAnchors[terminal];
  if (anchor === undefined) return undefined;
  const pads = anchor.pads !== undefined && anchor.pads.length > 0
    ? anchor.pads
    : anchor.side === undefined
      ? []
      : [{ side: anchor.side }];
  const sides = new Set(pads.map((pad) => pad.side).filter((side): side is BoardPadSide => side !== undefined));
  if (sides.has('both') || sides.size > 1) return 'both';
  const [only] = sides;
  return only ?? anchor.side;
}

/** Every joint of `connection` as a display row, in `connection.joints` order. */
export function connectionRows(
  design: CableDesign,
  db: Db,
  connection: Connection,
  depictions?: DepictionSource,
): ConnectionRow[] {
  return connection.joints.flatMap((jointIndex) => {
    const joint = design.joints[jointIndex];
    if (joint === undefined) return [];
    const { a: pad, b: wire } = orientJoint(connection, joint);
    const padResolved = resolveTerminal(design, db, pad);
    const wireResolved = resolveTerminal(design, db, wire);
    const element = elementOf(design, db, wire) ?? elementOf(design, db, pad);
    const padDef = padResolved.ok ? padResolved.terminal.def : undefined;
    const declared =
      padResolved.ok && padResolved.terminal.instanceKind === 'pcba' && padDef !== undefined
        ? findPcba(db, padDef)?.terminals.find((t) => t.id === pad.terminal)?.pads
        : undefined;
    // a landing that names its pad is on that pad's face
    const namedSide = pad.pad === undefined ? undefined : declared?.find((p) => p.ref === pad.pad)?.side;
    const padSide =
      namedSide ??
      (padResolved.ok && padResolved.terminal.instanceKind === 'pcba' && padDef !== undefined
        ? boardPadSide(depictions, padDef, pad.terminal)
        : undefined);
    const pigtail = wireResolved.ok ? wireResolved.terminal.pigtail : undefined;
    const segment = pigtail === undefined ? undefined : findInstance(design, wire.instance);
    const stock = segment === undefined ? undefined : findWire(db, segment.def);
    const info: PigtailInfo | undefined =
      pigtail === undefined || stock === undefined
        ? undefined
        : {
            segment: wire.instance,
            id: pigtail.id,
            end: pigtail.end,
            mass: pigtail.members === undefined && isFullyBonded(stock),
            members: pigtailMembers(stock, pigtail),
            ...(pigtail.note === undefined ? {} : { note: pigtail.note }),
          };
    const label =
      (padResolved.ok ? padResolved.terminal.label : undefined) ??
      (wireResolved.ok ? wireResolved.terminal.label : undefined);
    return [
      {
        jointIndex,
        pad,
        padId: pad.terminal,
        padOk: padResolved.ok,
        ...(padSide === undefined ? {} : { padSide }),
        wire,
        wireId: wire.terminal,
        wireOk: wireResolved.ok,
        ground: info !== undefined || element?.role === 'shield' || element?.role === 'drain',
        ...(info === undefined ? {} : { pigtail: info }),
        ...(pad.pad === undefined ? {} : { landingPad: pad.pad }),
        ...(declared === undefined || declared.length < 2
          ? {}
          : { pads: declared.map((p) => ({ ref: p.ref, ...(p.side === undefined ? {} : { side: p.side }) })) }),
        ...(element?.colorName === undefined ? {} : { colorName: element.colorName }),
        ...(label === undefined ? {} : { note: label }),
        ...(joint.note === undefined ? {} : { jointNote: joint.note }),
      } satisfies ConnectionRow,
    ];
  });
}

/**
 * Each pigtail landing becomes a `GroundGroup` — `rgb → GND · GND2`, expandable
 * to the screens twisted into it — in place. A screen jointed on its own stays
 * a plain row: the grouping is the design's pigtails, never a guess from
 * rows that happen to share a pad.
 */
export function groupGroundRows(rows: readonly ConnectionRow[]): ConnectionRowOrGroup[] {
  return rows.map((row) =>
    row.pigtail === undefined
      ? row
      : {
          kind: 'group',
          padId: row.padId,
          ...(row.padSide === undefined ? {} : { padSide: row.padSide }),
          pigtail: row.pigtail,
          rows: [row],
        },
  );
}

/** The screens of a connection's wire end that are jointed on their own — candidates for a new pigtail. */
export function looseScreens(rows: readonly ConnectionRow[]): ConnectionRow[] {
  return rows.filter((row) => row.ground && row.pigtail === undefined && row.wire.end !== undefined);
}
