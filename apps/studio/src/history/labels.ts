import { definitionNoun, parseSubject, type HistoryEntry, type HistoryTouch } from './types.ts';

/** Readable names for the ids an entry carries (`names.ts` fills it from what the page loaded); an unknown id stays an id. */
export interface RecordNames {
  design: (id: string) => string | undefined;
  /** a library record's label; `kind` undefined: any kind (artwork is keyed by the record id alone) */
  definition: (kind: string | undefined, id: string) => string | undefined;
  /** a board as a person orders it: its part number and revision, else its label */
  board: (id: string, revision?: string) => string | undefined;
  firmware: (id: string) => string | undefined;
  /** a note's or project's title (absent: named from its id) */
  knowledge?: (type: 'note' | 'project', id: string) => string | undefined;
}

export const NO_NAMES: RecordNames = { design: () => undefined, definition: () => undefined, board: () => undefined, firmware: () => undefined };

const LIBRARY: Readonly<Record<string, string>> = { connectors: 'Connectors', bodies: 'Connector bodies', interfaces: 'Pinouts', components: 'Components', wires: 'Wire stocks', pcbas: 'Boards', mechanicals: 'Shells and hardware', kits: 'Kits' };
const PART: Readonly<Record<string, string>> = { drawing: 'drawing details', versions: 'saved versions', photo: 'photo', '3D model': '3D model', record: '', design: '' };
const title = (value: string): string => value.replace(/[-_]+/g, ' ');
/** a slug as a name: `bench-check` → `Bench check` */
const named_ = (slug: string): string => {
  const text = title(slug).trim();
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1);
};
/** a key that is a hash or a uuid (a stored file, a job): never shown in a list */
const OPAQUE = /^(?:[0-9a-f]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** What a touch is, for a person: a type (`Note`, `Design`) and a name, or a file (counted, never named by its hash). */
export interface TouchMeaning {
  type: string;
  /** the record's readable name; undefined for a file or a record known only by an id */
  name?: string;
  /** a stored file (an attachment, a photo): counted as "+3 files" */
  file?: boolean;
  /** bookkeeping a person does not need to see (the knowledge index) */
  hidden?: boolean;
  /** what the summary line says for it, when not "<type> <name>" (`firmware projects`, `saved explorations`) */
  phrase?: string;
  /** a board's source file (`data/model-sources/<sha256>.kicad_pcb.txt`): named after the board it came with */
  boardFile?: boolean;
  /** the library record this touch belongs to (a board's artwork, its cover): folded into a board file's line */
  record?: string;
}

const DOC_TYPES: readonly (readonly [RegExp, string])[] = [
  [/^data\/knowledge\/notes\/(.+)\.json$/, 'Note'],
  [/^data\/knowledge\/projects\/(.+)\.json$/, 'Project'],
  [/^data\/firmware\/builds\/(.+)\.json$/, 'Firmware build'],
  [/^data\/firmware\/(.+)\.json$/, 'Firmware'],
  [/^data\/print\/files\/(.+)\.json$/, 'Print file'],
  [/^data\/print\/variants\/(.+)\.json$/, 'Print variant'],
  [/^data\/print\/(.+)\.json$/, 'Print'],
  [/^data\/enclosures\/(.+)\.json$/, 'Enclosure'],
  [/^data\/vocab\/(.+)\.json$/, 'List'],
  [/^data\/settings\/(.+)\.json$/, 'Settings'],
  [/^data\/designs\/(.+)\.json$/, 'Design'],
];

/** whole-catalog documents that name no single record: what they are, said once */
const DOC_PHRASES: Readonly<Record<string, readonly [type: string, phrase: string]>> = {
  'data/firmware/projects.json': ['Firmware projects', 'firmware projects'],
  'data/explore/saved.json': ['Saved explorations', 'saved explorations'],
  'data/board-parts.json': ['Board parts', 'board parts'],
  'data/models.json': ['3D models', '3D model links'],
  'data/wire-parts.json': ['Wire parts', 'wire parts'],
  'data/wire-recipes.json': ['Wire recipes', 'wire recipes'],
  'data/part-numbers.json': ['Part numbers', 'part number scheme'],
};

/** A touch's subject as a catalog path (`data/…`), for the database's `other:doc:` and git's `other:<path>` alike. */
function docPath(subject: string): string | undefined {
  if (subject.startsWith('other:doc:')) {
    const path = subject.slice('other:doc:'.length);
    return path.startsWith('data/') ? path : `data/${path}`;
  }
  const rest = subject.slice('other:'.length);
  // git's subjects are the path itself (`other:firmware/projects.json`)
  if (subject.startsWith('other:') && !rest.includes(':') && /\.[a-z0-9_]+$/i.test(rest)) return rest.startsWith('data/') ? rest : `data/${rest}`;
  return undefined;
}

export function touchMeaning(touch: HistoryTouch, names: RecordNames = NO_NAMES): TouchMeaning {
  const subject = parseSubject(touch.subject);
  if (subject?.type === 'design') return { type: 'Design', name: names.design(subject.id) ?? named_(subject.id) };
  if (subject?.type === 'definition') return { type: named_(definitionNoun(subject.kind)), name: names.definition(subject.kind, subject.id) ?? named_(subject.id), record: subject.id };
  if (subject?.type === 'vocab') return { type: 'List', name: named_(subject.list) };
  if (subject?.type === 'build') return { type: 'Board build', name: named_(subject.name) };
  if (subject?.type === 'note' || subject?.type === 'project') return { type: subject.type === 'note' ? 'Note' : 'Project', name: names.knowledge?.(subject.type, subject.id) ?? named_(subject.id) };
  if (touch.subject.startsWith('other:definitions:')) {
    const kind = touch.subject.slice('other:definitions:'.length).replace(/\.json$/, '');
    return { type: 'Library', name: LIBRARY[kind] ?? named_(kind) };
  }
  if (touch.subject.startsWith('other:firmware:')) {
    const id = touch.subject.slice('other:firmware:'.length);
    return { type: 'Firmware project', name: names.firmware(id) ?? named_(id) };
  }
  if (touch.subject.startsWith('other:asset:') || touch.subject.startsWith('other:attachments')) return { type: 'File', file: true };
  if (touch.subject.startsWith('other:artwork:')) {
    const id = touch.subject.slice('other:artwork:'.length);
    return { type: 'Artwork', name: names.definition(undefined, id) ?? named_(id), record: id };
  }
  const full = docPath(touch.subject);
  if (full !== undefined) {
    if (full === 'data/knowledge/index.json' || full.startsWith('data/tags/')) return { type: 'Knowledge', hidden: true };
    if (full.startsWith('data/assets/')) return { type: 'File', file: true };
    if (/^data\/model-sources\/[^/]+\.kicad_pcb(?:\.txt)?$/i.test(full)) return { type: 'Board file', boardFile: true };
    const phrase = DOC_PHRASES[full];
    if (phrase !== undefined) return { type: phrase[0], phrase: phrase[1] };
    const library = /^data\/([a-z]+)\.json$/.exec(full)?.[1];
    if (library !== undefined && LIBRARY[library] !== undefined) return { type: 'Library', name: LIBRARY[library] };
    const cover = /^data\/presentation\/covers\/([a-z]+)\/(.+)\.json$/.exec(full);
    if (cover !== null) return { type: 'Cover', name: names.definition(cover[1], cover[2]!) ?? names.design(cover[2]!) ?? named_(cover[2]!), record: cover[2]! };
    const drawing = /^data\/drawings\/([^/.]+)\.json$/.exec(full);
    if (drawing !== null) return { type: 'Drawing', name: names.design(drawing[1]!) ?? named_(drawing[1]!) };
    for (const [pattern, type] of DOC_TYPES) {
      const m = pattern.exec(full);
      if (m !== null) {
        const id = (m[1] ?? '').split('/').pop() ?? '';
        return { type, name: (type === 'Design' ? names.design(id) : type.startsWith('Firmware') ? names.firmware(id) : undefined) ?? named_(id) };
      }
    }
    const name = full.split('/').pop()?.replace(/\.[a-z0-9_]+$/i, '').replace(/\.[a-z0-9_]+$/i, '') ?? '';
    return OPAQUE.test(name) ? { type: 'Record' } : { type: 'Record', name: named_(name) };
  }
  const last = touch.subject.split(':').pop() ?? '';
  if (OPAQUE.test(last) || OPAQUE.test(touch.label.split(/\s+/).pop() ?? '')) return { type: 'Record' };
  return { type: 'Record', name: touch.label };
}

/** Display record keys readably without substituting today's name for a historical name. */
export function historyTouchLabel(touch: HistoryTouch, names: RecordNames = NO_NAMES): string {
  const meaning = touchMeaning(touch, names);
  const subject = parseSubject(touch.subject);
  const suffix = touch.part === undefined || subject === undefined ? '' : PART[touch.part] ?? title(touch.part);
  if (meaning.file === true) return 'File';
  if (meaning.type === 'Library') return `${meaning.name ?? ''} library`;
  if (meaning.phrase !== undefined || meaning.name === undefined || meaning.type === 'Record') return `${meaning.type === 'Record' ? meaning.name ?? 'Record' : meaning.type}${suffix === '' ? '' : ` · ${suffix}`}`;
  return `${meaning.type}: ${meaning.name}${suffix === '' ? '' : ` · ${suffix}`}`;
}

/** The verb a change reads with: from its deletes, else from the commit message's own verb. */
function verbOf(entry: HistoryEntry, touches: readonly HistoryTouch[]): string {
  if (touches.length > 0 && touches.every((t) => t.op === 'delete')) return 'Deleted';
  if (touches.length > 0 && touches.every((t) => t.op === 'move')) return 'Moved';
  const m = /^(?:[a-z-]+:\s*)?(create|add|new|import|upload|restore|delete|remove|undo|revert)\b/i.exec(entry.message);
  switch (m?.[1]?.toLowerCase()) {
    case 'create':
    case 'add':
    case 'new':
    case 'upload':
      return 'Added';
    case 'import':
      return 'Imported';
    case 'restore':
    case 'undo':
    case 'revert':
      return 'Restored';
    case 'delete':
    case 'remove':
      return 'Deleted';
    default:
      return 'Edited';
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The board an entry's board file came with: its artwork's record, else a board record it touched. */
function boardOf(touches: readonly HistoryTouch[]): string | undefined {
  for (const t of touches) if (t.subject.startsWith('other:artwork:')) return t.subject.slice('other:artwork:'.length);
  for (const t of touches) if (t.subject.startsWith('definition:pcbas:')) return t.subject.slice('definition:pcbas:'.length);
  return undefined;
}

/**
 * One line a person reads for a change, built from the records it changed: "Edited note Bench check",
 * "Added 3 files", "Edited design Dc led lead +2 more", "Added board file for <board>". File hashes and ids
 * are counted, never shown; `names` turns ids into the records' labels where the page knows them.
 */
export function historySummary(entry: HistoryEntry, names: RecordNames = NO_NAMES): string {
  const touches = entry.touches;
  let verb = verbOf(entry, touches);
  const seen = new Set<string>();
  const named: string[] = [];
  let files = 0;
  let unnamed = 0;
  // a board file names its board; the board's own record, artwork and placed parts fold into that line
  const hasBoardFile = touches.some((t) => touchMeaning(t).boardFile === true);
  const board = hasBoardFile ? boardOf(touches) : undefined;
  if (hasBoardFile) {
    named.push(board === undefined ? 'board file' : `board file for ${names.definition('pcbas', board) ?? names.definition(undefined, board) ?? named_(board)}`);
    if (verb === 'Edited') verb = 'Added';
  }
  for (const t of touches) {
    const m = touchMeaning(t, names);
    if (m.hidden === true || m.boardFile === true) continue;
    // (on git a board list names no record: the list is the board the file came with)
    if (hasBoardFile && ((board !== undefined && m.record === board) || m.type === 'Board parts' || (board === undefined && t.subject === 'other:definitions:pcbas'))) continue;
    if (m.file === true) {
      files += 1;
      continue;
    }
    if (m.phrase === undefined && m.name === undefined) {
      unnamed += 1;
      continue;
    }
    const text = m.phrase ?? (m.type === 'Library' ? `${m.name} library` : m.type === 'Record' ? m.name! : `${m.type.toLowerCase()} ${m.name}`);
    if (seen.has(text)) continue;
    seen.add(text);
    named.push(text);
  }
  const extra = (entry.more ?? 0) + unnamed + Math.max(0, named.length - 2);
  const parts: string[] = [];
  if (named.length > 0) parts.push(named.slice(0, 2).join(', '));
  if (files > 0) parts.push(named.length === 0 ? plural(files, 'file') : `+${plural(files, 'file')}`);
  if (extra > 0) parts.push(named.length === 0 && files === 0 ? plural(extra, 'record') : `+${extra} more`);
  if (parts.length === 0) return entry.message;
  // an import brings a whole catalog: a count says more than its first file names
  if (!hasBoardFile && verb === 'Imported' && touches.length + (entry.more ?? 0) > 3) return `Imported ${plural(touches.length + (entry.more ?? 0), 'record')}`;
  return `${verb} ${parts.join(' ')}`;
}

/** The raw commit text behind a change (its message and body), for a tooltip or a "raw" toggle. */
export const historyRaw = (entry: HistoryEntry): string => (entry.body === undefined ? entry.message : `${entry.message}\n\n${entry.body}`);
