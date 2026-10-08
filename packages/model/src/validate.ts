/**
 * Terminal resolution and validation.
 *
 * Nothing here throws on bad data: every problem comes back as a typed
 * `Issue`. `resolveTerminal` is the foundation every derived view uses.
 */

import { humanizeIssue, terminalName } from './names.ts';
import { designElectricalProblems, electricalIssues } from './electrical.ts';
import {
  findComponent,
  findConnector,
  findMechanical,
  findPcba,
  findWire,
  DESIGN_STATUSES,
  LAY_ARRANGEMENT_RING_COUNT,
  pigtailIdOf,
  pigtailTerminal,
  type CableDesign,
  type ConnectorPin,
  type Db,
  type Element,
  type InstanceKind,
  type Issue,
  type PcbaDefinition,
  type Pigtail,
  type TerminalRef,
  type WireDefinition,
} from './model.ts';
import { compatibilityIssues } from './compat.ts';
import { cavityIssues, terminationDbIssues } from './crimp.ts';
import { pnDuplicateIssues } from './part-number-health.ts';
import { benchRuleProblems } from './bench-types.ts';
import { ruleIssuesForDesign, ruleIssuesForLibrary } from './rules.ts';
import type { PartNumberScheme } from './part-numbers.ts';
import { breakoutFates, breakoutIssues, inScope, segmentElectricalPaths } from './breakouts.ts';
import { viaText } from './link-elements.ts';
import { parseSubassemblyPortId, placedDesign, portsOfSubassembly, subassemblyIssues, type SubassemblyPort } from './subassemblies.ts';
import { recordMetaIssues } from './provenance.ts';
import { validateVocab, vocabEntry, vocabReferenceIssues } from './vocab.ts';
import { validateInterfaces } from './interfaces.ts';
import { validateKits } from './kits.ts';
import { deviceLibraryIssues } from './devices.ts';
import { recipeIssues } from './cable-recipe.ts';
import { productIssues, routeIssues, sourcingShapeIssues } from './products.ts';
import {
  bondedSetOf,
  isFullyBonded,
  isScreenPath,
  pigtailKey,
  pigtailMembers,
  pigtailsAt,
  screenPaths,
  screenTerminations,
} from './bonds.ts';
import {
  duplicateSiblingIds,
  electricalPaths,
  elementPaths,
  isElectricalElement,
  resolveElementPath,
} from './paths.ts';

/* ------------------------------------------------------------------ *
 * Terminal keys
 * ------------------------------------------------------------------ */

/**
 * Canonical, stable string form of a terminal reference:
 * `w1:core-red.center@a`, `j1:6`, `u1:scart.15`.
 */
export function terminalKey(ref: TerminalRef): string {
  return ref.end === undefined
    ? `${ref.instance}:${ref.terminal}`
    : `${ref.instance}:${ref.terminal}@${ref.end}`;
}

/** Inverse of `terminalKey`. */
export function parseTerminalKey(key: string): TerminalRef {
  const colon = key.indexOf(':');
  const instance = key.slice(0, colon);
  let rest = key.slice(colon + 1);
  let end: 'a' | 'b' | undefined;
  if (rest.endsWith('@a')) {
    end = 'a';
    rest = rest.slice(0, -2);
  } else if (rest.endsWith('@b')) {
    end = 'b';
    rest = rest.slice(0, -2);
  }
  return end === undefined
    ? { instance, terminal: rest }
    : { instance, terminal: rest, end };
}

/* ------------------------------------------------------------------ *
 * resolveTerminal
 * ------------------------------------------------------------------ */

export interface ResolvedTerminal {
  key: string;
  instance: string;
  instanceKind: InstanceKind;
  /** definition id of the instance */
  def: string;
  terminal: string;
  end?: 'a' | 'b';
  label?: string;
  /** the definition's own note about this pin/pad, when it has one */
  note?: string;
  /** wire element, when the instance is a segment and the terminal an element path */
  element?: Element;
  /** the pigtail, when the terminal is a segment's `pigtail:<id>` */
  pigtail?: Pigtail;
  /** the port, when the instance is a sub-assembly and its design could be opened (`subassemblies.ts`) */
  port?: SubassemblyPort;
}

export type ResolveResult =
  | { ok: true; terminal: ResolvedTerminal }
  | { ok: false; issues: Issue[] };

function issue(
  code: string,
  message: string,
  where: string,
  severity: 'error' | 'warning' = 'error',
): Issue {
  return { code, severity, message, where };
}

/* ------------------------------------------------------------------ *
 * Instance lookup
 * ------------------------------------------------------------------ */

/**
 * One instance of a design, flattened out of the four `instances` categories.
 * `kind` is the category it was found in; `def` is the definition it names.
 */
export interface DesignInstanceRef {
  id: string;
  kind: InstanceKind;
  def: string;
}

/**
 * Every instance of a design in one list — connectors, then segments, then
 * components, then PCBAs, each in declaration order.
 *
 * The categories are a storage detail of the design document; anything that
 * asks "what is in this design?" or "what kind of thing is `w2`?" wants this
 * flat view, and should not have to know that the answer lives in four arrays.
 */
export function designInstances(design: CableDesign): DesignInstanceRef[] {
  return [
    ...design.instances.connectors.map((i) => ({
      id: i.id,
      kind: 'connector' as const,
      def: i.def,
    })),
    ...design.instances.segments.map((i) => ({
      id: i.id,
      kind: 'segment' as const,
      def: i.def,
    })),
    ...design.instances.components.map((i) => ({
      id: i.id,
      kind: 'component' as const,
      def: i.def,
    })),
    ...design.instances.pcbas.map((i) => ({
      id: i.id,
      kind: 'pcba' as const,
      def: i.def,
    })),
    ...(design.instances.subassemblies ?? []).map((i) => ({
      id: i.id,
      kind: 'subassembly' as const,
      def: i.def,
    })),
  ];
}

