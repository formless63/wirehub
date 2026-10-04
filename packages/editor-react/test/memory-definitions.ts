/**
 * A `DefinitionsAdapter` with arrays behind it.
 *
 * Like `memory-persistence.ts`, it keeps the *host's rules* rather than just
 * its shape: it validates the whole candidate library before it writes, refuses
 * an id anything else already uses, insists on the confirm token, and — the one
 * that matters most here — refuses to delete a definition something still
 * points at, naming what. An adapter that always said yes would prove only that
 * the buttons are wired.
 *
 * The designs it checks against are handed in, because that is what the real
 * host does: a definition is referenced by designs, and the catalog is the only
 * place that knows which.
 */

import {
  composeConnector,
  decomposeConnector,
  errors,
  validateDb,
  validateDesign,
  type CableDesign,
  type ConnectorBody,
  type Db,
  type Interface,
  type InterfaceLibrary,
  type Issue,
} from '@wirehub/model';

import type {
  DefinitionKind,
  DefinitionList,
  DefinitionRecord,
  DefinitionUsage,
  DefinitionsAdapter,
} from '../src/definitions.ts';
import type { Outcome } from '../src/persistence.ts';

export interface MemoryDefinitions extends DefinitionsAdapter {
  /** what is "on disk", per kind, in file order */
  stored: Map<DefinitionKind, DefinitionRecord[]>;
  /** every call made, in order — `save:connectors/scart-male` */
  calls: string[];
  /** the library as it now stands, the way `loadDb` assembles it */
  db(): Db;
}

function issueKey(issue: Issue): string {
  return `${issue.code} ${issue.where ?? ''} ${issue.message}`;
}

