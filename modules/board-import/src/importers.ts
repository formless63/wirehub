/**
 * The three importers, over the importer contract (`ImporterContribution`):
 * each reads one file (and the review step's options) and proposes records;
 * the host shows the proposal, plans it as a job and publishes it as one
 * change set. Nothing here writes.
 *
 * - `kicad-board` — `.kicad_pcb` / `.net` → a PCBA definition (terminals,
 *   pads, internal links, integrated connectors) and, from a `.kicad_pcb`,
 *   `kicad`-tier art with anchors.
 * - `gerbers` — a Gerber set `.zip` → the board's `gerber`-tier art.
 * - `fab-bom` — a BOM or placement `.csv`, or both bundled in a
 *   `.board-bom.json` (what the module's page sends after column mapping) →
 *   component records and the board's placed parts.
 *
 * Options (all text): `board` (the PCBA a Gerber set or BOM belongs to);
 * for `kicad-board` `id`, `label`, `partNumber`, `revision`, `build`,
 * `connectors` (JSON: footprint reference → Library connector id) and
 * `art` (`no` to skip the art); for `fab-bom` `mapping` (JSON:
 * `{ bom: { refs: 'Designator', … }, cpl: { x: 'Mid X', … } }`).
 */

import type { Db, PcbaDefinition } from '@wirehub/model';
import type { ImporterContribution, ImportInput, ImportResult } from '@wirehub/modules';

import { kicadDepiction } from './art.ts';
import { boardParts, isPlacement, type BomField, type ColumnMapping, type CplField, type FabFile } from './bom.ts';
import { deriveBoard } from './derive.ts';
import { gerberDepiction, readGerberSet } from './gerber-art.ts';
import { parseKicadNetlist, parseKicadPcb } from './kicad.ts';
import { kebab } from './values.ts';
import { isZip, readZip } from './zip.ts';

export const BOARD_BOM_FORMAT = 'wirehub.board-bom';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonOption<T>(input: ImportInput, name: string): T | undefined {
  const raw = input.options?.[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`The ${name} option is not JSON.`);
  }
}

