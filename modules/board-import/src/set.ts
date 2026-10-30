/**
 * A board's files read together (`board-set` importer): the `.kicad_pcb` (or
 * `.net`) and, optionally, its Gerber set and its fab BOM and placement — one
 * proposal, one publish. The page sends them as one `.board-set.json`
 * bundle. With the `update` option (a board id) the board file refreshes that
 * board instead: its terminals, internal links, integrated connectors and
 * netlist are replaced from the file; its name, part number, revision,
 * status and build stay, and each kept terminal keeps its role, signal and
 * label (tag corrections live beside the record and are untouched).
 *
 * `terminalChanges` is the preview both the page and the importer use.
 */

import type { Db, PcbaDefinition, PcbaTerminal } from '@wirehub/model';
import type { ImportInput, ImportResult } from '@wirehub/modules';

import { kicadDepiction } from './art.ts';
import { boardParts, isPlacement, type BomField, type ColumnMapping, type CplField, type FabFile } from './bom.ts';
import { deriveBoard } from './derive.ts';
import { gerberDepiction, readGerberSet } from './gerber-art.ts';
import { parseKicadNetlist, parseKicadPcb, type BoardSource } from './kicad.ts';
import { isZip, readZip } from './zip.ts';

export const BOARD_SET_FORMAT = 'wirehub.board-set';

export interface BoardSetBundle {
  format: string;
  version: number;
  board: { fileName: string; base64: string };
  gerbers?: { fileName: string; base64: string };
  bom?: { fileName: string; text: string };
  cpl?: { fileName: string; text: string };
}

export interface TerminalChanges {
  added: string[];
  removed: string[];
  /** old id → new id: the same pads under a new name */
  renamed: [string, string][];
}

function padKey(t: PcbaTerminal): string {
  return (t.pads ?? []).map((p) => `${p.ref}:${p.side ?? ''}`).sort().join('|');
}

/** What replacing `before`'s terminals with `after`'s would change. */
export function terminalChanges(before: readonly PcbaTerminal[], after: readonly PcbaTerminal[]): TerminalChanges {
  const old = new Set(before.map((t) => t.id));
  const next = new Set(after.map((t) => t.id));
  const gone = before.filter((t) => !next.has(t.id));
  const fresh = after.filter((t) => !old.has(t.id));
  const renamed: [string, string][] = [];
  for (const t of gone) {
    const key = padKey(t);
    const match = key === '' ? undefined : fresh.find((f) => padKey(f) === key && !renamed.some(([, to]) => to === f.id));
    if (match !== undefined) renamed.push([t.id, match.id]);
  }
  return {
    added: fresh.filter((f) => !renamed.some(([, to]) => to === f.id)).map((f) => f.id),
    removed: gone.filter((g) => !renamed.some(([from]) => from === g.id)).map((g) => g.id),
    renamed,
  };
}

/** `existing` with its wiring replaced from `derived`, keeping what a person set. */
export function refreshedBoard(existing: PcbaDefinition, derived: PcbaDefinition): PcbaDefinition {
  const changes = terminalChanges(existing.terminals, derived.terminals);
  const oldOf = new Map<string, PcbaTerminal>(existing.terminals.map((t) => [t.id, t]));
  for (const [from, to] of changes.renamed) oldOf.set(to, oldOf.get(from)!);
  const terminals = derived.terminals.map((t) => {
    const was = oldOf.get(t.id);
    if (was === undefined) return t;
    return {
      ...t,
      ...(was.label === undefined || was.label === was.id ? {} : { label: was.label }),
      ...(was.role === undefined ? {} : { role: was.role }),
      ...(was.signal === undefined ? {} : { signal: was.signal }),
    };
  });
  const { integratedConnectors: _ic, netlist: _nl, ...rest } = existing;
  return {
    ...rest,
    terminals,
    internalLinks: derived.internalLinks,
    ...(derived.integratedConnectors === undefined ? {} : { integratedConnectors: derived.integratedConnectors }),
    ...(derived.netlist === undefined ? {} : { netlist: derived.netlist }),
    ...(derived.kicadProject === undefined ? {} : { kicadProject: derived.kicadProject }),
    src: derived.src,
  };
}