/**
 * The instance with this id, whatever category it is declared in, or
 * `undefined`. A design with a duplicate id across categories is invalid
 * (`validateDesign` reports `duplicate-instance-id`); this returns the first
 * match in `designInstances` order so callers stay deterministic meanwhile.
 */
export function findInstance(
  design: CableDesign,
  id: string,
): DesignInstanceRef | undefined {
  return designInstances(design).find((instance) => instance.id === id);
}

/** Terminal ids a PCBA exposes: its own pads plus integrated-connector pins. */
export function pcbaTerminalIds(pcba: PcbaDefinition, db: Db): string[] {
  const ids = pcba.terminals.map((t) => t.id);
  for (const integrated of pcba.integratedConnectors ?? []) {
    const connector = findConnector(db, integrated.connectorDefId);
    if (connector === undefined) continue;
    for (const pin of connector.pins) {
      ids.push(`${integrated.terminalPrefix}.${pin.id}`);
    }
  }
  return ids;
}

/**
 * The connector pin behind a PCBA terminal id like `scart.15`, when the board
 * declares an integrated connector with that prefix.
 */
function integratedPin(
  pcba: PcbaDefinition,
  db: Db,
  terminal: string,
): ConnectorPin | undefined {
  for (const integrated of pcba.integratedConnectors ?? []) {
    const prefix = `${integrated.terminalPrefix}.`;
    if (!terminal.startsWith(prefix)) continue;
    const connector = findConnector(db, integrated.connectorDefId);
    const pin = connector?.pins.find((p) => p.id === terminal.slice(prefix.length));
    if (pin !== undefined) return pin;
  }
  return undefined;
}

/**
 * Every terminal an instance exposes, whatever kind of instance it is, in the
 * order its definition declares them:
 *
 * - **connector** — one entry per pin;
 * - **segment** — one entry per *electrical* element path at end `a`, then the
 *   same paths at end `b` (a segment terminal is only a terminal with an end);
 *   each end's pigtails (`pigtail:<id>`) follow that end's element paths;
 * - **component** — one entry per terminal;
 * - **PCBA** — its own pads, then the pins of each integrated connector, named
 *   `prefix.pin` exactly as `pcbaTerminalIds` names them.
 *
 * This is the general form of `pcbaTerminalIds`, and the answer to "which of
 * this instance's terminals does the design actually use?" — intersect the
 * result with the terminals the joints land on.
 *
 * An unknown instance, or one whose definition is missing from `db`, yields an
 * empty list: enumeration reports nothing rather than failing, because
 * `validateDesign` is what reports the broken reference.
 */
export function terminalsOf(
  design: CableDesign,
  db: Db,
  instanceId: string,
): ResolvedTerminal[] {
  const instance = findInstance(design, instanceId);
  if (instance === undefined) return [];

  const refs: TerminalRef[] = [];
  switch (instance.kind) {
    case 'connector': {
      const connector = findConnector(db, instance.def);
      for (const pin of connector?.pins ?? []) {
        refs.push({ instance: instanceId, terminal: pin.id });
      }
      break;
    }
    case 'segment': {
      const segment = design.instances.segments.find((s) => s.id === instanceId);
      const wire = findWire(db, instance.def);
      const paths = wire === undefined ? [] : segmentElectricalPaths(wire, segment);
      for (const end of ['a', 'b'] as const) {
        for (const path of paths) {
          refs.push({ instance: instanceId, terminal: path, end });
        }
        for (const pigtail of segment === undefined ? [] : pigtailsAt(segment, end)) {
          refs.push({ instance: instanceId, terminal: pigtailTerminal(pigtail.id), end });
        }
      }
      break;
    }
    case 'component': {
      const component = findComponent(db, instance.def);
      for (const terminal of component?.terminals ?? []) {
        refs.push({ instance: instanceId, terminal: terminal.id });
      }
      break;
    }
    case 'pcba': {
      const pcba = findPcba(db, instance.def);
      const ids = pcba === undefined ? [] : pcbaTerminalIds(pcba, db);
      for (const id of ids) refs.push({ instance: instanceId, terminal: id });
      break;
    }
    case 'subassembly': {
      for (const port of portsOfSubassembly(design, db, instanceId) ?? []) refs.push({ instance: instanceId, terminal: port.id });
      break;
    }
  }

  const out: ResolvedTerminal[] = [];
  for (const ref of refs) {
    const result = resolveTerminal(design, db, ref);
    if (result.ok) out.push(result.terminal);
  }
  return out;
}

/**
 * Validate and resolve a TerminalRef against a design and the definition db.
 */
