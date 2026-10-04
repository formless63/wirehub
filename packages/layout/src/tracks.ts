/**
 * Turning a wire definition into the ordered list of tracks that make up a
 * band.
 *
 * Reading order top → bottom mirrors the real cable cross-section: the overall
 * shield wraps everything, so it takes the top edge; the bare drain runs at the
 * bottom edge; the signal groups sit between them in structure order, each
 * contributing its centre conductor followed by its own shield.
 *
 * A bonded screen (`WireDefinition.bonded`) other than
 * its set's representative gets no track of its own — see `bond-fold.ts`. A
 * coax core's own centre conductor always keeps its track; only a bonded
 * shield/drain folds away.
 */

import { isElectricalElement, isGroup } from '@cable-studio/model';
import type {
  ElectricalElement,
  Element,
  GroupElement,
  WireDefinition,
} from '@cable-studio/model';

import { bondedMassLabel, bondedRepresentative, bondFoldedPaths } from './bond-fold.ts';
import type { TrackRole } from './model.ts';

export interface TrackSpec {
  elementPath: string;
  element: ElectricalElement;
  kind: 'conductor' | 'shield';
  role: TrackRole;
  label: string;
  colorName?: string;
  bare: boolean;
  groupId?: string;
}

export interface GroupSpec {
  id: string;
  label: string;
  role: string;
  /** indices into the track list, inclusive */
  first: number;
  last: number;
}

function labelFor(path: string, element: Element): string {
  return element.label === undefined ? path : `${path} · ${element.label}`;
}

function collectElectrical(
  group: GroupElement,
  prefix: string,
  out: { path: string; element: ElectricalElement }[],
): void {
  for (const child of group.children) {
    const path = prefix === '' ? child.id : `${prefix}.${child.id}`;
    if (isGroup(child)) collectElectrical(child, path, out);
    else if (isElectricalElement(child)) out.push({ path, element: child });
  }
}

function spec(
  path: string,
  element: ElectricalElement,
  role: TrackRole,
  groupId?: string,
): TrackSpec {
  const bare = element.kind === 'conductor' && element.bare === true;
  return {
    elementPath: path,
    element,
    kind: element.kind,
    role,
    label: labelFor(path, element),
    ...(element.kind === 'conductor' && element.color !== undefined
      ? { colorName: element.color }
      : {}),
    bare,
    ...(groupId === undefined ? {} : { groupId }),
  };
}

/**
 * Track order for one wire stock, plus the bracket groups that bind each
 * coax / shielded core together.
 */
export function bandTrackSpecs(
  wire: WireDefinition,
  /** a breakout run's scope (`SegmentInstance.scope`): only these elements are drawn */
  scope?: readonly string[],
): {
  tracks: TrackSpec[];
  groups: GroupSpec[];
} {
  const carried = (path: string): boolean => scope === undefined || scope.some((s) => path === s || path.startsWith(`${s}.`));
  const overall: TrackSpec[] = [];
  const grouped: TrackSpec[] = [];
  const plain: TrackSpec[] = [];
  const drains: TrackSpec[] = [];
  const groupRanges: { id: string; label: string; role: string; paths: string[] }[] = [];

  for (const child of wire.structure.children) {
    if (isGroup(child)) {
      const members: { path: string; element: ElectricalElement }[] = [];
      collectElectrical(child, child.id, members);
      if (members.length === 0) continue;
      for (const member of members) {
        grouped.push(
          spec(
            member.path,
            member.element,
            member.element.kind === 'shield' ? 'shield' : 'center',
            child.id,
          ),
        );
      }
      groupRanges.push({
        id: child.id,
        label: child.label === undefined ? child.id : `${child.id} · ${child.label}`,
        role: child.role,
        paths: members.map((member) => member.path),
      });
      continue;
    }
    if (!isElectricalElement(child)) continue;
    if (child.kind === 'shield') {
      overall.push(spec(child.id, child, 'overall-shield'));
    } else if (child.bare === true) {
      drains.push(spec(child.id, child, 'drain'));
    } else {
      plain.push(spec(child.id, child, 'plain'));
    }
  }

  //: fold every bonded screen but its set's
  // representative out of the band entirely — "the drain stands for the
  // bonded mass". A coax core's centre conductor is never a bonded member
  // (SPEC: a bonded set holds only screens), so a group never loses its whole
  // track range, only its own shield track when that shield is folded.
  const dropped = bondFoldedPaths(wire);
  //: a fully bonded stock's mass (bonded multi-core) is one
  // indication labelled as all of its shielding; its representative leaves
  // any core's bracket and takes the band's top edge (or stays the bottom
  // edge's drain), so it never reads as one core's own screen
  const massRep = new Map<string, string>();
  for (const set of wire.bonded ?? []) {
    const label = bondedMassLabel(wire, set);
    if (label !== undefined) massRep.set(bondedRepresentative(wire, set), label);
  }
  const relabel = (track: TrackSpec): TrackSpec => {
    const label = massRep.get(track.elementPath);
    if (label === undefined) return track;
    const { groupId: _group, ...rest } = track;
    return { ...rest, label, role: track.bare ? 'drain' : 'shield' };
  };
  const lifted = grouped.filter((track) => massRep.has(track.elementPath)).map(relabel);
  const tracks = [
    ...overall.map(relabel),
    ...lifted,
    ...grouped.filter((track) => !massRep.has(track.elementPath)),
    ...plain,
    ...drains.map(relabel),
  ].filter((track) => !dropped.has(track.elementPath) && carried(track.elementPath));

  const indexOf = new Map(tracks.map((track, index) => [track.elementPath, index]));
  const groups: GroupSpec[] = [];
  for (const range of groupRanges) {
    const indices = range.paths
      .filter((path) => !massRep.has(path))
      .map((path) => indexOf.get(path))
      .filter((index): index is number => index !== undefined);
    if (indices.length === 0) continue;
    groups.push({
      id: range.id,
      label: range.label,
      role: range.role,
      first: Math.min(...indices),
      last: Math.max(...indices),
    });
  }

  return { tracks, groups };
}