export function readBoardFile(fileName: string, bytes: Uint8Array): BoardSource {
  const content = new TextDecoder().decode(bytes);
  return fileName.toLowerCase().endsWith('.net') ? parseKicadNetlist(content, fileName) : parseKicadPcb(content, fileName);
}

function decode(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function option(input: ImportInput, name: string): string | undefined {
  const value = input.options?.[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The `board-set` import: one proposal from a bundle (see the file header). */
export async function importBoardSet(input: ImportInput, db: Db): Promise<ImportResult> {
  const bundle = JSON.parse(new TextDecoder().decode(input.bytes)) as BoardSetBundle;
  if (bundle.format !== BOARD_SET_FORMAT || bundle.version !== 1 || bundle.board === undefined) throw new Error(`${input.fileName} is not a ${BOARD_SET_FORMAT} bundle (version 1).`);
  const boardBytes = decode(bundle.board.base64);
  const source = readBoardFile(bundle.board.fileName, boardBytes);
  const sha256 = await sha(boardBytes);
  const updating = option(input, 'update');
  const existing = updating === undefined ? undefined : db.pcbas.find((p) => p.id === updating);
  if (updating !== undefined && existing === undefined) throw new Error(`There is no board '${updating}' to update.`);
  const has = (name: string): boolean => input.options?.[name] !== undefined;
  const derived = deriveBoard(
    source,
    {
      sha256,
      ...(existing !== undefined ? { id: existing.id } : option(input, 'id') === undefined ? {} : { id: option(input, 'id')! }),
      ...(option(input, 'label') === undefined ? {} : { label: option(input, 'label')! }),
      // sent but empty: the board has no part number yet
      ...(has('partNumber') ? { partNumber: option(input, 'partNumber') ?? '' } : {}),
      ...(option(input, 'revision') === undefined ? {} : { revision: option(input, 'revision')! }),
    },
    db,
  );
  const notes = [...derived.notes];
  const art = kicadDepiction(source, derived.pcba.id, derived.pads, { path: bundle.board.fileName, sha256 });

  if (existing !== undefined) {
    const next = refreshedBoard(existing, derived.pcba);
    // art the hub keeps instead of this file's (a Gerber tier, a person's own) follows the renames
    const renamed = Object.fromEntries(terminalChanges(existing.terminals, derived.pcba.terminals).renamed);
    return { updates: { pcbas: [next] }, ...(art === undefined ? {} : { depictions: [{ ...art, renamed }] }), notes };
  }

  const pcba = derived.pcba;
  const depictions = [];
  if (bundle.gerbers !== undefined) {
    const zip = decode(bundle.gerbers.base64);
    if (!isZip(zip)) throw new Error(`${bundle.gerbers.fileName} is not a ZIP archive.`);
    const set = readGerberSet(await readZip(zip));
    const gerber = gerberDepiction(set, pcba, { path: bundle.gerbers.fileName, sha256: await sha(zip) });
    depictions.push(gerber.depiction);
    notes.push(...gerber.notes);
  } else if (art !== undefined) depictions.push(art);

  let parts: ReturnType<typeof boardParts> | undefined;
  if (bundle.bom !== undefined || bundle.cpl !== undefined) {
    const file = async (f: { fileName: string; text: string }): Promise<FabFile> => ({ fileName: f.fileName, text: f.text, sha256: await sha(new TextEncoder().encode(f.text)) });
    // a placement file dropped as the BOM is read as placement
    let bom = bundle.bom === undefined ? undefined : await file(bundle.bom);
    let cpl = bundle.cpl === undefined ? undefined : await file(bundle.cpl);
    if (cpl === undefined && bom !== undefined && isPlacement(bom.text)) [bom, cpl] = [undefined, bom];
    const mapping = input.options?.['mapping'] === undefined ? {} : (JSON.parse(input.options['mapping']) as { bom?: ColumnMapping<BomField>; cpl?: ColumnMapping<CplField> });
    parts = boardParts(pcba, bom, cpl, db, mapping);
    notes.push(...parts.notes);
  }
  return {
    definitions: { pcbas: [pcba], ...(parts === undefined ? {} : { components: parts.components }) },
    ...(parts === undefined ? {} : { boardParts: [parts.entry] }),
    ...(depictions.length === 0 ? {} : { depictions }),
    notes,
  };
}
