/**
 * A design -> WireViz YAML (cs-5k1.18), for the subset WireViz can express:
 * connectors with pins, cables with conductors, colours, gauge, length and a
 * shield, wire-to-pin connections, and a connector's own pin loops. Written from
 * WireViz's public syntax documentation.
 *
 * Whatever does not fit is listed as `# Not carried over:` comment lines at the
 * top of the file (components, boards, breakouts, pigtails, joints that join a
 * conductor to a conductor, a second shield), so a person sees the loss rather
 * than a quietly smaller harness.
 */

import { electricalPaths, findConnector, findWire, pigtailIdOf, resolveElementPath, type CableDesign, type Db, type TerminalRef } from '@wirehub/model';
import type { ExportOutput } from '@wirehub/modules';
import { Document, visit } from 'yaml';

import { colourToCode } from './colours.ts';

type Obj = Record<string, unknown>;

const KEY = (id: string): string => id.toUpperCase();

/** `[1,2,3]` as `1-3`-free plain lists keep the file readable and exact. */
function pinSpec(values: (string | number)[]): (string | number)[] {
  return values;
}

/**
 * The document as YAML. `flow` writes each connector, cable and connection set on one line, the compact
 * style WireViz's own examples use (`X1: {type: Header, pincount: 2}`); the three sections stay block.
 */
function yaml(doc: Obj, flow: boolean): string {
  const document = new Document(doc);
  if (flow) {
    visit(document, {
      Map: (_key, node, path) => {
        if (path.length >= 4) node.flow = true;
      },
      Seq: (_key, node, path) => {
        if (path.length >= 4) node.flow = true;
      },
    });
  }
  return document.toString({ lineWidth: 0 });
}