function text(input: ImportInput, name: string): string | undefined {
  const value = input.options?.[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The board a Gerber set or BOM belongs to: the `board` option; else the one
 * whose KiCad project the files name; else the one whose id or part number
 * the file name carries (the longest such match).
 */
export function resolveBoard(db: Pick<Db, 'pcbas'>, fileName: string, option: string | undefined, project?: string): PcbaDefinition {
  if (option !== undefined) {
    const found = db.pcbas.find((p) => p.id === option);
    if (found === undefined) throw new Error(`There is no board '${option}' in the Library; import its .kicad_pcb (or create it) first.`);
    return found;
  }
  if (project !== undefined) {
    const byProject = db.pcbas.filter((p) => p.kicadProject !== undefined && p.kicadProject.toLowerCase() === project.toLowerCase());
    if (byProject.length === 1) return byProject[0]!;
  }
  const name = kebab(fileName.replace(/\.[^.]+$/, ''));
  const matches = db.pcbas
    .flatMap((p) => [p.id, kebab(p.partNumber)].filter((key) => key.length >= 3 && name.includes(key)).map((key) => ({ p, key })))
    .sort((a, b) => b.key.length - a.key.length);
  if (matches[0] !== undefined) return matches[0].p;
  throw new Error(`Which board is ${fileName} for? Say it with the board option (a board id), or name the file after the board.`);
}

export const kicadBoardImporter: ImporterContribution = {
  id: 'kicad-board',
  label: 'KiCad board (PCBA)',
  accepts: ['.kicad_pcb', '.net'],
  async import(input, db): Promise<ImportResult> {
    const content = new TextDecoder().decode(input.bytes);
    const netlist = input.fileName.toLowerCase().endsWith('.net');
    const source = netlist ? parseKicadNetlist(content, input.fileName) : parseKicadPcb(content, input.fileName);
    const sha256 = await sha256Hex(input.bytes);
    const connectors = jsonOption<Record<string, string>>(input, 'connectors');
    const opt = (name: string): string | undefined => text(input, name);
    const derived = deriveBoard(
      source,
      {
        sha256,
        ...(opt('id') === undefined ? {} : { id: opt('id')! }),
        ...(opt('label') === undefined ? {} : { label: opt('label')! }),
        ...(opt('partNumber') === undefined ? {} : { partNumber: opt('partNumber')! }),
        ...(opt('revision') === undefined ? {} : { revision: opt('revision')! }),
        ...(opt('build') === undefined ? {} : { build: opt('build')! }),
        ...(connectors === undefined ? {} : { connectors }),
      },
      db,
    );
    const notes = [...derived.notes];
    if (db.pcbas.some((p) => p.id === derived.pcba.id)) notes.push(`The Library already has a board '${derived.pcba.id}': it is kept as it is. Import under another id (the id option) to compare.`);
    const art = opt('art') === 'no' ? undefined : kicadDepiction(source, derived.pcba.id, derived.pads, { path: input.fileName, sha256 });
    return {
      definitions: { pcbas: [derived.pcba] },
      ...(art === undefined ? {} : { depictions: [art] }),
      notes,
    };
  },
};

export const gerberImporter: ImporterContribution = {
  id: 'gerbers',
  label: 'Gerber set (board art)',
  accepts: ['.zip'],
  async import(input, db): Promise<ImportResult> {
    if (!isZip(input.bytes)) throw new Error(`${input.fileName} is not a ZIP archive.`);
    const set = readGerberSet(await readZip(input.bytes));
    const pcba = resolveBoard(db, input.fileName, text(input, 'board'), set.project);
    const sha256 = await sha256Hex(input.bytes);
    const { depiction, notes } = gerberDepiction(set, pcba, { path: input.fileName, sha256 });
    return { depictions: [depiction], notes: [`Art for ${pcba.id} (${pcba.label}).`, ...notes] };
  },
};

interface BoardBomBundle {
  format: string;
  version: number;
  bom?: { fileName: string; text: string };
  cpl?: { fileName: string; text: string };
}

export const fabBomImporter: ImporterContribution = {
  id: 'fab-bom',
  label: 'Fab BOM / placement (board parts)',
  accepts: ['.csv', '.board-bom.json'],
  async import(input, db): Promise<ImportResult> {
    const content = new TextDecoder().decode(input.bytes);
    let bom: FabFile | undefined;
    let cpl: FabFile | undefined;
    const file = async (fileName: string, body: string): Promise<FabFile> => ({ fileName, text: body, sha256: await sha256Hex(new TextEncoder().encode(body)) });
    if (input.fileName.toLowerCase().endsWith('.json')) {
      const bundle = JSON.parse(content) as BoardBomBundle;
      if (bundle.format !== BOARD_BOM_FORMAT || bundle.version !== 1) throw new Error(`${input.fileName} is not a ${BOARD_BOM_FORMAT} bundle (version 1).`);
      if (bundle.bom !== undefined) bom = await file(bundle.bom.fileName, bundle.bom.text);
      if (bundle.cpl !== undefined) cpl = await file(bundle.cpl.fileName, bundle.cpl.text);
    } else if (isPlacement(content)) cpl = await file(input.fileName, content);
    else bom = await file(input.fileName, content);
    const pcba = resolveBoard(db, bom?.fileName ?? cpl?.fileName ?? input.fileName, text(input, 'board'));
    const mapping = jsonOption<{ bom?: ColumnMapping<BomField>; cpl?: ColumnMapping<CplField> }>(input, 'mapping') ?? {};
    const proposal = boardParts(pcba, bom, cpl, db, mapping);
    return {
      definitions: { components: proposal.components },
      boardParts: [proposal.entry],
      notes: [`Parts of ${pcba.id} (${pcba.partNumber} ${pcba.revision}).`, ...proposal.notes],
    };
  },
};
