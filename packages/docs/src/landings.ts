/**
 * Ground landings — one row per pigtail per end (specs/shield-bonding.md
 * §2.4/§2.5): which screens are twisted together, and the pad they land on.
 *
 * The bench never checks a braid on its own (a finished cable has no probe
 * point on one); what it checks before the shell goes on is the twist: present,
 * on that pad, nothing else on it. The build sheet's Terminations table and the
 * test spec's Ground-landings section both print these rows.
 */

import {
  findInstance,
  findPcba,
  findWire,
  isFoilPath,
  isFullyBonded,
  pigtailKey,
  pigtailMembers,
  terminalKey,
  type CableDesign,
  type Db,
  type TerminalRef,
  type WireDefinition,
} from '@wirehub/model';

export interface GroundLanding {
  /** `w1:pigtail:rgb@b` */
  key: string;
  segment: string;
  end: 'a' | 'b';
  pigtail: string;
  /** true for a pigtail on a fully bonded stock: the whole shield mass */
  mass: boolean;
  /** screen paths twisted into it */
  members: string[];
  /** "red, green, blue shields" / "shields (all 7 copper screens + drain, bonded)" */
  membersText: string;
  /** where it lands: "u2 GND", "j4 13"; empty when it has no landing */
  landing: string;
  pad?: string;
  padSide?: string;
  /** "w1 @b · pigtail rgb · red, green, blue shields → u2 GND (pad GND2, bottom)" */
  text: string;
  /** the pigtail's prep note */
  note?: string;
}

/** Plain words for a list of screens: `red, green, blue shields + overall-shield + drain`. */
export function screensText(members: readonly string[]): string {
  const cores: string[] = [];
  const others: string[] = [];
  for (const path of members) {
    const match = /^(?:core-)?([^.]+)\.shield$/.exec(path);
    if (match?.[1] !== undefined) cores.push(match[1]);
    else others.push(path);
  }
  const parts: string[] = [];
  if (cores.length > 0) parts.push(`${cores.join(', ')} shield${cores.length === 1 ? '' : 's'}`);
  parts.push(...others);
  return parts.join(' + ');
}

/**
 * A fully bonded stock's mass in words — all of its copper as one, never the
 * foil (owner, 2026-09-25: "we instead treat all of the
 * shielding material the same on bonded multi-core and would indicate it together,
 * but the primary focus is on all of the copper"): `shields (all 7 copper
 * screens + drain, bonded)`.
 */
function massText(wire: WireDefinition, members: readonly string[]): string {
  const copper = members.filter((path) => !isFoilPath(wire, path) && path !== 'drain' && !/\.drain$/.test(path));
  const drain = members.some((path) => path === 'drain' || /\.drain$/.test(path));
  return `shields (all ${copper.length} copper screens${drain ? ' + drain' : ''}, bonded)`;
}

function landingOf(design: CableDesign, key: string): TerminalRef | undefined {
  for (const joint of design.joints) {
    if (terminalKey(joint.a) === key) return joint.b;
    if (terminalKey(joint.b) === key) return joint.a;
  }
  return undefined;
}

export function deriveGroundLandings(design: CableDesign, db: Db): GroundLanding[] {
  const out: GroundLanding[] = [];
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    const mass = isFullyBonded(wire);
    const pigtails = [...(segment.pigtails ?? [])].sort((x, y) =>
      x.end === y.end ? 0 : x.end === 'a' ? -1 : 1,
    );
    for (const pigtail of pigtails) {
      const key = pigtailKey(segment.id, pigtail);
      const members = pigtailMembers(wire, pigtail);
      const massPigtail = mass && pigtail.members === undefined;
      const membersText = massPigtail ? massText(wire, members) : screensText(members);
      const land = landingOf(design, key);
      let landing = '';
      let padSide: string | undefined;
      if (land !== undefined) {
        const instance = findInstance(design, land.instance);
        landing = `${land.instance} ${land.terminal}${land.end === undefined ? '' : ` @${land.end}`}`;
        if (land.pad !== undefined && instance?.kind === 'pcba') {
          padSide = findPcba(db, instance.def)
            ?.terminals.find((t) => t.id === land.terminal)
            ?.pads?.find((p) => p.ref === land.pad)?.side;
        }
      }
      const pad = land?.pad;
      const padText =
        pad === undefined ? '' : ` (pad ${pad}${padSide === undefined ? '' : `, ${padSide}`})`;
      out.push({
        key,
        segment: segment.id,
        end: pigtail.end,
        pigtail: pigtail.id,
        mass: massPigtail,
        members,
        membersText,
        landing,
        ...(pad === undefined ? {} : { pad }),
        ...(padSide === undefined ? {} : { padSide }),
        text: `${segment.id} @${pigtail.end} · pigtail ${pigtail.id} · ${membersText} → ${landing === '' ? 'NOT LANDED' : `${landing}${padText}`}`,
        ...(pigtail.note === undefined ? {} : { note: pigtail.note }),
      });
    }
  }
  return out;
}