export function resolveTerminal(
  design: CableDesign,
  db: Db,
  ref: TerminalRef,
): ResolveResult {
  const where = terminalKey(ref);
  const instance = findInstance(design, ref.instance);
  if (instance === undefined) {
    return {
      ok: false,
      issues: [
        issue('unknown-instance', `unknown instance '${ref.instance}'`, where),
      ],
    };
  }

  const { kind, def } = instance;

  if (kind === 'segment' && ref.end === undefined) {
    return {
      ok: false,
      issues: [
        issue(
          'missing-end',
          `terminal ref to segment '${ref.instance}' must name end 'a' or 'b'`,
          where,
        ),
      ],
    };
  }
  if (kind !== 'segment' && ref.end !== undefined) {
    return {
      ok: false,
      issues: [
        issue(
          'unexpected-end',
          `terminal ref to ${kind} '${ref.instance}' must not name an end`,
          where,
        ),
      ],
    };
  }

  const resolved: ResolvedTerminal = {
    key: where,
    instance: ref.instance,
    instanceKind: kind,
    def,
    terminal: ref.terminal,
    ...(ref.end === undefined ? {} : { end: ref.end }),
  };

  switch (kind) {
    case 'connector': {
      const connector = findConnector(db, def);
      if (connector === undefined) {
        return {
          ok: false,
          issues: [
            issue('unknown-def', `unknown connector definition '${def}'`, where),
          ],
        };
      }
      const pin = connector.pins.find((p) => p.id === ref.terminal);
      if (pin === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              'unknown-terminal',
              `connector '${connector.id}' has no pin '${ref.terminal}'`,
              where,
            ),
          ],
        };
      }
      return {
        ok: true,
        terminal: {
          ...resolved,
          label: pin.label,
          ...(pin.note === undefined ? {} : { note: pin.note }),
        },
      };
    }
    case 'segment': {
      const wire = findWire(db, def);
      if (wire === undefined) {
        return {
          ok: false,
          issues: [
            issue('unknown-def', `unknown wire definition '${def}'`, where),
          ],
        };
      }
      const pigtailId = pigtailIdOf(ref.terminal);
      if (pigtailId !== undefined) {
        const segment = design.instances.segments.find((s) => s.id === ref.instance);
        const pigtail = (segment?.pigtails ?? []).find(
          (p) => p.id === pigtailId && p.end === ref.end,
        );
        if (pigtail === undefined) {
          return {
            ok: false,
            issues: [
              issue(
                'unknown-pigtail',
                `segment '${ref.instance}' has no pigtail '${pigtailId}' at end '${ref.end ?? ''}'`,
                where,
              ),
            ],
          };
        }
        return { ok: true, terminal: { ...resolved, pigtail, label: `pigtail ${pigtail.id}` } };
      }
      const element = resolveElementPath(wire.structure, ref.terminal);
      if (element === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              'unknown-element-path',
              `wire '${wire.id}' has no element at path '${ref.terminal}'`,
              where,
            ),
          ],
        };
      }
      if (!isElectricalElement(element)) {
        return {
          ok: false,
          issues: [
            issue(
              'terminal-not-electrical',
              `element '${ref.terminal}' of wire '${wire.id}' is a ${element.kind} and has no terminals`,
              where,
            ),
          ],
        };
      }
      const scoped = design.instances.segments.find((s) => s.id === ref.instance);
      if (!inScope(scoped, ref.terminal)) {
        return {
          ok: false,
          issues: [
            issue(
              'terminal-out-of-scope',
              `segment '${ref.instance}' carries only ${scoped?.scope?.join(', ') ?? ''} of '${wire.id}', not '${ref.terminal}'`,
              where,
            ),
          ],
        };
      }
      return {
        ok: true,
        terminal: {
          ...resolved,
          element,
          ...(element.label === undefined ? {} : { label: element.label }),
        },
      };
    }
    case 'component': {
      const component = findComponent(db, def);
      if (component === undefined) {
        return {
          ok: false,
          issues: [
            issue('unknown-def', `unknown component definition '${def}'`, where),
          ],
        };
      }
      const terminal = component.terminals.find((t) => t.id === ref.terminal);
      if (terminal === undefined) {
        return {
          ok: false,
          issues: [
            issue(
              'unknown-terminal',
              `component '${component.id}' has no terminal '${ref.terminal}'`,
              where,
            ),
          ],
        };
      }
      return {
        ok: true,
        terminal: {
          ...resolved,
          ...(terminal.label === undefined ? {} : { label: terminal.label }),
        },
      };
    }
    case 'pcba': {
      const pcba = findPcba(db, def);
      if (pcba === undefined) {
        return {
          ok: false,
          issues: [
            issue('unknown-def', `unknown PCBA definition '${def}'`, where),
          ],
        };
      }
      if (!pcbaTerminalIds(pcba, db).includes(ref.terminal)) {
        return {
          ok: false,
          issues: [
            issue(
              'unknown-terminal',
              `PCBA '${pcba.id}' has no terminal '${ref.terminal}'`,
              where,
            ),
          ],
        };
      }
      // an own pad describes itself; an integrated-connector pin borrows the
      // label and note of the pin it *is*, on the connector the board carries
      const own = pcba.terminals.find((t) => t.id === ref.terminal);
      const borrowed = own === undefined ? integratedPin(pcba, db, ref.terminal) : undefined;
      const label = own?.label ?? borrowed?.label;
      const note = own?.note ?? borrowed?.note;
      return {
        ok: true,
        terminal: {
          ...resolved,
          ...(label === undefined ? {} : { label }),
          ...(note === undefined ? {} : { note }),
        },
      };
    }
    case 'subassembly': {
      if (parseSubassemblyPortId(ref.terminal) === undefined) {
        return {
          ok: false,
          issues: [issue('subassembly-unknown-port', `'${ref.terminal}' is not a port id (\`j1:3\`, \`w1@b:red\`) of sub-assembly '${ref.instance}'`, where)],
        };
      }
      const ports = portsOfSubassembly(design, db, ref.instance);
      // no library, or a placed design that cannot be opened (reported on the
      // instance): the port stands unverified
      if (ports === undefined) return { ok: true, terminal: { ...resolved, label: ref.terminal } };
      const port = ports.find((p) => p.id === ref.terminal);
      if (port === undefined) {
        const sub = (design.instances.subassemblies ?? []).find((s) => s.id === ref.instance);
        const opened = sub === undefined ? undefined : placedDesign(db, sub);
        const which = sub?.rev === undefined ? 'its working copy' : `Rev ${sub.rev}`;
        return {
          ok: false,
          issues: [
            issue(
              'subassembly-unknown-port',
              `sub-assembly '${ref.instance}' (design '${def}', ${which}) has no free end '${ref.terminal}'${opened?.ok === true ? ' — the placed design changed, or that end is connected inside it' : ''}`,
              where,
            ),
          ],
        };
      }
      return { ok: true, terminal: { ...resolved, label: `${port.groupLabel} ${port.label}`, port } };
    }
  }
}