export function exportWireViz(design: CableDesign, db: Db, options: Readonly<Record<string, unknown>> = {}): ExportOutput {
  const lost: string[] = [];
  const connectors: Obj = {};
  const cables: Obj = {};
  const idKey = new Map<string, string>();
  const usedKeys = new Set<string>();
  const keyFor = (id: string): string => {
    let k = KEY(id);
    for (let n = 2; usedKeys.has(k) && idKey.get(id) !== k; n += 1) k = `${KEY(id)}_${n}`;
    usedKeys.add(k);
    idKey.set(id, k);
    return k;
  };

  for (const instance of design.instances.connectors) {
    const def = findConnector(db, instance.def);
    const key = keyFor(instance.id);
    if (def === undefined) {
      lost.push(`connector ${instance.id}: definition '${instance.def}' is not in the library, so it has no pins here`);
      continue;
    }
    const numeric = def.pins.every((p, i) => p.id === String(i + 1));
    const labels = def.pins.map((p) => (p.label === p.id ? null : p.label));
    const entry: Obj = {
      type: def.family,
      ...(def.gender === 'male' || def.gender === 'female' ? { subtype: def.gender } : {}),
      ...(def.partNumber === undefined ? {} : { pn: def.partNumber }),
      ...(numeric ? { pincount: def.pins.length } : { pins: def.pins.map((p) => p.id) }),
      ...(labels.some((l) => l !== null) ? { pinlabels: labels.map((l) => l ?? '') } : {}),
      ...(instance.note === undefined ? {} : { notes: instance.note }),
    };
    if (def.gender !== undefined && def.gender !== 'male' && def.gender !== 'female') lost.push(`connector ${instance.id}: gender '${def.gender}' (WireViz subtype is free text, written as the type's label only)`);
    entry['type'] = def.label;
    connectors[key] = entry;
  }
  if (design.instances.components.length > 0) lost.push(`${design.instances.components.length} component(s): ${design.instances.components.map((c) => c.id).join(', ')}`);
  if (design.instances.pcbas.length > 0) lost.push(`${design.instances.pcbas.length} PCBA(s): ${design.instances.pcbas.map((c) => c.id).join(', ')} (a board is a black box with internal continuity)`);
  if ((design.instances.mechanical ?? []).length > 0) lost.push(`${design.instances.mechanical!.length} shell/hardware instance(s)`);
  if ((design.instances.breakouts ?? []).length > 0) lost.push('breakouts (moulds and legs)');

  /* conductor order per segment: non-bare conductors are wires 1..n; the first shield (else bare conductor) is 's' */
  interface Cab {
    key: string;
    wires: string[];
    shield?: string;
    /** the pigtail ids, by end, that twist the shield together and land it once: a WireViz `s` wire */
    shieldPigtails: Map<string, true>;
  }
  const cabs = new Map<string, Cab>();
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    const key = keyFor(segment.id);
    if (wire === undefined) {
      lost.push(`segment ${segment.id}: stock '${segment.def}' is not in the library`);
      continue;
    }
    const paths = electricalPaths(wire.structure);
    const conductors = paths.filter((p) => {
      const e = resolveElementPath(wire.structure, p);
      return e?.kind === 'conductor' && e.bare !== true;
    });
    const shields = paths.filter((p) => resolveElementPath(wire.structure, p)?.kind === 'shield');
    const bare = paths.filter((p) => {
      const e = resolveElementPath(wire.structure, p);
      return e?.kind === 'conductor' && e.bare === true;
    });
    const shield = shields[0] ?? bare[0];
    for (const extra of [...shields.slice(1), ...(shields.length > 0 ? bare : bare.slice(1))]) lost.push(`segment ${segment.id}: ${extra} (WireViz has one shield per cable; a drain beside a shield is not a separate wire)`);
    // a pigtail that takes the shield (the stock's whole bonded mass, or a member list naming it) lands as WireViz's `s`
    const shieldPigtails = new Map<string, true>();
    for (const pigtail of segment.pigtails ?? []) if (shield !== undefined && (pigtail.members === undefined || pigtail.members.includes(shield))) shieldPigtails.set(`${pigtail.end}:${pigtail.id}`, true);
    cabs.set(segment.id, { key, wires: conductors, shieldPigtails, ...(shield === undefined ? {} : { shield }) });
    const colours = conductors.map((p) => colourToCode((resolveElementPath(wire.structure, p) as { color?: string }).color));
    const areas = [...new Set(conductors.map((p) => (resolveElementPath(wire.structure, p) as { areaMm2?: number }).areaMm2))];
    const cable: Obj = {
      type: wire.label,
      ...(wire.partNumber === undefined ? {} : { pn: wire.partNumber }),
      ...(areas.length === 1 && areas[0] !== undefined ? { gauge: `${areas[0]} mm2` } : {}),
      ...(segment.lengthMm === undefined ? {} : { length: segment.lengthMm / 1000 }),
      wirecount: conductors.length,
      ...(colours.length > 0 && colours.every((c) => c !== undefined) ? { colors: colours } : {}),
      ...(shield === undefined ? {} : { shield: true }),
    };
    if (cable['colors'] !== undefined) delete cable['wirecount'];
    else if (colours.some((c) => c !== undefined)) lost.push(`segment ${segment.id}: conductor colours (a colour with no WireViz abbreviation)`);
    if (areas.length > 1) lost.push(`segment ${segment.id}: gauge (conductors differ)`);
    const labels = conductors.map((p) => segment.coreLabels?.[p] ?? '');
    if (labels.some((l) => l !== '')) cable['wirelabels'] = labels;
    const unmapped = (segment.pigtails ?? []).filter((p) => !shieldPigtails.has(`${p.end}:${p.id}`));
    if (unmapped.length > 0) lost.push(`segment ${segment.id}: ${unmapped.length} pigtail(s) (${unmapped.map((p) => p.id).join(', ')}) that do not twist the exported shield`);
    // the prep of a mapped pigtail travels as the cable's note
    const prep = (segment.pigtails ?? []).filter((p) => shieldPigtails.has(`${p.end}:${p.id}`) && p.note !== undefined).map((p) => `shield pigtail at end ${p.end}: ${p.note}`);
    if (prep.length > 0) cable['notes'] = prep.join('; ');
    cables[key] = cable;
  }

  /* joints */
  const isInstance = (id: string, kind: 'connectors' | 'segments'): boolean => design.instances[kind].some((i) => i.id === id);
  const pinOf = (ref: TerminalRef): string | undefined => (isInstance(ref.instance, 'connectors') && connectors[keyFor(ref.instance)] !== undefined ? ref.terminal : undefined);
  const wireRef = (ref: TerminalRef): { cab: Cab; ref: string | number; end: 'a' | 'b' } | undefined => {
    const cab = cabs.get(ref.instance);
    if (cab === undefined || ref.end === undefined) return undefined;
    if (ref.terminal === cab.shield) return { cab, ref: 's', end: ref.end };
    const pigtail = pigtailIdOf(ref.terminal);
    if (pigtail !== undefined) return cab.shieldPigtails.has(`${ref.end}:${pigtail}`) ? { cab, ref: 's', end: ref.end } : undefined;
    const i = cab.wires.indexOf(ref.terminal);
    return i < 0 ? undefined : { cab, ref: i + 1, end: ref.end };
  };
  const pinRefFor = (conn: string, terminal: string): string | number => {
    const def = findConnector(db, design.instances.connectors.find((c) => c.id === conn)?.def ?? '');
    const numeric = def !== undefined && def.pins.every((p, i) => p.id === String(i + 1));
    return numeric && /^\d+$/.test(terminal) ? Number(terminal) : terminal;
  };

  // per (cable, a-connector, b-connector): wire refs with their pins
  interface Group {
    cab: Cab;
    left?: string;
    right?: string;
    rows: { wire: string | number; l?: string | number; r?: string | number }[];
  }
  const groups = new Map<string, Group>();
  const perWire = new Map<string, { cab: Cab; wire: string | number; a?: { conn: string; pin: string | number }; b?: { conn: string; pin: string | number } }>();
  const loops = new Map<string, (string | number)[][]>();
  const arrows: { a: { conn: string; pin: string | number }; b: { conn: string; pin: string | number } }[] = [];
  for (const joint of design.joints) {
    const aw = wireRef(joint.a);
    const bw = wireRef(joint.b);
    const ap = pinOf(joint.a);
    const bp = pinOf(joint.b);
    if (joint.through !== undefined) {
      lost.push(`a joint through ${joint.through.instance}.${joint.through.terminal} (${joint.a.instance} to ${joint.b.instance})`);
      continue;
    }
    if (ap !== undefined && bp !== undefined) {
      if (joint.a.instance === joint.b.instance) {
        const list = loops.get(joint.a.instance) ?? [];
        list.push([pinRefFor(joint.a.instance, ap), pinRefFor(joint.b.instance, bp)]);
        loops.set(joint.a.instance, list);
      } else arrows.push({ a: { conn: joint.a.instance, pin: pinRefFor(joint.a.instance, ap) }, b: { conn: joint.b.instance, pin: pinRefFor(joint.b.instance, bp) } });
      continue;
    }
    const wire = aw ?? bw;
    const pin = ap !== undefined ? { conn: joint.a.instance, pin: pinRefFor(joint.a.instance, ap) } : bp !== undefined ? { conn: joint.b.instance, pin: pinRefFor(joint.b.instance, bp) } : undefined;
    if (wire === undefined || pin === undefined || (aw !== undefined && bw !== undefined)) {
      lost.push(`a joint between ${joint.a.instance}.${joint.a.terminal} and ${joint.b.instance}.${joint.b.terminal} (not a connector pin to a cable wire)`);
      continue;
    }
    const k = `${wire.cab.key}|${wire.ref}`;
    const entry = perWire.get(k) ?? { cab: wire.cab, wire: wire.ref };
    if (entry[wire.end] !== undefined) {
      lost.push(`${wire.cab.key} wire ${wire.ref}: a second connection at end ${wire.end} (WireViz joins one pin per wire end)`);
      continue;
    }
    entry[wire.end] = pin;
    perWire.set(k, entry);
  }
  for (const w of perWire.values()) {
    const gk = `${w.cab.key}|${w.a?.conn ?? ''}|${w.b?.conn ?? ''}`;
    const g = groups.get(gk) ?? { cab: w.cab, ...(w.a === undefined ? {} : { left: w.a.conn }), ...(w.b === undefined ? {} : { right: w.b.conn }), rows: [] };
    g.rows.push({ wire: w.wire, ...(w.a === undefined ? {} : { l: w.a.pin }), ...(w.b === undefined ? {} : { r: w.b.pin }) });
    groups.set(gk, g);
  }
  for (const [conn, list] of loops) (connectors[keyFor(conn)] as Obj | undefined)!['loops'] = list;

  const order = (v: string | number): number => (v === 's' ? Number.MAX_SAFE_INTEGER : Number(v));
  const connections: unknown[] = [];
  for (const g of [...groups.values()].sort((x, y) => (x.cab.key + (x.left ?? '')).localeCompare(y.cab.key + (y.left ?? '')))) {
    g.rows.sort((x, y) => order(x.wire) - order(y.wire));
    const set: Obj[] = [];
    if (g.left !== undefined) set.push({ [keyFor(g.left)]: pinSpec(g.rows.map((r) => r.l as string | number)) });
    set.push({ [g.cab.key]: pinSpec(g.rows.map((r) => r.wire)) });
    if (g.right !== undefined) set.push({ [keyFor(g.right)]: pinSpec(g.rows.map((r) => r.r as string | number)) });
    connections.push(set);
    if (g.rows.some((r) => (g.left !== undefined && r.l === undefined) || (g.right !== undefined && r.r === undefined))) lost.push(`${g.cab.key}: wires with one end connected are written without it`);
  }
  for (const a of arrows) connections.push([{ [keyFor(a.a.conn)]: [a.a.pin] }, '--', { [keyFor(a.b.conn)]: [a.b.pin] }]);

  const doc: Obj = {
    metadata: { title: design.label, ...(design.productRef === undefined ? {} : { description: design.productRef }) },
    connectors,
    cables,
    connections,
  };
  const header = [`# WireHub design '${design.id}' exported for WireViz.`, ...[...new Set(lost)].map((l) => `# Not carried over: ${l}.`), ''];
  return { mimeType: 'application/x-yaml; charset=utf-8', fileName: `${design.id}.wireviz.yml`, body: `${header.join('\n')}${yaml(doc, options['style'] === 'flow')}` };
}
