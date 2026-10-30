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
  massWords,
  pigtailKey,
  pigtailLandedScreens,
  stockScreens,
  terminalKey,
  terminalName,
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
  /** "red, green, blue shields" / "shield mass (7 copper screens + drain)" / "drain" */
  membersText: string;
  /** where it lands: "U2 · GND", "J4 pin 13 · GND"; empty when it has no landing */
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
 * foil (all the shielding of a bonded multi-core is treated alike and
 * indicated together; the copper is what matters): `shields (all 7 copper
 * screens + drain, bonded)`.
 */
export function massText(wire: WireDefinition, members: readonly string[]): string {
  return massWords(wire, members);
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
    const mass = stockScreens(wire).mass;
    const pigtails = [...(segment.pigtails ?? [])].sort((x, y) =>
      x.end === y.end ? 0 : x.end === 'a' ? -1 : 1,
    );
    for (const pigtail of pigtails) {
      const key = pigtailKey(segment.id, pigtail);
      // the foil is trimmed and a drain the policy cuts here stays off the pad: nothing to check when nothing lands
      const members = pigtailLandedScreens(design, wire, segment.id, pigtail);
      if (members.length === 0) continue;
      const massPigtail = mass && pigtail.members === undefined;
      const membersText = massPigtail ? massText(wire, members) : screensText(members);
      const land = landingOf(design, key);
      let landing = '';
      let padSide: string | undefined;
      if (land !== undefined) {
        const instance = findInstance(design, land.instance);
        landing = terminalName(design, db, land);
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