/* ------------------------------------------------------------------ *
 * validateDb
 * ------------------------------------------------------------------ */

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

/**
 * Check a stock's declared lay order against its own element tree: every
 * member has to name an element that actually exists, no core may be laid
 * twice, and the arrangement has to agree with how many ring cores are named.
 */
export function validateWireLayOrder(wire: WireDefinition): Issue[] {
  const layOrder = wire.layOrder;
  if (layOrder === undefined) return [];
  const where = `wires/${wire.id}`;
  const issues: Issue[] = [];

  const members = [
    ...layOrder.ring,
    ...(layOrder.center === undefined ? [] : [layOrder.center]),
    ...(layOrder.inner ?? []),
  ];
  for (const path of members) {
    if (resolveElementPath(wire.structure, path) === undefined) {
      issues.push(
        issue(
          'unknown-lay-order-element',
          `wire '${wire.id}' lay order names '${path}', which is not an element of the stock`,
          where,
        ),
      );
    }
  }
  for (const path of duplicateIds(members)) {
    issues.push(
      issue(
        'duplicate-lay-order-element',
        `wire '${wire.id}' lay order names '${path}' more than once`,
        where,
      ),
    );
  }
  const expected = LAY_ARRANGEMENT_RING_COUNT[layOrder.arrangement];
  if (layOrder.ring.length !== expected) {
    issues.push(
      issue(
        'lay-order-arrangement-mismatch',
        `wire '${wire.id}' lay order is '${layOrder.arrangement}' but names ${layOrder.ring.length} ring core(s), not ${expected}`,
        where,
      ),
    );
  }
  if (!layOrder.src) {
    issues.push(
      issue(
        'missing-src',
        `record '${where}/layOrder' has no src citation`,
        `${where}/layOrder`,
        'warning',
      ),
    );
  }
  return issues;
}

