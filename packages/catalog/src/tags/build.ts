/**
 * Build the signal tag table, the instance-slot table and the unclassified
 * report from the catalog.
 *
 * Deterministic: the same catalog and review file give byte-identical output,
 * so a check can say whether the committed
 * files are current, and `test/tags.test.ts` can hold them to it.
 *
 * The proposals come from `classify.ts`; the reviewed corrections come from
 * `data/tags/review.json` and always win. A tag already written on a record
 * (`ConnectorPin.signal`, `PcbaTerminal.role`/`signal`, `WireDefinition.colourCode`)
 * is the record's own and is left out of the table.
 */

import {
  electricalPaths,
  resolveElementPath,
  signalIds,
  vocabEntry,
  type CableDesign,
  type ConnectorDefinition,
  type PcbaDefinition,
  type PcbaTerminalTags,
  type SignalEntry,
  type SignalRef,
  type SignalTags,
  type Vocab,
  type WireDefinition,
  type WireTags,
} from '@wirehub/model';

import { colourCodeFor, padTags, pinSignal, slotOfRole } from './classify.ts';

/** Reviewed corrections to the proposals, each with its reason. */
export interface TagReview {
  src: string;
  connectors?: Record<string, Record<string, { signal: SignalRef | null; why: string }>>;
  pcbas?: Record<string, Record<string, { role?: string | null; signal?: SignalRef | null; why: string }>>;
  wires?: Record<string, { colourCode?: string | null; lanes?: Record<string, string>; why: string }>;
  slots?: Record<string, { slot: string | null; why: string }>;
}

/** Two tag values say the same thing (`null` — no tag — equals an absent proposal). */
function sameTag(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * A correction with every field that only restates the proposal removed —
 * `undefined` when nothing is left, so the caller drops the review entry
 * instead of writing one that changes nothing. `why` is not a field.
 */
export function withoutProposal<T extends { why: string }>(
  fix: T,
  proposal: Readonly<Record<string, unknown>>,
): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fix)) {
    if (key === 'why') continue;
    if (value === undefined || sameTag(value, proposal[key])) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : ({ ...out, why: fix.why } as T);
}

/** The colour code the generator proposes for a stock (before any correction). */
export function proposedColourCode(vocab: Vocab, wire: WireDefinition): string | undefined {
  const conductors = electricalPaths(wire.structure)
    .map((path) => ({ path, element: resolveElementPath(wire.structure, path) }))
    .filter((c) => c.element?.kind === 'conductor' && c.element.bare !== true)
    .map((c) => ({
      path: c.path,
      ...(c.element?.kind === 'conductor' && c.element.color !== undefined ? { color: c.element.color } : {}),
      ...(c.element?.label === undefined ? {} : { label: c.element.label }),
    }));
  return colourCodeFor(vocab, conductors)?.code;
}

/** `data/tags/instance-slots.json`: design id → instance id → slot. */
export interface InstanceSlots {
  src: string;
  designs: Record<string, Record<string, string>>;
}

export interface TagInputs {
  vocab: Vocab;
  connectors: ConnectorDefinition[];
  pcbas: PcbaDefinition[];
  wires: WireDefinition[];
  designs: CableDesign[];
  review: TagReview;
}

export interface TagOutputs {
  tags: SignalTags;
  slots: InstanceSlots;
  report: string;
  /** the numbers the report leads with */
  stats: {
    unclassifiedPins: number;
    unclassifiedTerminals: number;
    unclassifiedWires: number;
    unslottedRoles: number;
    /** unclassified pins and terminals a live design solders — the gate is 0 */
    unclassifiedUsed: number;
    conflicts: number;
  };
}

const TAGS_SRC =
  'generated from connectors.json, the PCBA definitions and wires.json ' +
  '(labels, aliases, silkscreen ids, conductor colours) with the reviewed corrections in data/tags/review.json. ' +
  'Connector pin signals live in data/interfaces.json, so the connectors table only holds pins of a connector with no interface';

