/**
 * A synthetic cable that crowds the router's keep-outs.
 *
 * Two discrete parts stacked in the source hood column, at the pitch the
 * column packs them to, with a fan of runs that cross the corridor the
 * column stands in. It reaches both limits the bead names:
 *
 * 1. several runs whose lanes land inside the same part's keep-out, with
 *    overlapping spans — projected onto one face, their verticals would draw
 *    on top of one another;
 * 2. a horizontal run level with the lower part, whose hop round it has to
 *    thread the channel between the two parts, under the lower one and past
 *    the designator printed over it.
 *
 * Nothing here is catalog data, so no catalog edit can take the crowding
 * away.
 */

import type {
  CableDesign,
  ComponentDefinition,
  ConnectorDefinition,
  Db,
  Joint,
  WireDefinition,
} from '@cable-studio/model';

const SRC: ConnectorDefinition = {
  id: 'x-src-10',
  label: '10-contact source',
  family: 'test',
  gender: 'male',
  pins: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1), label: `Line ${index + 1}` })),
  src: 'synthetic fixture for',
};

const DST: ConnectorDefinition = {
  id: 'x-dst-6',
  label: '6-contact sink',
  family: 'test',
  gender: 'female',
  pins: Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), label: `Line ${index + 1}` })),
  src: 'synthetic fixture for',
};

const COLOURS = ['brown', 'red', 'orange', 'yellow', 'green', 'blue'] as const;

const FLAT6: WireDefinition = {
  id: 'x-flat-6',
  label: '6-core flat',
  structure: {
    kind: 'group',
    id: 'x-flat-6',
    role: 'cable',
    children: COLOURS.map((color, index) => ({
      kind: 'conductor' as const,
      id: `t${index + 1}`,
      label: `Core ${index + 1}`,
      color,
    })),
  },
  src: 'synthetic fixture for',
};

const RES: ComponentDefinition = {
  id: 'x-res-4k7',
  label: '4.7 kΩ resistor',
  kind: 'resistor',
  value: '4.7 kΩ',
  terminals: [{ id: 'a' }, { id: 'b' }],
  src: 'synthetic fixture for',
};

export const DETOUR_DB: Db = {
  connectors: [SRC, DST],
  wires: [FLAT6],
  components: [RES],
  pcbas: [],
};

const joint = (a: Joint['a'], b: Joint['b']): Joint => ({ a, b });
const pin = (terminal: string): Joint['a'] => ({ instance: 'j1', terminal });
const track = (index: number, end: 'a' | 'b'): Joint['a'] => ({ instance: 'w1', terminal: `t${index}`, end });

export const DETOUR_DESIGN: CableDesign = {
  schemaVersion: 1,
  id: 'x-crowded-hood',
  label: 'two parts in the hood, a fan crossing them',
  instances: {
    connectors: [
      { id: 'j1', def: 'x-src-10', role: 'source plug' },
      { id: 'j2', def: 'x-dst-6', role: 'sink' },
    ],
    segments: [{ id: 'w1', def: 'x-flat-6', lengthMm: 600 }],
    components: [
      { id: 'r1', def: 'x-res-4k7', location: 'source hood' },
      { id: 'r2', def: 'x-res-4k7', location: 'source hood' },
    ],
    pcbas: [],
  },
  joints: [
    // the fan, turned upside down: every run crosses the corridor
    ...[1, 2, 3, 4, 5, 6].map((index) => joint(pin(String(index)), track(7 - index, 'a'))),
    ...[1, 2, 3, 4, 5, 6].map((index) => joint(track(index, 'b'), { instance: 'j2', terminal: String(index) })),
    // two parts, each bridging a low pin to a high track, so both park in
    // the middle of the fan
    joint(pin('7'), { instance: 'r1', terminal: 'a' }),
    joint({ instance: 'r1', terminal: 'b' }, track(1, 'a')),
    joint(pin('9'), { instance: 'r2', terminal: 'a' }),
    joint({ instance: 'r2', terminal: 'b' }, track(2, 'a')),
    // pull-ups straight across: runs level with the parts
    joint(pin('8'), track(3, 'a')),
    joint(pin('10'), track(4, 'a')),
  ],
  src: 'synthetic fixture for',
};