/** Structural validation of the definition library. */
export function validateDb(db: Db, options: { scheme?: PartNumberScheme } = {}): Issue[] {
  const issues: Issue[] = [];
  // the same number on two different parts (a connector and its own body are one part)
  issues.push(...pnDuplicateIssues(db, options.scheme));

  const groups: { label: string; ids: string[] }[] = [
    { label: 'connectors', ids: db.connectors.map((r) => r.id) },
    { label: 'wires', ids: db.wires.map((r) => r.id) },
    { label: 'components', ids: db.components.map((r) => r.id) },
    { label: 'pcbas', ids: db.pcbas.map((r) => r.id) },
    { label: 'mechanicals', ids: (db.mechanicals ?? []).map((r) => r.id) },
  ];
  for (const group of groups) {
    for (const id of duplicateIds(group.ids)) {
      issues.push(
        issue('duplicate-id', `duplicate ${group.label} id '${id}'`, `${group.label}/${id}`),
      );
    }
  }
  // ids must also be unique across the whole library
  for (const id of duplicateIds(groups.flatMap((g) => g.ids))) {
    issues.push(
      issue('duplicate-id', `definition id '${id}' is used more than once`, id),
    );
  }

  const missingSrc = (where: string): Issue =>
    issue('missing-src', `record '${where}' has no src citation`, where, 'warning');

  for (const connector of db.connectors) {
    if (!connector.src) issues.push(missingSrc(`connectors/${connector.id}`));
    issues.push(...recordMetaIssues(connector, `connectors/${connector.id}`));
    for (const id of duplicateIds(connector.pins.map((p) => p.id))) {
      issues.push(
        issue(
          'duplicate-terminal-id',
          `connector '${connector.id}' has duplicate pin '${id}'`,
          `connectors/${connector.id}`,
        ),
      );
    }
  }

  for (const component of db.components) {
    if (!component.src) issues.push(missingSrc(`components/${component.id}`));
    issues.push(...recordMetaIssues(component, `components/${component.id}`));
    for (const id of duplicateIds(component.terminals.map((t) => t.id))) {
      issues.push(
        issue(
          'duplicate-terminal-id',
          `component '${component.id}' has duplicate terminal '${id}'`,
          `components/${component.id}`,
        ),
      );
    }
  }

  for (const wire of db.wires) {
    const where = `wires/${wire.id}`;
    if (!wire.src) issues.push(missingSrc(where));
    issues.push(...recordMetaIssues(wire, where));
    for (const dupe of duplicateSiblingIds(wire.structure)) {
      issues.push(
        issue(
          'duplicate-sibling-element-id',
          `wire '${wire.id}' has duplicate element id '${dupe.id}' inside '${dupe.parentPath || wire.structure.id}'`,
          where,
        ),
      );
    }
    for (const entry of elementPaths(wire.structure)) {
      if (entry.element.id === '' || entry.element.id === undefined) {
        issues.push(
          issue(
            'missing-element-id',
            `wire '${wire.id}' has an element without an id inside '${entry.parentPath || wire.structure.id}'`,
            where,
          ),
        );
      }
    }
    issues.push(...validateWireLayOrder(wire));
    const inSets = new Map<string, number>();
    (wire.bonded ?? []).forEach((set, index) => {
      if (!set.src) issues.push(missingSrc(`${where}/bonded[${index}]`));
      for (const path of set.members) {
        if (!isScreenPath(wire, path)) {
          issues.push(
            issue(
              'bonded-member-not-screen',
              `wire '${wire.id}' bonded set ${index} names '${path}', which is not a shield or bare conductor of the stock`,
              where,
            ),
          );
        }
        inSets.set(path, (inSets.get(path) ?? 0) + 1);
      }
    });
    for (const [path, count] of inSets) {
      if (count > 1) {
        issues.push(
          issue(
            'bonded-member-not-screen',
            `wire '${wire.id}' names screen '${path}' in ${count} bonded sets — a screen is in one mass at most`,
            where,
          ),
        );
      }
    }
  }

  for (const pcba of db.pcbas) {
    const where = `pcbas/${pcba.id}`;
    if (!pcba.src) issues.push(missingSrc(where));
    issues.push(...recordMetaIssues(pcba, where));
    for (const id of duplicateIds(pcba.terminals.map((t) => t.id))) {
      issues.push(
        issue(
          'duplicate-terminal-id',
          `PCBA '${pcba.id}' has duplicate terminal '${id}'`,
          where,
        ),
      );
    }
    for (const integrated of pcba.integratedConnectors ?? []) {
      if (findConnector(db, integrated.connectorDefId) === undefined) {
        issues.push(
          issue(
            'unknown-connector-def',
            `PCBA '${pcba.id}' integrates unknown connector definition '${integrated.connectorDefId}'`,
            where,
          ),
        );
      }
    }
    const known = pcbaTerminalIds(pcba, db);
    for (const link of pcba.internalLinks) {
      for (const endpoint of [link.from, link.to]) {
        if (!known.includes(endpoint)) {
          issues.push(
            issue(
              'unknown-pcba-terminal',
              `PCBA '${pcba.id}' internal link references unknown terminal '${endpoint}'`,
              where,
            ),
          );
        }
      }
      // structured elements must spell the prose exactly (6n6.7): documents
      // print `via`, the trace and the drawing read the elements
      if (link.via !== undefined && link.elements !== undefined && viaText(link.elements) !== link.via) {
        issues.push(
          issue(
            'link-elements-via-mismatch',
            `PCBA '${pcba.id}' link ${link.from} → ${link.to}: elements spell '${viaText(link.elements)}', via is '${link.via}'`,
            where,
          ),
        );
      }
    }
  }

  for (const mechanical of db.mechanicals ?? []) {
    if (!mechanical.src) issues.push(missingSrc(`mechanicals/${mechanical.id}`));
    issues.push(...recordMetaIssues(mechanical, `mechanicals/${mechanical.id}`));
  }

  // the controlled vocabularies and every tag that points into them (data
  // model v2 §5: `vocab-unknown` is an error, `vocab-deprecated` a warning)
  if (db.vocab !== undefined) issues.push(...validateVocab(db.vocab), ...vocabReferenceIssues(db));

  // connector bodies and interfaces (data model v2 §1.2)
  issues.push(...validateInterfaces(db));
  issues.push(...validateKits(db));
  // crimp contacts, seals, plugs and tools (`crimp.ts`)
  issues.push(...terminationDbIssues(db));
  // declarative validation rules over the library, and rules that cannot be used (`rules.ts`)
  issues.push(...ruleIssuesForLibrary(db));
  // the shop's work instructions as data: a rule that cannot be printed is a warning, never an error (`bench-types.ts`)
  for (const problem of benchRuleProblems(Array.isArray(db.benchRules) ? db.benchRules : [], 'bench-rules.json')) {
    issues.push({ code: 'bench-rule-invalid', severity: 'warning', message: problem, where: 'bench-rules' });
  }

  // devices, conditioning recipes, hazards and the ranking policy (`devices.ts`)
  issues.push(...deviceLibraryIssues(db));
  // routes: a bought-in part names a supplier, a contract-made one its maker (`products.ts`)
  const sourced: [string, readonly (Parameters<typeof routeIssues>[0] & { id: string })[]][] = [
    ['connectors', db.connectors],
    ['wires', db.wires],
    ['components', db.components],
    ['pcbas', db.pcbas],
    ['mechanicals', db.mechanicals ?? []],
    ['kits', (db.kits ?? []).map((k) => ({ ...k, id: k.id ?? k.sku }))],
  ];
  for (const [group, list] of sourced) for (const r of list) issues.push(...routeIssues(r, `${group}/${r.id}`));
  // product families: their own structure (the designs they name are checked with the designs, `productIssues`)
  issues.push(...productIssues(db.products ?? []));
  return issues;
}

/* ------------------------------------------------------------------ *
 * validateDesign
 * ------------------------------------------------------------------ */

/**
 * Index into `design.notes` of the first note that names this terminal, e.g.
 * the note saying `w1 drain @b is deliberately cut`, or `undefined` when no
 * note does. Whitespace and the instance/terminal separator are ignored, so
 * `w1:drain@b`, `w1.drain@b` and `w1 drain @b` all match.
 *
 * The index is **0-based** — it indexes the array. Turning it into a printed
 * footnote number is the job of whatever draws the notes.
 */
export function noteIndexReferencingTerminal(
  design: CableDesign,
  ref: TerminalRef,
): number | undefined {
  const candidates = [
    `${ref.instance}:${ref.terminal}`,
    `${ref.instance}.${ref.terminal}`,
    `${ref.instance}${ref.terminal}`,
  ]
    .map((base) => (ref.end === undefined ? base : `${base}@${ref.end}`))
    .map((candidate) => candidate.toLowerCase());
  const notes = design.notes ?? [];
  for (let index = 0; index < notes.length; index += 1) {
    const note = (notes[index] ?? '').toLowerCase().replace(/\s+/g, '');
    if (candidates.some((candidate) => note.includes(candidate))) return index;
  }
  return undefined;
}

/**
 * True when one of the design notes names this terminal. The boolean form of
 * `noteIndexReferencingTerminal`, and defined in terms of it so the two can
 * never disagree about what "names this terminal" means.
 */
export function noteReferencesTerminal(
  design: CableDesign,
  ref: TerminalRef,
): boolean {
  return noteIndexReferencingTerminal(design, ref) !== undefined;
}