const SLOTS_SRC = "generated from each instance's free-text role; design files are never rewritten by the tagger";

const isLive = (design: CableDesign): boolean => design.status !== 'retired';

/** `ref` as the report prints it. */
function show(ref: SignalRef | undefined): string {
  if (ref === undefined) return '—';
  return typeof ref === 'string' ? `\`${ref}\`` : `one of ${ref.oneOf.map((s) => `\`${s}\``).join(', ')}`;
}

function esc(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function buildTags(given: TagInputs): TagOutputs {
  // retired board revisions (kept for reference only) are not tagged
  const input: TagInputs = { ...given, pcbas: given.pcbas.filter((p) => p.status !== 'retired') };
  const { vocab, review } = input;
  const lines: string[] = [];

  /* ---------------- which terminals live designs solder -------------- */
  const used = new Set<string>();
  for (const design of input.designs) {
    if (!isLive(design)) continue;
    const defOf = new Map<string, string>();
    for (const list of [design.instances.connectors, design.instances.pcbas, design.instances.segments]) {
      for (const instance of list) defOf.set(instance.id, instance.def);
    }
    for (const joint of design.joints) {
      for (const ref of [joint.a, joint.b]) {
        const def = defOf.get(ref.instance);
        if (def === undefined) continue;
        const key = `${def}:${ref.terminal}`;
        used.add(key);
      }
    }
  }
  // a joint onto an integrated connector's pin (`u1:scart.15`) uses that connector's pin
  for (const pcba of input.pcbas) {
    for (const integrated of pcba.integratedConnectors ?? []) {
      for (const key of [...used]) {
        const prefix = `${pcba.id}:${integrated.terminalPrefix}.`;
        if (key.startsWith(prefix)) used.add(`${integrated.connectorDefId}:${key.slice(prefix.length)}`);
      }
    }
  }

  /* ---------------- connectors --------------------------------------- */
  const connectors: Record<string, Record<string, SignalRef>> = {};
  const unclassifiedPins: { connector: string; pin: string; label: string; used: boolean }[] = [];
  const pinLabels = new Map<string, Set<string>>();
  // a pin that carries its own signal (composed from its interface, data model
  // v2 task 5) is tagged at the source: counted, never copied into the table
  const ownPinSignals: SignalRef[] = [];
  for (const connector of input.connectors) {
    const out: Record<string, SignalRef> = {};
    for (const pin of connector.pins) {
      if (pin.signal !== undefined) {
        ownPinSignals.push(pin.signal);
        const tagged = pinLabels.get(pin.label) ?? new Set<string>();
        tagged.add(show(pin.signal));
        pinLabels.set(pin.label, tagged);
        continue;
      }
      const fix = review.connectors?.[connector.id]?.[pin.id];
      const signal = fix !== undefined ? (fix.signal ?? undefined) : pinSignal(pin);
      const tagged = pinLabels.get(pin.label) ?? new Set<string>();
      tagged.add(show(signal));
      pinLabels.set(pin.label, tagged);
      if (signal === undefined) {
        unclassifiedPins.push({ connector: connector.id, pin: pin.id, label: pin.label, used: used.has(`${connector.id}:${pin.id}`) });
        continue;
      }
      out[pin.id] = signal;
    }
    if (Object.keys(out).length > 0) connectors[connector.id] = out;
  }

  /* ---------------- boards ------------------------------------------- */
  const pcbas: Record<string, Record<string, PcbaTerminalTags>> = {};
  const unclassifiedPads: { board: string; terminal: string; label: string; used: boolean }[] = [];
  const conflicts: { board: string; terminal: string; label: string; role: string; signal: string }[] = [];
  const padIds = new Map<string, Set<string>>();
  const laneOfSignal = (id: string): string | undefined => {
    const lanes: Record<string, string> = { 'video-r': 'video-r', 'video-g': 'video-g', 'video-b': 'video-b', 'audio-l': 'audio-l', 'audio-r': 'audio-r' };
    return lanes[id];
  };
  for (const pcba of input.pcbas) {
    const out: Record<string, PcbaTerminalTags> = {};
    for (const terminal of pcba.terminals) {
      if (terminal.role !== undefined || terminal.signal !== undefined) continue;
      const proposal = padTags(vocab, terminal);
      const fix = review.pcbas?.[pcba.id]?.[terminal.id];
      const role = fix?.role === null ? undefined : (fix?.role ?? proposal.role);
      const signal = fix?.signal === null ? undefined : (fix?.signal ?? proposal.signal);
      if (!terminal.id.includes('.')) {
        const roles = padIds.get(terminal.id) ?? new Set<string>();
        roles.add(role ?? '—');
        padIds.set(terminal.id, roles);
      }
      if (role === undefined && signal === undefined) {
        unclassifiedPads.push({ board: pcba.id, terminal: terminal.id, label: terminal.label ?? '', used: used.has(`${pcba.id}:${terminal.id}`) });
        continue;
      }
      // a pad whose silkscreen names one lane and whose label names another
      const roleLane = role === undefined ? undefined : (vocabEntry<{ id: string; label: string; src: string; lane?: string }>(vocab, 'pad-roles', role)?.lane);
      const signalLane = typeof signal === 'string' ? laneOfSignal(signal) : undefined;
      if (roleLane !== undefined && signalLane !== undefined && roleLane !== signalLane && fix === undefined) {
        conflicts.push({ board: pcba.id, terminal: terminal.id, label: terminal.label ?? '', role: role as string, signal: signal as string });
      }
      out[terminal.id] = { ...(role === undefined ? {} : { role }), ...(signal === undefined ? {} : { signal }) };
    }
    if (Object.keys(out).length > 0) pcbas[pcba.id] = out;
  }

  /* ---------------- wire stocks -------------------------------------- */
  const wires: Record<string, WireTags> = {};
  const unclassifiedWires: string[] = [];
  for (const wire of input.wires) {
    if (wire.colourCode !== undefined) continue;
    const fix = review.wires?.[wire.id];
    const proposal = proposedColourCode(vocab, wire);
    const code = fix?.colourCode === null ? undefined : (fix?.colourCode ?? proposal);
    if (code === undefined) {
      unclassifiedWires.push(wire.id);
      continue;
    }
    wires[wire.id] = { colourCode: code, ...(fix?.lanes === undefined ? {} : { lanes: fix.lanes }) };
  }

  /* ---------------- instance roles → slots ----------------------------- */
  const designs: Record<string, Record<string, string>> = {};
  const roleSlots = new Map<string, { slot: string | undefined; count: number; kind: string }>();
  for (const design of input.designs) {
    const out: Record<string, string> = {};
    const kinds: ['connector' | 'segment', { id: string; def: string; role?: string }[]][] = [
      ['connector', design.instances.connectors],
      ['segment', design.instances.segments],
    ];
    for (const [kind, instances] of kinds) {
      for (const instance of instances) {
        if (instance.role === undefined) continue;
        const fix = review.slots?.[instance.role];
        const slot = fix !== undefined ? (fix.slot ?? undefined) : slotOfRole(kind, instance.role, instance.def);
        const seen = roleSlots.get(instance.role) ?? { slot, count: 0, kind };
        seen.count += 1;
        roleSlots.set(instance.role, seen);
        if (slot !== undefined) out[instance.id] = slot;
      }
    }
    if (Object.keys(out).length > 0) designs[design.id] = out;
  }

  /* ---------------- report ------------------------------------------- */
  const pinCount = input.connectors.reduce((n, c) => n + c.pins.length, 0);
  const pinTagged = Object.values(connectors).reduce((n, c) => n + Object.keys(c).length, 0) + ownPinSignals.length;
  const terminalCount = input.pcbas.reduce((n, p) => n + p.terminals.length, 0);
  const terminalTagged = Object.values(pcbas).reduce((n, p) => n + Object.keys(p).length, 0);
  const cablePads = input.pcbas.reduce((n, p) => n + p.terminals.filter((t) => !t.id.includes('.')).length, 0);
  const roleIds = new Set([...padIds.values()].flatMap((s) => [...s]).filter((r) => r !== '—'));
  const usedUnclassified = unclassifiedPins.filter((p) => p.used).length + unclassifiedPads.filter((p) => p.used).length;
  const slotIds = new Set([...roleSlots.values()].map((r) => r.slot).filter((s): s is string => s !== undefined));
  const unslotted = [...roleSlots].filter(([, r]) => r.slot === undefined);

  lines.push(
    '# Signal tags — coverage and unclassified report',
    '',
    'Generated by the catalog\'s tag builder (`src/tags/build.ts`, run by the studio after every definition write).',
    'Do not edit: correct a tag in `data/tags/review.json` (with its reason) and re-run with `--write`.',
    '',
    '## Coverage',
    '',
    '| What | Count | Tagged | Unclassified | Used by a live design and unclassified |',
    '|---|---:|---:|---:|---:|',
    `| Connector pins (${input.connectors.length} connectors) | ${pinCount} | ${pinTagged} | ${unclassifiedPins.length} | ${unclassifiedPins.filter((p) => p.used).length} |`,
    `| Board terminals (${input.pcbas.length} boards; ${cablePads} cable pads) | ${terminalCount} | ${terminalTagged} | ${unclassifiedPads.length} | ${unclassifiedPads.filter((p) => p.used).length} |`,
    `| Wire stocks (colour code) | ${input.wires.length} | ${Object.keys(wires).length} | ${unclassifiedWires.length} | — |`,
    `| Instance role strings (${input.designs.length} designs) | ${roleSlots.size} | ${roleSlots.size - unslotted.length} | ${unslotted.length} | — |`,
    '',
    `**${usedUnclassified} unclassified terminal(s) are soldered by a live design** (the gate is 0).`,
    '',
    '## Counts',
    '',
    `- **${pinLabels.size} distinct pin labels** → ${new Set([...Object.values(connectors).flatMap((pins) => Object.values(pins)), ...ownPinSignals].flatMap(signalIds)).size} distinct signals.`,
    `- **${padIds.size} distinct cable-pad ids** → ${roleIds.size} pad roles.`,
    `- **${roleSlots.size} distinct instance role strings** across ${input.designs.length} designs → ${slotIds.size} slots.`,
    '',
  );

  lines.push('## Pin labels → signals', '', '| Pin label | Tag(s) |', '|---|---|');
  for (const [label, tags] of [...pinLabels].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${esc(label)} | ${[...tags].join('; ')} |`);
  }
  lines.push('', '## Cable-pad ids → pad roles', '', '| Silkscreen id | Role(s) |', '|---|---|');
  for (const [id, roles] of [...padIds].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| \`${id}\` | ${[...roles].map((r) => (r === '—' ? '—' : `\`${r}\``)).join(', ')} |`);
  }

  lines.push('', '## Unclassified connector pins', '');
  if (unclassifiedPins.length === 0) lines.push('None.');
  else {
    lines.push('| Connector | Pin | Label | Soldered by a live design |', '|---|---|---|---|');
    for (const p of unclassifiedPins) lines.push(`| ${p.connector} | ${p.pin} | ${esc(p.label)} | ${p.used ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Unclassified board terminals', '');
  if (unclassifiedPads.length === 0) lines.push('None.');
  else {
    const byLabel = new Map<string, { boards: Set<string>; terminals: number; used: number }>();
    for (const p of unclassifiedPads) {
      const entry = byLabel.get(p.label) ?? { boards: new Set<string>(), terminals: 0, used: 0 };
      entry.boards.add(p.board);
      entry.terminals += 1;
      if (p.used) entry.used += 1;
      byLabel.set(p.label, entry);
    }
    lines.push(
      'Grouped by label.',
      '',
      '| Label | Terminals | Boards | Soldered by a live design |',
      '|---|---:|---:|---:|',
    );
    for (const [label, e] of [...byLabel].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| ${esc(label === '' ? '(no label)' : label)} | ${e.terminals} | ${e.boards.size} | ${e.used} |`);
    }
  }
  lines.push('', '## Pads whose silkscreen and label disagree (for review)', '');
  if (conflicts.length === 0) lines.push('None.');
  else {
    lines.push(
      'The role follows the silkscreen id and the signal follows the label, so both facts are kept and nothing',
      'a consumer reads today changes. Resolve in `data/tags/review.json` once the board is checked.',
      '',
      '| Board | Pad | Label | Role (silkscreen) | Signal (label) |',
      '|---|---|---|---|---|',
    );
    for (const c of conflicts) lines.push(`| ${c.board} | \`${c.terminal}\` | ${esc(c.label)} | \`${c.role}\` | \`${c.signal}\` |`);
  }
  lines.push('', '## Wire stocks → colour codes', '', '| Stock | Colour code |', '|---|---|');
  for (const wire of input.wires) lines.push(`| ${wire.id} | ${wires[wire.id]?.colourCode === undefined ? '— (unclassified)' : `\`${wires[wire.id]?.colourCode}\``} |`);

  lines.push('', '## Instance roles → slots', '', 'Kept in `data/tags/instance-slots.json`; design files are never rewritten by the tagger.', '');
  lines.push('| Role string | Kind | Instances | Slot |', '|---|---|---:|---|');
  for (const [role, r] of [...roleSlots].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${esc(role)} | ${r.kind} | ${r.count} | ${r.slot === undefined ? '— (unclassified)' : `\`${r.slot}\``} |`);
  }

  const reviewed = [
    ...Object.entries(review.connectors ?? {}).flatMap(([d, pins]) => Object.entries(pins).map(([t, f]) => `connector ${d} pin ${t}: ${show(f.signal ?? undefined)} — ${f.why}`)),
    ...Object.entries(review.pcbas ?? {}).flatMap(([d, ts]) => Object.entries(ts).map(([t, f]) => `board ${d} pad ${t}: role ${f.role === undefined ? '(proposal)' : show(f.role ?? undefined)}, signal ${f.signal === undefined ? '(proposal)' : show(f.signal ?? undefined)} — ${f.why}`)),
    ...Object.entries(review.wires ?? {}).map(([d, f]) => `stock ${d}: ${show(f.colourCode ?? undefined)} — ${f.why}`),
    ...Object.entries(review.slots ?? {}).map(([r, f]) => `role "${r}": ${show(f.slot ?? undefined)} — ${f.why}`),
  ];
  lines.push('', '## Owner corrections applied (`data/tags/review.json`)', '');
  if (reviewed.length === 0) lines.push('None.');
  else for (const r of reviewed) lines.push(`- ${esc(r)}`);

  // every tag must name a vocab entry; the validator checks, this keeps the report honest
  const signals = new Set(((vocab['signals']?.entries ?? []) as SignalEntry[]).map((e) => e.id));
  const unknown = [
    ...Object.values(connectors).flatMap((pins) => Object.values(pins).flatMap(signalIds)),
    ...Object.values(pcbas).flatMap((ts) => Object.values(ts).flatMap((t) => (t.signal === undefined ? [] : signalIds(t.signal)))),
  ].filter((id) => !signals.has(id));
  if (unknown.length > 0) lines.push('', `**Unknown signal ids proposed:** ${[...new Set(unknown)].join(', ')}`);
  lines.push('');

  return {
    tags: { src: TAGS_SRC, connectors, pcbas, wires },
    slots: { src: SLOTS_SRC, designs },
    report: lines.join('\n'),
    stats: {
      unclassifiedPins: unclassifiedPins.length,
      unclassifiedTerminals: unclassifiedPads.length,
      unclassifiedWires: unclassifiedWires.length,
      unslottedRoles: unslotted.length,
      unclassifiedUsed: usedUnclassified,
      conflicts: conflicts.length,
    },
  };
}
