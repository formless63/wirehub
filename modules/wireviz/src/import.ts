/**
 * WireViz YAML -> a proposed WireHub design (cs-5k1.18).
 *
 * Written from WireViz's public syntax documentation; no WireViz code is used.
 * Pure and deterministic: the YAML text and the library in, a proposal and
 * notes out. Nothing is written until a person reviews the proposal.
 *
 * What maps:
 *   connectors  -> connector instances. A catalog connector is chosen only by an
 *                  identity the file names (`pn`, `mpn` or `type` equal to the
 *                  record's part number, id, alias or label); otherwise a new
 *                  connector record is *proposed* (pins from `pincount`, `pins`,
 *                  `pinlabels`), flagged inferred, never forced onto a lookalike.
 *   cables      -> wire segments, the same way (stock by `pn`/`mpn`/`type`, else a
 *                  proposed stock: `wirecount` or `colors` conductors, `gauge`,
 *                  `shield`), with `length` and `wirelabels`.
 *   connections -> joints, including `loops` and `--` arrows.
 * Everything WireViz can say that the model cannot is listed as "Not carried over".
 */

import { electricalPaths, resolveElementPath, validateDb, validateDesign, type CableDesign, type ConnectorDefinition, type ConnectorPin, type Db, type Joint, type WireDefinition } from '@wirehub/model';
import type { ImportResult } from '@wirehub/modules';
import { parse } from 'yaml';

import { codeColours, colourFromCode, gaugeToMm2, lengthToMm } from './colours.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : undefined);

export const kebab = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Attributes that only draw the picture: reported once, never carried. */
const PRESENTATION = ['image', 'bgcolor', 'bgcolor_title', 'style', 'show_name', 'show_pincount', 'show_wirecount', 'show_wirenumbers', 'hide_disconnected_pins', 'color'];
const KNOWN_CONNECTOR = new Set(['type', 'subtype', 'pn', 'manufacturer', 'mpn', 'supplier', 'spn', 'pincount', 'pins', 'pinlabels', 'pincolors', 'loops', 'notes', 'additional_components', ...PRESENTATION]);
const KNOWN_CABLE = new Set(['type', 'gauge', 'length', 'shield', 'wirecount', 'colors', 'color_code', 'wirelabels', 'category', 'pn', 'manufacturer', 'mpn', 'supplier', 'spn', 'notes', 'additional_components', ...PRESENTATION]);

interface ParsedConnector {
  key: string;
  id: string;
  /** pin ids in order, and the label of each */
  pins: { id: string; label?: string }[];
  matched?: ConnectorDefinition;
  proposed?: ConnectorDefinition;
}

interface ParsedCable {
  key: string;
  id: string;
  /** electrical paths of the stock, in wire order (index 0 = wire 1) */
  wires: string[];
  shield?: string;
  labels: (string | undefined)[];
  def: string;
  proposed?: WireDefinition;
}

/** `1-3` -> 1,2,3; `9-7` -> 9,8,7; anything else is one reference. */
function expand(spec: unknown): string[] {
  if (Array.isArray(spec)) return spec.flatMap(expand);
  const text = String(spec).trim();
  return [text];
}

function expandRange(ref: string, resolves: (r: string) => boolean): string[] {
  if (resolves(ref)) return [ref];
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(ref);
  if (m === null) return [ref];
  const from = Number(m[1]);
  const to = Number(m[2]);
  const out: string[] = [];
  for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? 1 : -1) out.push(String(n));
  return out;
}

const identityOf = (record: { id: string; label: string; partNumber?: string; aliases?: string[] }): string[] => [record.id, record.label, ...(record.partNumber === undefined ? [] : [record.partNumber]), ...(record.aliases ?? [])].map((s) => s.toLowerCase());