/**
 * Structural validation of a design against the definition db, plus the
 * physical compatibility rules of `compat.ts` (`compatibilityIssues`) —
 * folded in as warnings so every consumer of
 * `validateDesign` (render-svg's `<desc>`, the docs build sheet, the editor's
 * Issues panel) sees them without a second call. Every catalog design is
 * expected to be both error- and warning-free; a design that trips a
 * compatibility rule is a real modelling problem to fix, not something to
 * silence here.
 */
export function validateDesign(design: CableDesign, db: Db): Issue[] {
  return rawDesignIssues(design, db).map((item) => humanizeIssue(design, db, item));
}

function rawDesignIssues(design: CableDesign, db: Db): Issue[] {
  const issues: Issue[] = [];

  // production status: absent means active; anything else must be a known status
  const status: unknown = (design as { status?: unknown }).status;
  if (
    status !== undefined &&
    !(DESIGN_STATUSES as readonly unknown[]).includes(status)
  ) {
    issues.push(
      issue(
        'invalid-status',
        `design status '${String(status)}' is not one of ${DESIGN_STATUSES.join(', ')}`,
        'status',
      ),
    );
  }

  const tags: unknown = (design as { tags?: unknown }).tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.length <= 50 && tags.every((t) => typeof t === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,39}$/.test(t)))) {
    issues.push(issue('invalid-tags', 'tags must be a list of short words (letters, digits, spaces, dash, dot, slash)', 'tags'));
  }

  const labour: unknown = (design as { labourMinutes?: unknown }).labourMinutes;
  if (labour !== undefined && !(typeof labour === 'number' && Number.isFinite(labour) && labour >= 0)) {
    issues.push(issue('invalid-labour', 'labourMinutes must be a number of minutes, zero or more', 'labourMinutes'));
  }

  for (const p of designElectricalProblems(design, db)) issues.push(issue('invalid-electrical', p.message, p.path));

  // module-owned data (`extensions`): an object keyed by module id; the base never looks inside
  const extensions: unknown = (design as { extensions?: unknown }).extensions;
  if (extensions !== undefined && (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions))) {
    issues.push(issue('invalid-extensions', 'extensions must be an object keyed by module id', 'extensions'));
  }

  // duplicate instance ids, across every instance category (mechanical
  // instances share the same id namespace even though they sit outside
  // designInstances()/InstanceKind — attachedTo and BOM provenance both
  // address them by plain instance id)
  const instanceIds = [
    ...design.instances.connectors.map((i) => i.id),
    ...design.instances.segments.map((i) => i.id),
    ...design.instances.components.map((i) => i.id),
    ...design.instances.pcbas.map((i) => i.id),
    ...(design.instances.mechanical ?? []).map((i) => i.id),
    ...(design.instances.breakouts ?? []).map((i) => i.id),
    ...(design.instances.subassemblies ?? []).map((i) => i.id),
  ];
  for (const id of duplicateIds(instanceIds)) {
    issues.push(
      issue('duplicate-instance-id', `duplicate instance id '${id}'`, id),
    );
  }

  // unknown definition references
  for (const instance of design.instances.connectors) {
    if (findConnector(db, instance.def) === undefined) {
      issues.push(
        issue(
          'unknown-def',
          `connector instance '${instance.id}' references unknown connector definition '${instance.def}'`,
          instance.id,
        ),
      );
    }
    // stored mounting override must name a
    // `connector-mountings` entry — most instances derive it instead
    // (`connectorMountingOfInstance`) and store nothing
    if (instance.mounting !== undefined && db.vocab?.['connector-mountings'] !== undefined) {
      if (vocabEntry(db.vocab, 'connector-mountings', instance.mounting, { includePending: true }) === undefined) {
        issues.push(
          issue(
            'vocab-unknown',
            `connector instance '${instance.id}' has mounting '${instance.mounting}', which is not in the 'connector-mountings' list`,
            instance.id,
            'warning',
          ),
        );
      }
    }
  }
  for (const instance of design.instances.segments) {
    if (findWire(db, instance.def) === undefined) {
      issues.push(
        issue(
          'unknown-def',
          `segment instance '${instance.id}' references unknown wire definition '${instance.def}'`,
          instance.id,
        ),
      );
    }
  }
  // marker text (labels): bounded, and a core label names a conductor of the stock
  for (const instance of design.instances.segments) {
    for (const end of ['a', 'b'] as const) {
      const lines = instance.endLabels?.[end] ?? [];
      if (lines.length > 3 || lines.some((l) => l.length > 40)) {
        issues.push(issue('label-too-long', `the end ${end.toUpperCase()} label of segment '${instance.id}' is more than 3 lines or has a line over 40 characters`, instance.id, 'warning'));
      }
    }
    const wire = findWire(db, instance.def);
    if (wire === undefined) continue;
    for (const path of Object.keys(instance.coreLabels ?? {})) {
      const element = resolveElementPath(wire.structure, path);
      if (element === undefined || element.kind !== 'conductor') {
        issues.push(issue('label-unknown-core', `segment '${instance.id}' has a label for '${path}', which is not a conductor of '${wire.id}'`, instance.id, 'warning'));
      }
    }
  }
  for (const instance of design.instances.components) {
    if (findComponent(db, instance.def) === undefined) {
      issues.push(
        issue(
          'unknown-def',
          `component instance '${instance.id}' references unknown component definition '${instance.def}'`,
          instance.id,
        ),
      );
    }
  }
  for (const instance of design.instances.pcbas) {
    if (findPcba(db, instance.def) === undefined) {
      issues.push(
        issue(
          'unknown-def',
          `PCBA instance '${instance.id}' references unknown PCBA definition '${instance.def}'`,
          instance.id,
        ),
      );
    }
  }
  for (const instance of design.instances.mechanical ?? []) {
    if (findMechanical(db, instance.def) === undefined) {
      issues.push(
        issue(
          'unknown-def',
          `mechanical instance '${instance.id}' references unknown mechanical definition '${instance.def}'`,
          instance.id,
        ),
      );
    }
    if (!Number.isInteger(instance.qty) || instance.qty <= 0) {
      issues.push(
        issue(
          'invalid-quantity',
          `mechanical instance '${instance.id}' has qty ${instance.qty}, which is not a positive integer`,
          instance.id,
        ),
      );
    }
    if (instance.attachedTo !== undefined) {
      const attachedIsInstance = findInstance(design, instance.attachedTo) !== undefined;
      const attachedIsMechanical = (design.instances.mechanical ?? []).some(
        (m) => m.id === instance.attachedTo,
      );
      if (!attachedIsInstance && !attachedIsMechanical) {
        issues.push(
          issue(
            'unknown-attached-instance',
            `mechanical instance '${instance.id}' is attached to unknown instance '${instance.attachedTo}'`,
            instance.id,
          ),
        );
      }
    }
  }

  // joints
  design.joints.forEach((joint, index) => {
    const where = `joints[${index}]`;
    const a = resolveTerminal(design, db, joint.a);
    const b = resolveTerminal(design, db, joint.b);
    const through = joint.through === undefined ? undefined : resolveTerminal(design, db, joint.through);
    for (const result of through === undefined ? [a, b] : [a, b, through]) {
      if (!result.ok) {
        for (const item of result.issues) {
          issues.push({ ...item, where: `${where} ${item.where ?? ''}`.trim() });
        }
      }
    }
    if (terminalKey(joint.a) === terminalKey(joint.b)) {
      issues.push(
        issue(
          'self-joint',
          `joint connects '${terminalKey(joint.a)}' to itself`,
          where,
        ),
      );
    }
    // the hole a joint is made through sits on a third part (a carrier board)
    if (joint.through !== undefined && (joint.through.instance === joint.a.instance || joint.through.instance === joint.b.instance)) {
      issues.push(
        issue(
          'through-invalid',
          `joint ${terminalKey(joint.a)} -- ${terminalKey(joint.b)} is made through '${terminalKey(joint.through)}', a terminal of one of its own ends`,
          where,
        ),
      );
    }
  });

  // pad qualifiers name a declared pad of a PCBA terminal
  design.joints.forEach((joint, index) => {
    for (const ref of [joint.a, joint.b]) {
      if (ref.pad === undefined) continue;
      const instance = findInstance(design, ref.instance);
      const pcba = instance?.kind === 'pcba' ? findPcba(db, instance.def) : undefined;
      const pads = pcba?.terminals.find((t) => t.id === ref.terminal)?.pads ?? [];
      if (!pads.some((pad) => pad.ref === ref.pad)) {
        issues.push(
          issue(
            'pad-unknown',
            `${terminalKey(ref)} names pad '${ref.pad}', which is not one of that terminal's declared pads${pads.length === 0 ? ' (it declares none)' : ` (${pads.map((p) => p.ref).join(', ')})`}`,
            `joints[${index}]`,
          ),
        );
      }
    }
  });

  issues.push(...pigtailIssues(design, db));
  issues.push(...breakoutIssues(design, db));
  // other designs placed as sub-assemblies (`subassemblies.ts`)
  issues.push(...subassemblyIssues(design, db));
  // a design derived from devices: drift against its recipe (`cable-recipe.ts`)
  issues.push(...recipeIssues(design, db));
  // how it is sourced (`products.ts`): the shape, and what a route asks for
  issues.push(...sourcingShapeIssues(design, 'design'), ...routeIssues(design, `design ${design.id}`));

  // conductor ends soldered at one end and floating at the other; a breakout
  // accounts for its ends: a pass-through continues (connected), an NC end
  // carries its reason (as a note would)
  const fates = breakoutFates(design, db);
  const jointedKeys = new Set<string>();
  for (const joint of design.joints) {
    jointedKeys.add(terminalKey(joint.a));
    jointedKeys.add(terminalKey(joint.b));
  }
  for (const [key, fate] of fates) if (fate.fate === 'through') jointedKeys.add(key);
  const explained = (ref: TerminalRef): boolean => fates.get(terminalKey(ref))?.fate === 'nc' || noteReferencesTerminal(design, ref);
  const terminations = screenTerminations(design, db);
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    for (const path of screenPaths(wire)) {
      if (!inScope(segment, path)) continue;
      // a bonded set floats as one mass: report it once, on its
      // representative — the bare drain when it has one (the mini-coax foil is
      // trimmed back and never landed, so the drain stands for the mass),
      // else its first member
      const set = bondedSetOf(wire, path);
      const drain = set?.members.find((member) => {
        const element = resolveElementPath(wire.structure, member);
        return element?.kind === 'conductor' && element.bare === true;
      });
      if (set !== undefined && (drain ?? set.members[0]) !== path && inScope(segment, drain ?? set.members[0]!)) continue;
      const refA: TerminalRef = { instance: segment.id, terminal: path, end: 'a' };
      const refB: TerminalRef = { ...refA, end: 'b' };
      const hasA = terminations.has(terminalKey(refA));
      const hasB = terminations.has(terminalKey(refB));
      if (hasA === hasB) continue;
      const floating = hasA ? refB : refA;
      // a note about the cut drain explains a drain-and-foil mass floating;
      // on a mass without a drain, the note must name its first member
      if (explained(floating)) continue;
      issues.push(
        issue(
          'screen-floating',
          `${set === undefined ? `screen '${path}'` : `the bonded shield mass (${set.members.join(', ')})`} of segment '${segment.id}' is landed at end ${hasA ? 'A' : 'B'} but not at end ${floating.end?.toUpperCase() ?? ''} — add a design note if this is deliberate`,
          terminalKey(floating),
          'warning',
        ),
      );
    }
    for (const entry of elementPaths(wire.structure)) {
      if (entry.element.kind !== 'conductor' || entry.element.bare === true) continue;
      if (!inScope(segment, entry.path)) continue;
      const refA: TerminalRef = {
        instance: segment.id,
        terminal: entry.path,
        end: 'a',
      };
      const refB: TerminalRef = { ...refA, end: 'b' };
      const hasA = jointedKeys.has(terminalKey(refA));
      const hasB = jointedKeys.has(terminalKey(refB));
      if (!hasA && !hasB) {
        // floating at both ends: a spare, or a joint nobody has drawn yet
        if (explained(refA) || explained(refB)) continue;
        issues.push(
          issue(
            'floating-conductor',
            `${terminalName(design, db, { ...refA, end: undefined })} is not connected at either end — connect it, or note it as a spare`,
            terminalKey(refA),
            'warning',
          ),
        );
        continue;
      }
      if (hasA === hasB) continue;
      const floating = hasA ? refB : refA;
      if (explained(floating)) continue;
      issues.push(
        issue(
          'floating-conductor-end',
          `${terminalName(design, db, { ...refA, end: undefined })} is connected at end ${hasA ? 'A' : 'B'} but floating at end ${floating.end?.toUpperCase() ?? ''} — add a design note if this is deliberate`,
          terminalKey(floating),
          'warning',
        ),
      );
    }
  }

  issues.push(...compatibilityIssues(design, db));
  // contacts, seals and plugs per cavity (`crimp.ts`)
  issues.push(...cavityIssues(design, db));
  // electrical rules: silent unless currents are declared (electrical.ts)
  issues.push(...electricalIssues(design, db));
  // declarative validation rules over this design (`rules.ts`)
  issues.push(...ruleIssuesForDesign(design, db));

  return issues;
}

