/**
 * The definition store — the workbench API's door to the four catalog files.
 *
 * The same split `designs.ts` makes, for the definition library: this file is
 * the only one that opens `packages/catalog/data/*.json`, and `definitions.ts`
 * — which holds every rule about *what may be written* — never imports
 * `node:fs`. That is what lets the whole definition surface be tested with an
 * array in memory, and what lets the future ERP host bind its own storage
 * without touching a single rule.
 *
 * Two rules live here and nowhere else:
 *
 * 1. **A kind is one of four names, never a path.** `definitionPath` refuses
 *    anything else, so a request cannot reach a file the editors do not own —
 *    `pcbas.generated.json` included, which is written by the importer and is
 *    not editable by hand or by GUI.
 * 2. **Writes are plain JSON arrays**, 2-space indented with a trailing
 *    newline, so an edited file diffs like the hand-authored ones next to it.
 *    A file whose contents already state these exact facts is left alone, so
 *    saving a record nobody changed never reflows someone's careful
 *    formatting.
 *
 * Hand-formatted files (one-line pin objects) stay hand-formatted: a real
 * change is written by `patchJsonText`, which keeps every untouched record's
 * bytes and rewrites only what changed, in its neighbours' style
 *.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { patchJsonText } from './json-text.ts';

import { dataPath, loadBodies, loadInterfaces, loadVocab } from '@cable-studio/catalog';
import { composeConnectors, decomposeConnector } from '@cable-studio/model';
import type {
  ComponentDefinition,
  ConnectorBody,
  ConnectorDefinition,
  ConnectorRecord,
  Interface,
  InterfaceLibrary,
  KitDefinition,
  MechanicalDefinition,
  PcbaDefinition,
  WireDefinition,
} from '@cable-studio/model';
import { writeFileAtomic } from './atomic-write.ts';
import type { Awaitable } from './storage/change-set.ts';

/**
 * The editable definition files, named as they are on disk and in the `Db` —
 * the four parts a design instantiates (`connectors`, `components`, `wires`,
 * `pcbas`), the connector's physical body and its pinouts (`bodies`,
 * `interfaces`, data model v2 §1.2, edited by the connector journey —
 *), shells and hardware (`mechanicals`) and orderable kits
 * (`kits`, §7.1 —). One vocabulary for the URL, the file
 * name and the db key means no translation table anywhere.
 */
export const DEFINITION_KINDS = [
  'connectors',
  'components',
  'wires',
  'pcbas',
  'bodies',
  'interfaces',
  'mechanicals',
  'kits',
] as const;

export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export function isDefinitionKind(value: unknown): value is DefinitionKind {
  return typeof value === 'string' && (DEFINITION_KINDS as readonly string[]).includes(value);
}

/** Every definition record carries an id, a human label and its provenance. */
export type DefinitionRecord =
  | ConnectorDefinition
  | ComponentDefinition
  | WireDefinition
  | PcbaDefinition
  | ConnectorBody
  | Interface
  | MechanicalDefinition
  | KitDefinition;

/**
 * The persistence the definition handlers are written against. The dev server
 * binds the filesystem implementation below; the tests bind arrays.
 *
 * `list` hands back the file's records **in file order** — order is the record
 * of how the library grew, and rewriting it would turn a one-field edit into a
 * whole-file diff.
 */
export interface DefinitionStore {
  list(kind: DefinitionKind): Awaitable<DefinitionRecord[]>;
  /** replaces the whole file; `changed` is false when the bytes already said this */
  write(kind: DefinitionKind, records: DefinitionRecord[]): Awaitable<{ changed: boolean }>;
}

/** The canonical on-disk form of a definition file: 2-space JSON, trailing newline. */
export function formatDefinitionsJson(records: readonly DefinitionRecord[]): string {
  return `${JSON.stringify(records, null, 2)}\n`;
}

/**
 * Absolute path of a definition file. **The only place a kind becomes a path.**
 * Throws rather than returning something a caller might use anyway.
 */
export function definitionPath(kind: string): string {
  if (!isDefinitionKind(kind)) throw new Error(`'${kind}' is not an editable definition file`);
  return dataPath(`${kind}.json`);
}

/**
 * The body/interface library connectors compose against (data model v2 §1.2).
 * Read per call, like everything else here: the files can change under a
 * long-lived host.
 */
function interfaceLibrary(): InterfaceLibrary {
  return { bodies: loadBodies(), interfaces: loadInterfaces(), vocab: loadVocab() };
}

/**
 * The catalog's four editable files, as a store. `connectors.json` holds
 * body + interface pairs: `list` hands the editors the
 * composed connectors, and `write` stores a connector whose pins are still
 * its composition without them — an edited pinout keeps its own pins.
 */
export function fileDefinitionStore(): DefinitionStore {
  return {
    list(kind: DefinitionKind): DefinitionRecord[] {
      const path = definitionPath(kind);
      if (!existsSync(path)) return [];
      const stored = JSON.parse(readFileSync(path, 'utf8')) as DefinitionRecord[];
      // connectors are stored as body + interface; the editors see composed pins
      return kind === 'connectors' ? composeConnectors(stored as ConnectorRecord[], interfaceLibrary()) : stored;
    },

    write(kind: DefinitionKind, records: DefinitionRecord[]): { changed: boolean } {
      const path = definitionPath(kind);
      const stored =
        kind === 'connectors'
          ? (() => {
              const library = interfaceLibrary();
              return (records as ConnectorDefinition[]).map((r) => decomposeConnector(r, library));
            })()
          : records;
      let next = formatDefinitionsJson(stored as DefinitionRecord[]);
      if (existsSync(path)) {
        const current = readFileSync(path, 'utf8');
        if (current === next) return { changed: false };
        try {
          // same facts, different whitespace — leave the author's file alone
          if (isDeepStrictEqual(JSON.parse(current), stored)) return { changed: false };
        } catch {
          // a file that will not parse is not worth preserving; what got here
          // has been validated, so overwriting it is an improvement
        }
        // untouched records keep their bytes; only the edited one is rewritten (50a.26)
        next = patchJsonText(current, stored);
      }
      writeFileAtomic(path, next, 'utf8');
      return { changed: true };
    },
  };
}