export function importWireViz(fileName: string, bytes: Uint8Array, db: Db): ImportResult {
  const notes: string[] = [];
  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  let doc: unknown;
  try {
    doc = parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`${fileName} is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  if (!isObj(doc)) throw new Error(`${fileName} is not a WireViz harness: the top level must be a mapping with connectors, cables and connections.`);
  const connectorsIn = isObj(doc['connectors']) ? doc['connectors'] : {};
  const cablesIn = isObj(doc['cables']) ? doc['cables'] : {};
  const connectionsIn = Array.isArray(doc['connections']) ? doc['connections'] : [];
  if (Object.keys(connectorsIn).length === 0 && Object.keys(cablesIn).length === 0) throw new Error(`${fileName} has no connectors or cables.`);

  const metadata = isObj(doc['metadata']) ? doc['metadata'] : {};
  const title = str(metadata['title']);
  const designId = kebab(title ?? stem) || 'wireviz-import';
  const src = `imported from WireViz YAML ${fileName.replace(/^.*[\\/]/, '')} (mapping inferred; see the import notes)`;
  const taken = new Set<string>([...db.connectors.map((c) => c.id), ...db.wires.map((w) => w.id), ...db.components.map((c) => c.id), ...db.pcbas.map((c) => c.id), ...(db.mechanicals ?? []).map((m) => m.id)]);
  const freshId = (base: string): string => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  const lossy = new Set<string>();
  const lose = (text: string): void => {
    lossy.add(text);
  };
  for (const key of ['description', 'notes']) if (metadata[key] !== undefined) lose(`metadata ${key} (kept only as a design note where it is text)`);

  /* ---- connectors ---- */
  const connectors = new Map<string, ParsedConnector>();
  const instanceIds = new Set<string>();
  const instanceId = (key: string): string => {
    let id = kebab(key) || 'part';
    for (let n = 2; instanceIds.has(id); n += 1) id = `${kebab(key) || 'part'}-${n}`;
    instanceIds.add(id);
    return id;
  };
  const designNotes: string[] = [];
  if (typeof metadata['notes'] === 'string' && metadata['notes'].trim() !== '') designNotes.push(metadata['notes'].trim());
  const proposedConnectors: ConnectorDefinition[] = [];
  const connectorInstances: CableDesign['instances']['connectors'] = [];
  const joints: Joint[] = [];

  for (const [key, raw] of Object.entries(connectorsIn)) {
    const c = isObj(raw) ? raw : {};
    for (const k of Object.keys(c)) if (!KNOWN_CONNECTOR.has(k)) lose(`connector ${key}: attribute '${k}'`);
    for (const k of PRESENTATION) if (c[k] !== undefined) lose(`connector ${key}: '${k}' (appearance only)`);
    if (c['pincolors'] !== undefined) lose(`connector ${key}: pin colours`);
    if (c['additional_components'] !== undefined) lose(`connector ${key}: additional components (add them as library parts)`);
    const pinsIn = Array.isArray(c['pins']) ? c['pins'].map((p) => String(p)) : undefined;
    const labelsIn = Array.isArray(c['pinlabels']) ? c['pinlabels'].map((p) => (p === null || p === undefined || p === '' ? undefined : String(p))) : undefined;
    const count = typeof c['pincount'] === 'number' ? c['pincount'] : (pinsIn?.length ?? labelsIn?.length ?? 0);
    const pins: ParsedConnector['pins'] = Array.from({ length: count }, (_, i) => {
      const label = labelsIn?.[i];
      return { id: pinsIn?.[i] ?? String(i + 1), ...(label === undefined ? {} : { label }) };
    });
    const id = instanceId(key);
    const type = str(c['type']);
    const subtype = str(c['subtype']);
    const wanted = [str(c['pn']), str(c['mpn']), type, type === undefined || subtype === undefined ? undefined : `${type} ${subtype}`].filter((s): s is string => s !== undefined).map((s) => s.toLowerCase());
    const matched = db.connectors.find((d) => identityOf(d).some((i) => wanted.includes(i)) && (count === 0 || d.pins.length === count));
    const parsed: ParsedConnector = { key, id, pins };
    if (matched !== undefined) {
      parsed.matched = matched;
      parsed.pins = matched.pins.map((p) => ({ id: p.id, label: p.label }));
      notes.push(`connector ${key}: matched the library's '${matched.id}' by ${wanted.find((w) => identityOf(matched).includes(w))}.`);
    } else {
      if (pins.length === 0) {
        notes.push(`connector ${key}: no pincount, pins or pinlabels, so it was left out (and its connections).`);
        connectors.set(key, { ...parsed, pins: [] });
        continue;
      }
      const gender = /^(male|female)$/i.test(subtype ?? '') ? (subtype as string).toLowerCase() : undefined;
      if (subtype !== undefined && gender === undefined) lose(`connector ${key}: subtype '${subtype}' is not a gender, kept in the label only`);
      const label = [type ?? key, subtype, str(c['mpn']) ?? str(c['pn'])].filter((s) => s !== undefined).join(' ');
      const def: ConnectorDefinition = {
        id: freshId(`${designId}-${kebab(key)}`),
        label,
        family: type ?? 'unspecified',
        ...(gender === undefined ? {} : { gender }),
        pins: pins.map((p): ConnectorPin => ({ id: p.id, label: p.label ?? p.id })),
        src: `${src}: connector ${key}${str(c['manufacturer']) === undefined ? '' : `, manufacturer ${str(c['manufacturer'])}`}${str(c['mpn']) === undefined ? '' : `, mpn ${str(c['mpn'])}`} (INFERRED: pin layout from pincount/pins/pinlabels only)`,
      };
      parsed.proposed = def;
      proposedConnectors.push(def);
      notes.push(`connector ${key}: no library connector matches by part number, type or label, so a new connector '${def.id}' (${pins.length} pins) is proposed.`);
    }
    connectors.set(key, parsed);
    const note = str(c['notes']);
    connectorInstances.push({ id, def: (parsed.matched ?? parsed.proposed)!.id, ...(note === undefined ? {} : { note }) });
    // loops: shorts between pins of this connector
    if (Array.isArray(c['loops'])) {
      for (const loop of c['loops']) {
        if (!Array.isArray(loop) || loop.length < 2) continue;
        const refs = loop.map((r) => resolvePin(parsed, String(r)));
        if (refs.some((r) => r === undefined)) {
          notes.push(`connector ${key}: a loop names a pin that is not on it (${loop.join(', ')}); skipped.`);
          continue;
        }
        for (let i = 1; i < refs.length; i += 1) joints.push({ a: { instance: id, terminal: refs[0] as string }, b: { instance: id, terminal: refs[i] as string }, note: 'loop (WireViz)' });
      }
    }
  }

  function resolvePin(conn: ParsedConnector, ref: string): string | undefined {
    const direct = conn.pins.find((p) => p.id === ref);
    if (direct !== undefined) return direct.id;
    const byLabel = conn.pins.find((p) => p.label !== undefined && p.label.toLowerCase() === ref.toLowerCase());
    if (byLabel !== undefined) return byLabel.id;
    if (/^\d+$/.test(ref)) return conn.pins[Number(ref) - 1]?.id;
    return undefined;
  }

  /* ---- cables ---- */
  const cables = new Map<string, ParsedCable>();
  const proposedWires: WireDefinition[] = [];
  const segments: CableDesign['instances']['segments'] = [];
  for (const [key, raw] of Object.entries(cablesIn)) {
    const c = isObj(raw) ? raw : {};
    for (const k of Object.keys(c)) if (!KNOWN_CABLE.has(k)) lose(`cable ${key}: attribute '${k}'`);
    for (const k of PRESENTATION) if (c[k] !== undefined) lose(`cable ${key}: '${k}' (appearance only)`);
    if (c['additional_components'] !== undefined) lose(`cable ${key}: additional components`);
    if (str(c['category']) === 'bundle') lose(`cable ${key}: category bundle (listed per wire in WireViz's BOM; here it is one stock)`);
    const colorsIn = Array.isArray(c['colors']) ? c['colors'].map((x) => String(x)) : undefined;
    const wirecount = typeof c['wirecount'] === 'number' ? c['wirecount'] : colorsIn?.length ?? 0;
    const id = instanceId(key);
    const type = str(c['type']);
    const wanted = [str(c['pn']), str(c['mpn']), type].filter((s): s is string => s !== undefined).map((s) => s.toLowerCase());
    const matched = db.wires.find((w) => identityOf(w).some((i) => wanted.includes(i)));
    const lengthMm = c['length'] === undefined ? undefined : lengthToMm(c['length']);
    if (c['length'] !== undefined && lengthMm === undefined) notes.push(`cable ${key}: length ${JSON.stringify(c['length'])} is not a number with an optional unit (mm, cm, m, in, ft, yd); left out.`);
    let parsed: ParsedCable;
    if (matched !== undefined) {
      const paths = electricalPaths(matched.structure);
      const conductors = paths.filter((p) => {
        const e = resolveElementPath(matched.structure, p);
        return e?.kind === 'conductor' && e.bare !== true;
      });
      const shield = paths.find((p) => resolveElementPath(matched.structure, p)?.kind === 'shield') ?? paths.find((p) => {
        const e = resolveElementPath(matched.structure, p);
        return e?.kind === 'conductor' && e.bare === true;
      });
      parsed = { key, id, wires: conductors, ...(shield === undefined ? {} : { shield }), labels: [], def: matched.id };
      notes.push(`cable ${key}: matched the library's stock '${matched.id}' by ${wanted.find((w) => identityOf(matched).includes(w))}; wire numbers follow the stock's conductor order.`);
      if (wirecount > 0 && wirecount !== conductors.length) notes.push(`cable ${key}: the file says ${wirecount} wires but '${matched.id}' has ${conductors.length}.`);
      if (c['colors'] !== undefined || c['color_code'] !== undefined) lose(`cable ${key}: wire colours (the library stock's own colours are used)`);
      if (c['gauge'] !== undefined) lose(`cable ${key}: gauge (the library stock's own conductor is used)`);
    } else {
      let colours: (string | undefined)[] = [];
      if (colorsIn !== undefined) {
        colours = colorsIn.map((code) => colourFromCode(code));
        colours.forEach((col, i) => {
          if (col === undefined) notes.push(`cable ${key}: wire ${i + 1} colour '${colorsIn[i]}' is not a colour this reads; left blank.`);
        });
      } else if (typeof c['color_code'] === 'string' && wirecount > 0) {
        const fromCode = codeColours(c['color_code'], wirecount);
        if (fromCode === undefined) notes.push(`cable ${key}: colour code '${c['color_code']}' is not read (IEC, T568A, T568B and BW are); wires have no colours.`);
        else {
          colours = fromCode;
          notes.push(`cable ${key}: colours taken from colour code ${c['color_code']} (INFERRED sequence; check against the cable).`);
        }
      }
      const n = Math.max(wirecount, colours.length);
      const area = c['gauge'] === undefined ? undefined : gaugeToMm2(c['gauge']);
      if (c['gauge'] !== undefined && area === undefined) notes.push(`cable ${key}: gauge ${JSON.stringify(c['gauge'])} is not mm2 or AWG; left out.`);
      if (area?.converted === true) notes.push(`cable ${key}: ${String(c['gauge'])} converted to ${area.areaMm2} mm2 (standard AWG diameter formula).`);
      const shieldIn = c['shield'];
      const hasShield = shieldIn === true || typeof shieldIn === 'string';
      if (typeof shieldIn === 'string') lose(`cable ${key}: shield colour`);
      if (n === 0) {
        notes.push(`cable ${key}: no wirecount or colors, so it was left out (and its connections).`);
        cables.set(key, { key, id, wires: [], labels: [], def: '' });
        continue;
      }
      const wireDefId = freshId(`${designId}-${kebab(key)}`);
      const conductorIds = Array.from({ length: n }, (_, i) => `w${i + 1}`);
      const def: WireDefinition = {
        id: wireDefId,
        label: type ?? `${key} cable`,
        structure: {
          kind: 'group',
          id: wireDefId,
          label: type ?? key,
          role: 'cable',
          children: [
            ...conductorIds.map((cid, i) => ({
              kind: 'conductor' as const,
              id: cid,
              ...(colours[i] === undefined ? {} : { color: colours[i] as string }),
              ...(area === undefined ? {} : { areaMm2: area.areaMm2 }),
            })),
            ...(hasShield ? [{ kind: 'shield' as const, id: 'shield', construction: 'foil' as const }] : []),
          ],
        },
        src: `${src}: cable ${key}${str(c['mpn']) === undefined ? '' : `, mpn ${str(c['mpn'])}`} (INFERRED: construction from wirecount/colors/gauge/shield only)`,
      };
      if (hasShield) notes.push(`cable ${key}: a shield is proposed as foil because WireViz does not say what kind (INFERRED).`);
      proposedWires.push(def);
      notes.push(`cable ${key}: no library stock matches by part number or type, so a new stock '${def.id}' (${n} conductors) is proposed.`);
      parsed = { key, id, wires: conductorIds, ...(hasShield ? { shield: 'shield' } : {}), labels: [], def: def.id, proposed: def };
    }
    const labelsIn = Array.isArray(c['wirelabels']) ? c['wirelabels'].map((l) => str(l)) : [];
    parsed.labels = labelsIn;
    cables.set(key, parsed);
    const coreLabels: Record<string, string> = {};
    labelsIn.forEach((label, i) => {
      const path = parsed.wires[i];
      if (label !== undefined && path !== undefined) coreLabels[path] = label;
    });
    const note = str(c['notes']);
    if (note !== undefined) designNotes.push(`${key}: ${note}`);
    segments.push({ id, def: parsed.def, ...(lengthMm === undefined ? {} : { lengthMm }), ...(type === undefined ? {} : { role: type }), ...(Object.keys(coreLabels).length === 0 ? {} : { coreLabels }) });
  }

  /* ---- connections ---- */
  type Entry = { kind: 'connector'; conn: ParsedConnector; refs: string[] } | { kind: 'cable'; cable: ParsedCable; refs: string[] } | { kind: 'arrow'; arrow: string };
  const toEntry = (raw: unknown, where: string): Entry | undefined => {
    if (typeof raw === 'string') return /^(<?-+>?|<?=+>?)$/.test(raw.trim()) ? { kind: 'arrow', arrow: raw.trim() } : undefined;
    if (!isObj(raw)) return undefined;
    const keys = Object.keys(raw);
    if (keys.length !== 1) return undefined;
    const key = keys[0] as string;
    const specs = expand(raw[key]);
    const conn = connectors.get(key);
    if (conn !== undefined) {
      const ok = (r: string): boolean => resolvePin(conn, r) !== undefined;
      return { kind: 'connector', conn, refs: specs.flatMap((r) => expandRange(r, ok)) };
    }
    const cable = cables.get(key);
    if (cable !== undefined) {
      const ok = (r: string): boolean => r.toLowerCase() === 's' || wireIndex(cable, r) !== undefined;
      return { kind: 'cable', cable, refs: specs.flatMap((r) => expandRange(r, ok)) };
    }
    notes.push(`${where}: '${key}' is not a connector or cable in the file; the set was skipped.`);
    return undefined;
  };
  function wireIndex(cable: ParsedCable, ref: string): number | undefined {
    const byLabel = cable.labels.findIndex((l) => l !== undefined && l.toLowerCase() === ref.toLowerCase());
    if (byLabel >= 0) return byLabel;
    return /^\d+$/.test(ref) && Number(ref) >= 1 && Number(ref) <= cable.wires.length ? Number(ref) - 1 : undefined;
  }
  const cablePath = (cable: ParsedCable, ref: string): string | undefined => (ref.toLowerCase() === 's' ? cable.shield : cable.wires[wireIndex(cable, ref) ?? -1]);
  const seen = new Set<string>();
  const add = (joint: Joint): void => {
    const k = JSON.stringify([joint.a, joint.b]);
    if (seen.has(k)) return;
    seen.add(k);
    joints.push(joint);
  };

  connectionsIn.forEach((set, index) => {
    const where = `connection set ${index + 1}`;
    if (!Array.isArray(set)) {
      notes.push(`${where} is not a list; skipped.`);
      return;
    }
    const entries = set.map((raw) => toEntry(raw, where));
    if (entries.some((e) => e === undefined)) {
      if (entries.every((e) => e === undefined || e.kind === 'arrow')) return;
      notes.push(`${where}: an entry was not understood; the set was skipped.`);
      return;
    }
    const list = entries as Entry[];
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i] as Entry;
      if (e.kind === 'arrow') {
        const left = list[i - 1];
        const right = list[i + 1];
        if (/=/.test(e.arrow)) {
          lose(`${where}: mating arrow '${e.arrow}' (connector mating is not modelled)`);
          continue;
        }
        if (left?.kind !== 'connector' || right?.kind !== 'connector' || left.refs.length !== right.refs.length) {
          notes.push(`${where}: arrow '${e.arrow}' needs a connector with the same number of pins on each side; skipped.`);
          continue;
        }
        left.refs.forEach((r, n) => {
          const a = resolvePin(left.conn, r);
          const b = resolvePin(right.conn, right.refs[n] as string);
          if (a === undefined || b === undefined) notes.push(`${where}: pin '${a === undefined ? r : right.refs[n]}' is not on its connector; skipped.`);
          else add({ a: { instance: left.conn.id, terminal: a }, b: { instance: right.conn.id, terminal: b } });
        });
        if (e.arrow.includes('<') || e.arrow.includes('>')) lose(`${where}: arrow direction`);
        continue;
      }
      if (e.kind !== 'cable') continue;
      const sides: [Entry | undefined, 'a' | 'b'][] = [[list[i - 1], 'a'], [list[i + 1], 'b']];
      for (const [side, end] of sides) {
        if (side === undefined || side.kind !== 'connector') continue;
        if (side.refs.length !== e.refs.length) {
          notes.push(`${where}: ${side.conn.key} lists ${side.refs.length} pins but ${e.cable.key} lists ${e.refs.length} wires; that side was skipped.`);
          continue;
        }
        side.refs.forEach((pinRef, n) => {
          const pin = resolvePin(side.conn, pinRef);
          const path = cablePath(e.cable, e.refs[n] as string);
          if (pin === undefined) notes.push(`${where}: pin '${pinRef}' is not on ${side.conn.key}; skipped.`);
          else if (path === undefined) notes.push(`${where}: wire '${e.refs[n]}' is not on ${e.cable.key}; skipped.`);
          else {
            const wireEnd = { instance: e.cable.id, terminal: path, end };
            const pinEnd = { instance: side.conn.id, terminal: pin };
            add(end === 'a' ? { a: pinEnd, b: wireEnd } : { a: wireEnd, b: pinEnd });
          }
        });
      }
    }
  });
  if (connectionsIn.length === 0) notes.push('the file has no connections; the design has parts but no joints.');
  if (doc['additional_bom_items'] !== undefined) lose('additional_bom_items');
  for (const key of Object.keys(doc)) if (!['metadata', 'connectors', 'cables', 'connections', 'additional_bom_items', 'options', 'tweak', 'templates', 'ferrules', 'bundles'].includes(key)) lose(`top-level '${key}'`);
  for (const key of ['options', 'tweak', 'templates']) if (doc[key] !== undefined) lose(`top-level '${key}' (rendering only)`);

  const design: CableDesign = {
    schemaVersion: 4,
    id: designId,
    label: title ?? stem,
    instances: { connectors: connectorInstances, segments, components: [], pcbas: [] },
    joints,
    ...(designNotes.length === 0 ? {} : { notes: designNotes }),
    src,
  };

  const merged: Db = { ...db, connectors: [...db.connectors, ...proposedConnectors], wires: [...db.wires, ...proposedWires] };
  const proposedIds = new Set([...proposedConnectors.map((c) => c.id), ...proposedWires.map((w) => w.id)]);
  for (const issue of validateDb(merged)) if (issue.severity === 'error' && [...proposedIds].some((id) => issue.where?.includes(id))) notes.push(`the proposed ${issue.where}: ${issue.message}`);
  for (const issue of validateDesign(design, merged)) notes.push(`${issue.severity === 'error' ? 'the design has a problem' : 'design warning'}: ${issue.message}`);
  for (const text of [...lossy].sort()) notes.push(`Not carried over: ${text}.`);

  return {
    definitions: { ...(proposedConnectors.length === 0 ? {} : { connectors: proposedConnectors }), ...(proposedWires.length === 0 ? {} : { wires: proposedWires }) },
    designs: [design],
    notes,
  };
}