/**
 * The pigtail rules of `specs/shield-bonding.md` §2.2: members resolve to
 * screens, a screen is twisted into one pigtail per end and is not also
 * jointed on its own there, a pigtail lands exactly once, and a fully bonded
 * stock is landed through pigtails rather than per-shield joints.
 */
function pigtailIssues(design: CableDesign, db: Db): Issue[] {
  const issues: Issue[] = [];
  const landings = new Map<string, number>();
  for (const joint of design.joints) {
    for (const ref of [joint.a, joint.b]) {
      const key = terminalKey(ref);
      landings.set(key, (landings.get(key) ?? 0) + 1);
    }
  }
  for (const segment of design.instances.segments) {
    const wire = findWire(db, segment.def);
    if (wire === undefined) continue;
    const massStock = isFullyBonded(wire);
    for (const end of ['a', 'b'] as const) {
      const pigtails = pigtailsAt(segment, end);
      for (const id of duplicateIds(pigtails.map((p) => p.id))) {
        issues.push(
          issue(
            'duplicate-pigtail-id',
            `segment '${segment.id}' has two pigtails '${id}' at end '${end}'`,
            `${segment.id}@${end}`,
          ),
        );
      }
      const seen = new Map<string, string>();
      for (const pigtail of pigtails) {
        const where = pigtailKey(segment.id, pigtail);
        if (pigtail.members !== undefined && massStock) {
          issues.push(
            issue(
              'pigtail-members-on-mass',
              `pigtail '${pigtail.id}' lists members, but every screen of '${wire.id}' is one bonded mass — the list means nothing; omit it`,
              where,
              'warning',
            ),
          );
        }
        if (
          (pigtail.members !== undefined && pigtail.members.length === 0) ||
          (pigtail.members === undefined && !massStock)
        ) {
          issues.push(
            issue(
              'pigtail-empty',
              pigtail.members === undefined
                ? `pigtail '${pigtail.id}' names no members, and the screens of '${wire.id}' are not one bonded mass`
                : `pigtail '${pigtail.id}' has an empty member list`,
              where,
            ),
          );
        }
        for (const path of pigtail.members ?? []) {
          if (!isScreenPath(wire, path)) {
            issues.push(
              issue(
                'pigtail-member-unknown',
                `pigtail '${pigtail.id}' member '${path}' is not a shield or bare conductor of '${wire.id}'`,
                where,
              ),
            );
            continue;
          }
          const other = seen.get(path);
          if (other !== undefined) {
            issues.push(
              issue(
                'pigtail-member-twice',
                `screen '${path}' is twisted into both pigtail '${other}' and pigtail '${pigtail.id}' at end '${end}'`,
                where,
              ),
            );
          }
          seen.set(path, pigtail.id);
        }
        for (const path of pigtailMembers(wire, pigtail)) {
          const own = terminalKey({ instance: segment.id, terminal: path, end });
          if (landings.has(own)) {
            issues.push(
              issue(
                'pigtail-and-joint',
                `screen '${path}' is in pigtail '${pigtail.id}' and also has its own joint at end '${end}'`,
                own,
              ),
            );
          }
        }
        const count = landings.get(where) ?? 0;
        if (count === 0) {
          issues.push(
            issue('pigtail-no-landing', `pigtail '${pigtail.id}' of segment '${segment.id}' at end '${end}' has no landing joint`, where),
          );
        } else if (count > 1) {
          issues.push(
            issue(
              'pigtail-multi-landing',
              `pigtail '${pigtail.id}' of segment '${segment.id}' at end '${end}' has ${count} joints — one pigtail lands once; split it`,
              where,
              'warning',
            ),
          );
        }
      }
      if (massStock) {
        for (const path of screenPaths(wire)) {
          const own = terminalKey({ instance: segment.id, terminal: path, end });
          if (!landings.has(own)) continue;
          issues.push(
            issue(
              'bonded-screen-joint',
              `joint straight onto '${path}' of '${wire.id}', whose screens are one bonded mass — land the mass through a pigtail`,
              own,
              'warning',
            ),
          );
        }
      }
    }
  }
  return issues;
}