export function memoryDefinitions(db: Db, designs: CableDesign[] = []): MemoryDefinitions {
  const stored = new Map<DefinitionKind, DefinitionRecord[]>([
    ['connectors', structuredClone(db.connectors)],
    ['components', structuredClone(db.components)],
    ['wires', structuredClone(db.wires)],
    ['pcbas', structuredClone(db.pcbas)],
    ['bodies', structuredClone(db.bodies ?? [])],
    ['interfaces', structuredClone(db.interfaces ?? [])],
    ['mechanicals', structuredClone(db.mechanicals ?? [])],
    ['kits', structuredClone(db.kits ?? [])],
  ]);
  const calls: string[] = [];

  const list = (kind: DefinitionKind): DefinitionRecord[] => stored.get(kind) ?? [];

  const current = (): Db => ({
    connectors: list('connectors') as Db['connectors'],
    components: list('components') as Db['components'],
    wires: list('wires') as Db['wires'],
    pcbas: list('pcbas') as Db['pcbas'],
    bodies: list('bodies') as ConnectorBody[],
    interfaces: list('interfaces') as Interface[],
    mechanicals: list('mechanicals') as NonNullable<Db['mechanicals']>,
    kits: list('kits') as NonNullable<Db['kits']>,
    ...(db.vocab === undefined ? {} : { vocab: db.vocab }),
  });

  /** A body or pinout write re-composes the connectors on it — the host's store does that on disk. */
  const recomposed = (before: Db, after: Db): Db['connectors'] => {
    const lib = (d: Db): InterfaceLibrary => ({ bodies: d.bodies ?? [], interfaces: d.interfaces ?? [], ...(d.vocab === undefined ? {} : { vocab: d.vocab }) });
    return before.connectors.map((c) => composeConnector(decomposeConnector(c, lib(before)), lib(after)));
  };

  const candidate = (kind: DefinitionKind, records: DefinitionRecord[]): Db => {
    const now = current();
    const next = { ...now, [kind]: records } as Db;
    return kind === 'bodies' || kind === 'interfaces' ? { ...next, connectors: recomposed(now, next) } : next;
  };

  const everything = (library: Db): Issue[] => [
    ...validateDb(library),
    ...designs.flatMap((design) =>
      validateDesign(design, library).map((issue) => ({
        ...issue,
        where: `designs/${design.id}${issue.where === undefined ? '' : ` · ${issue.where}`}`,
      })),
    ),
  ];

  /** Only what this edit would break — the host's own comparison. */
  const checked = (
    kind: DefinitionKind,
    records: DefinitionRecord[],
    record: DefinitionRecord,
  ): Outcome<DefinitionRecord> => {
    const before = new Set(errors(everything(current())).map(issueKey));
    const blocking = errors(everything(candidate(kind, records))).filter(
      (issue) => !before.has(issueKey(issue)),
    );
    if (blocking.length > 0) {
      return {
        ok: false,
        message: `Saving this would break ${blocking.length === 1 ? 'something' : `${blocking.length} things`}.`,
        hint: 'Nothing was written — the catalog is untouched.',
        issues: blocking,
      };
    }
    const next = candidate(kind, records);
    stored.set(kind, structuredClone(records));
    if (kind === 'bodies' || kind === 'interfaces') stored.set('connectors', structuredClone(next.connectors));
    return { ok: true, value: structuredClone(record) };
  };

  const usage = (kind: DefinitionKind, id: string): DefinitionUsage => {
    const pick = (design: CableDesign): { def: string }[] =>
      kind === 'connectors'
        ? design.instances.connectors
        : kind === 'components'
          ? design.instances.components
          : kind === 'wires'
            ? design.instances.segments
            : kind === 'pcbas'
              ? design.instances.pcbas
              : kind === 'mechanicals'
                ? (design.instances.mechanical ?? [])
                : [];
    const using = designs
      .filter((design) => pick(design).some((instance) => instance.def === id))
      .map((design) => ({ id: design.id, label: design.label }));
    const definitions =
      kind === 'connectors'
        ? (list('pcbas') as Db['pcbas'])
            .filter((pcba) =>
              (pcba.integratedConnectors ?? []).some((entry) => entry.connectorDefId === id),
            )
            .map((pcba) => `pcbas/${pcba.id}`)
        : [];
    return { kind, id, designs: using, definitions, count: using.length + definitions.length };
  };

  return {
    stored,
    calls,
    db: current,

    async list(kind): Promise<Outcome<DefinitionList>> {
      calls.push(`list:${kind}`);
      return { ok: true, value: { kind, records: structuredClone(list(kind)) } };
    },

    async save(kind, record): Promise<Outcome<DefinitionRecord>> {
      calls.push(`save:${kind}/${record.id}`);
      const records = list(kind);
      const index = records.findIndex((existing) => existing.id === record.id);
      if (index === -1) {
        return {
          ok: false,
          message: `There is no ${kind.slice(0, -1)} called '${record.id}'.`,
          hint: 'Pick one from the list, or add a new one.',
        };
      }
      return checked(
        kind,
        records.map((existing, at) => (at === index ? record : existing)),
        record,
      );
    },

    async create(kind, record): Promise<Outcome<DefinitionRecord>> {
      calls.push(`create:${kind}/${record.id}`);
      const library = current();
      const space: { id: string }[] =
        kind === 'bodies' || kind === 'interfaces' || kind === 'kits'
          ? list(kind)
          : [...library.connectors, ...library.components, ...library.wires, ...library.pcbas, ...(library.mechanicals ?? [])];
      const taken = space.some((existing) => existing.id === record.id);
      if (taken) {
        return {
          ok: false,
          message: `Something in the library is already called '${record.id}'.`,
          hint: 'Ids are shared across the whole library. Choose a different one.',
        };
      }
      return checked(kind, [...list(kind), record], record);
    },

    async remove(kind, id, confirm): Promise<Outcome<{ id: string }>> {
      calls.push(`remove:${kind}/${id}`);
      const records = list(kind);
      if (!records.some((record) => record.id === id)) {
        return { ok: false, message: `There is no '${id}' to delete.`, hint: 'It may already be gone.' };
      }
      if (confirm !== id) {
        return {
          ok: false,
          message: `Deleting '${id}' has to be confirmed.`,
          hint: `Nothing was deleted. Confirm with its own id ('${id}').`,
        };
      }
      const who = usage(kind, id);
      if (who.count > 0) {
        return {
          ok: false,
          message: `'${id}' is still used by ${who.count} thing${who.count === 1 ? '' : 's'}, so it was not deleted.`,
          hint: `Change them to use something else first: ${[
            ...who.designs.map((design) => design.id),
            ...who.definitions,
          ].join('; ')}.`,
        };
      }
      stored.set(
        kind,
        records.filter((record) => record.id !== id),
      );
      return { ok: true, value: { id } };
    },

    async usage(kind, id): Promise<Outcome<DefinitionUsage>> {
      calls.push(`usage:${kind}/${id}`);
      return { ok: true, value: usage(kind, id) };
    },
  };
}
