/**
 * The module's page, `/m/board-import/boards`: one drop zone for a board's
 * files — the `.kicad_pcb` (or `.net`) and, optionally, its Gerber `.zip`, BOM
 * and placement `.csv` — a compact preview read in the browser (outline,
 * terminals, parts), the name, part number and revision, and one Publish. The
 * files go in as one `board-set` import job; once published, the board file is
 * attached as the board's 3D model source and the new record opens.
 *
 * `?update=<board id>`: the same drop zone refreshes that board from a new
 * board file — a preview of the terminals added, removed and renamed (and the
 * designs a removed one would leave dangling) before Apply. With
 * `&source=stored` the board file stored with the board is picked already
 * (the board journey's KiCad check, "Update from this file").
 *
 * Written with `createElement` (no JSX): the server imports this file through
 * Node's type stripping.
 */

import type { CableDesign, Db, PcbaDefinition } from '@wirehub/model';
import type { RouteProps } from '@wirehub/modules';
import { createElement as h, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';

import { kicadDepiction } from './art.ts';
import { BOM_FIELDS, CPL_FIELDS, detectColumns, isPlacement, tableOf, type BomField, type CplField } from './bom.ts';
import { deriveBoard, type DerivedBoard } from './derive.ts';
import { readGerberSet } from './gerber-art.ts';
import type { BoardSource } from './kicad.ts';
import { BOARD_SET_FORMAT, readBoardFile, refreshedBoard, terminalChanges, type BoardSetBundle, type TerminalChanges } from './set.ts';
import { kebab } from './values.ts';
import { readZip } from './zip.ts';

export const MODULE_ID = 'board-import';

interface JobView {
  id: string;
  status: string;
  error?: string;
  result?: { proposal?: { definitions: Record<string, { id: string }[]>; updated?: Record<string, { id: string }[]>; existing: string[]; skipped?: string[]; notes: string[] } };
  publishedVersion?: string;
}

interface Answer {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  try {
    const response = await fetch(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.status < 400, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: { error: 'WireHub could not be reached.' } };
  }
}

function words(answer: Answer): string {
  return typeof answer.body['error'] === 'string' ? answer.body['error'] : 'That failed.';
}

export function base64Of(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const INPUT = { className: 'cs-ui-input', 'data-size': 'sm' } as const;
const BUTTON = (primary = false) => ({ className: 'cs-ui-btn', 'data-size': 'sm', 'data-variant': primary ? 'primary' : 'secondary' }) as const;
const DIM = { color: 'var(--dim)', fontSize: 'var(--fs-xs)' } as const;

const KIND_URL: Record<string, string> = { pcbas: 'boards', mechanicals: 'hardware', connectors: 'connectors', components: 'components', wires: 'wires', kits: 'kits' };

export function recordHref(ref: string): string | undefined {
  const [kind = '', id = ''] = ref.split('/');
  if (kind === 'designs') return `/cables/${encodeURIComponent(id)}`;
  const url = KIND_URL[kind];
  return url === undefined || id === '' ? undefined : `/library/${url}/${encodeURIComponent(id)}`;
}

/** Text with each `pcbas/<id>` (and other record refs) as a link to the record. */
function linked(text: string, db: Db): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\b(pcbas|connectors|components|wires|mechanicals|kits|designs)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(text.slice(last, m.index));
    const ref = m[0];
    const board = m[1] === 'pcbas' ? db.pcbas.find((p) => p.id === m![2]) : undefined;
    // a board the import would have made is not there to open: its name only
    out.push(m[1] === 'pcbas' && board === undefined ? m[2] : h('a', { key: `${m.index}`, href: recordHref(ref), title: ref }, board?.label ?? m[2]));
    last = m.index + ref.length;
  }
  out.push(text.slice(last));
  return out;
}

type Role = 'board' | 'gerbers' | 'bom' | 'cpl';

interface Picked {
  role: Role;
  file: File;
  bytes: Uint8Array;
  /** the CSVs: their header and the detected columns */
  header?: string[];
  mapping?: Record<string, string>;
  /** a short fact about the file, shown on its chip */
  fact?: string;
}

const ROLE_WORD: Record<Role, string> = { board: 'Board', gerbers: 'Gerbers', bom: 'BOM', cpl: 'Placement' };

async function pickFile(file: File): Promise<Picked | string> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith('.kicad_pcb') || name.endsWith('.net')) return { role: 'board', file, bytes };
  if (name.endsWith('.zip')) {
    try {
      const set = readGerberSet(await readZip(bytes));
      const layers = set.files.filter((f) => f.role !== 'ignored').length;
      return { role: 'gerbers', file, bytes, fact: `${layers} layer${layers === 1 ? '' : 's'}` };
    } catch {
      return `${file.name} is not a Gerber set.`;
    }
  }
  if (name.endsWith('.csv')) {
    const text = new TextDecoder().decode(bytes);
    const role: Role = isPlacement(text) ? 'cpl' : 'bom';
    const table = tableOf(text, role);
    return { role, file, bytes, header: table.header, mapping: detectColumns(table.header, role) as Record<string, string>, fact: `${table.rows.length} rows` };
  }
  return `${file.name}: not a board file.`;
}

interface BoardRead {
  source: BoardSource;
  derived: DerivedBoard;
  /** the top face, as SVG text (a `.kicad_pcb` only) */
  top?: string;
}

function readBoard(picked: Picked, db: Db): BoardRead | string {
  try {
    const source = readBoardFile(picked.file.name, picked.bytes);
    const derived = deriveBoard(source, { sha256: '0'.repeat(64) }, db);
    const art = kicadDepiction(source, derived.pcba.id, derived.pads, { path: picked.file.name, sha256: '0'.repeat(64) });
    return { source, derived, ...(art?.files['board-top.svg'] === undefined ? {} : { top: art.files['board-top.svg'] }) };
  } catch (error) {
    return `${picked.file.name} could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A part number that reads like one (no spaces): the title block's, else nothing. */
function pnOf(title: string | undefined): string {
  return title !== undefined && !/\s/.test(title) ? title : '';
}

function idFor(label: string, revision: string): string {
  return kebab(`${label}-${revision === '' ? '' : `rev-${revision}`}`).slice(0, 80).replace(/-$/, '') || 'board';
}

/** The designs that land on one of `terminals` of `board`. */
async function designsOnTerminals(boardId: string, terminals: readonly string[]): Promise<string[]> {
  if (terminals.length === 0) return [];
  const usage = await call('GET', `/api/definitions/pcbas/${encodeURIComponent(boardId)}/usage`);
  const designs = ((usage.body['designs'] as { id: string; label: string }[] | undefined) ?? []);
  const hit: string[] = [];
  const gone = new Set(terminals);
  for (const d of designs) {
    const answer = await call('GET', `/api/designs/${encodeURIComponent(d.id)}`);
    const design = ((answer.body['design'] as CableDesign | undefined) ?? (answer.body as unknown as CableDesign));
    const instances = new Set((design.instances?.pcbas ?? []).filter((p) => p.def === boardId).map((p) => p.id));
    let found = false;
    const walk = (value: unknown): void => {
      if (found || value === null || typeof value !== 'object') return;
      const ref = value as { instance?: unknown; terminal?: unknown };
      if (typeof ref.instance === 'string' && typeof ref.terminal === 'string' && instances.has(ref.instance) && gone.has(ref.terminal)) {
        found = true;
        return;
      }
      for (const v of Object.values(value)) walk(v);
    };
    walk(design);
    if (found) hit.push(d.label);
  }
  return hit;
}

function Chip(props: { picked: Picked; onRemove: () => void }): ReactElement {
  const { picked } = props;
  return h(
    'span',
    { className: 'cs-chip', 'data-testid': `board-import-file-${picked.role}`, style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
    h('span', { style: DIM }, ROLE_WORD[picked.role]),
    h('span', { style: { fontFamily: 'var(--font-mono)' } }, picked.file.name),
    picked.fact === undefined ? null : h('span', { style: DIM }, picked.fact),
    h('button', { type: 'button', 'aria-label': `Remove ${picked.file.name}`, onClick: props.onRemove, style: { border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'var(--dim)' } }, '×'),
  );
}

/** Column mapping for one CSV, collapsed: a select per field, prefilled with what was detected. */
function Columns(props: { picked: Picked; onChange: (mapping: Record<string, string>) => void }): ReactElement {
  const fields: readonly string[] = props.picked.role === 'bom' ? BOM_FIELDS : CPL_FIELDS;
  const mapping = props.picked.mapping ?? {};
  return h(
    'details',
    { 'data-testid': `board-import-${props.picked.role}-mapping` },
    h('summary', { style: DIM }, `${ROLE_WORD[props.picked.role]} columns`),
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6, marginTop: 6 } },
      ...fields.map((f) =>
        h(
          'label',
          { key: f, style: { display: 'grid', gap: 2, ...DIM } },
          f,
          h(
            'select',
            {
              ...INPUT,
              value: mapping[f] ?? '',
              'data-field': f,
              onChange: (e: { target: { value: string } }) => {
                const next = { ...mapping };
                if (e.target.value === '') delete next[f];
                else next[f] = e.target.value;
                props.onChange(next);
              },
            },
            h('option', { value: '' }, '—'),
            ...(props.picked.header ?? []).map((c) => h('option', { key: c, value: c }, c)),
          ),
        ),
      ),
    ),
  );
}

function Changes(props: { changes: TerminalChanges; before: PcbaDefinition; after: PcbaDefinition; dangling: string[] | undefined; anchored: ReadonlySet<string> | undefined }): ReactElement {
  const { changes } = props;
  // the board's art keeps renamed terminals' anchors; a removed terminal's anchor goes with it
  const lost = props.anchored === undefined ? 0 : changes.removed.filter((id) => props.anchored!.has(id)).length;
  const none = changes.added.length + changes.removed.length + changes.renamed.length === 0;
  const row = (label: string, items: string[], testId: string): ReactElement | null =>
    items.length === 0 ? null : h('div', { 'data-testid': testId }, h('span', { style: DIM }, `${label} `), h('span', { style: { fontFamily: 'var(--font-mono)' } }, items.join(', ')));
  return h(
    'div',
    { 'data-testid': 'board-import-changes', style: { display: 'grid', gap: 2 } },
    none ? h('div', { style: DIM }, 'Terminals unchanged') : null,
    row('Added', changes.added, 'board-import-added'),
    row('Removed', changes.removed, 'board-import-removed'),
    lost === 0 ? null : h('div', { 'data-testid': 'board-import-lost-anchors', style: { color: 'var(--warn)' }, title: 'Art anchors on the removed terminals are dropped; anchors on kept and renamed terminals stay' }, `${lost} art anchor${lost === 1 ? '' : 's'} dropped with them`),
    row('Renamed', changes.renamed.map(([a, b]) => `${a} → ${b}`), 'board-import-renamed'),
    h('div', { style: DIM }, `Links ${props.before.internalLinks.length} → ${props.after.internalLinks.length} · nets ${Object.keys(props.before.netlist?.terminals ?? {}).length} → ${Object.keys(props.after.netlist?.terminals ?? {}).length}`),
    props.dangling === undefined || props.dangling.length === 0
      ? null
      : h('div', { role: 'alert', 'data-testid': 'board-import-dangling', style: { color: 'var(--warn)' } }, `Designs that land on a removed or renamed terminal: ${props.dangling.join(', ')}`),
  );
}

export interface BoardImportPageProps extends RouteProps {
  /** where a published board opens (the browser's location by default) */
  open?: (href: string) => void;
}

export function BoardImportPage(props: BoardImportPageProps): ReactElement {
  const db = props.db;
  const updateId = useMemo(() => (typeof location === 'undefined' ? undefined : new URLSearchParams(location.search).get('update') ?? undefined), []);
  const target = updateId === undefined ? undefined : db.pcbas.find((p) => p.id === updateId);
  const [files, setFiles] = useState<Picked[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [fields, setFields] = useState({ label: '', partNumber: '', revision: '' });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ id: string; skipped: string[]; notes: string[] }>();
  const [dangling, setDangling] = useState<string[]>();
  // a board an installed pack owns is read-only here: Apply forks it to an id of your own and updates the copy
  const [owner, setOwner] = useState<{ pack: string; version: string }>();
  const [forked, setForked] = useState<string>();
  useEffect(() => {
    if (target === undefined) return;
    let live = true;
    void call('GET', '/api/definitions/pcbas').then((answer) => {
      const packs = answer.body['packs'] as Record<string, { pack: string; version: string }> | undefined;
      if (live && answer.ok) setOwner(packs?.[target.id]);
    });
    return () => {
      live = false;
    };
  }, [target?.id]);
  // the terminals the board's art anchors now: the preview says how many an update drops
  const [anchored, setAnchored] = useState<ReadonlySet<string>>();
  useEffect(() => {
    if (target === undefined) return;
    let live = true;
    void call('GET', `/api/depictions/${encodeURIComponent(target.id)}`).then((answer) => {
      const anchors = answer.body['pinAnchors'] as Record<string, unknown> | undefined;
      if (live && answer.ok) setAnchored(new Set(Object.keys(anchors ?? {})));
    });
    return () => {
      live = false;
    };
  }, [target?.id]);
  const copyId = useMemo(() => {
    if (target === undefined) return undefined;
    const taken = new Set(db.pcbas.map((p) => p.id));
    let next = `${target.id}-local`;
    for (let n = 2; taken.has(next); n++) next = `${target.id}-local-${n}`;
    return next;
  }, [target?.id, db.pcbas]);

  // `&source=stored`: start from the board file this hub keeps for the board
  const fromStored = useMemo(() => (typeof location === 'undefined' ? false : new URLSearchParams(location.search).get('source') === 'stored'), []);
  useEffect(() => {
    if (!fromStored || target === undefined) return;
    let live = true;
    void (async () => {
      const outputs = await call('GET', `/api/tool-outputs/pcbas/${encodeURIComponent(target.id)}`);
      const path = (outputs.body['source'] as { stored?: { path: string } } | undefined)?.stored?.path;
      const doc = path === undefined ? undefined : await call('GET', `/api/docs/${path}`);
      const text = doc?.ok === true ? (doc.body as unknown) : undefined;
      if (!live) return;
      if (typeof text !== 'string') {
        setRejected(['No board file is stored for this board; drop its .kicad_pcb.']);
        return;
      }
      const bytes = new TextEncoder().encode(text);
      const name = `${target.kicadProject ?? target.id}.kicad_pcb`;
      setFiles([{ role: 'board', file: new File([bytes], name), bytes }]);
    })();
    return () => {
      live = false;
    };
  }, [fromStored, target?.id]);

  const board = files.find((f) => f.role === 'board');
  const read = useMemo(() => (board === undefined ? undefined : readBoard(board, db)), [board, db]);
  const ok = read !== undefined && typeof read !== 'string' ? read : undefined;

  // prefill from the title block: a name, a part number only when the title reads like one, the revision
  useEffect(() => {
    if (ok === undefined || target !== undefined) return;
    setFields({ label: ok.derived.pcba.label, partNumber: pnOf(ok.source.title), revision: ok.source.revision ?? '' });
  }, [ok, target]);

  const refreshed = ok === undefined || target === undefined ? undefined : refreshedBoard(target, { ...ok.derived.pcba, id: target.id });
  const changes = refreshed === undefined || target === undefined ? undefined : terminalChanges(target.terminals, refreshed.terminals);
  useEffect(() => {
    setDangling(undefined);
    if (changes === undefined || target === undefined) return;
    const gone = [...changes.removed, ...changes.renamed.map(([from]) => from)];
    let live = true;
    void designsOnTerminals(target.id, gone).then((list) => live && setDangling(list));
    return () => {
      live = false;
    };
  }, [changes?.removed.join(','), changes?.renamed.join(','), target?.id]);

  const id = target?.id ?? idFor(fields.label.trim(), fields.revision.trim());
  const taken = target === undefined ? db.pcbas.find((p) => p.id === id) : undefined;
  const sameNumber = target === undefined && fields.partNumber.trim() !== '' ? db.pcbas.find((p) => p.partNumber === fields.partNumber.trim() && p.revision === (fields.revision.trim() || 'unrevised')) : undefined;
  const hasParts = files.some((f) => f.role === 'bom' || f.role === 'cpl');
  const needsPn = target === undefined && hasParts && fields.partNumber.trim() === '';
  const blocked = ok === undefined || busy !== undefined || taken !== undefined || needsPn || (target === undefined && fields.label.trim() === '');

  const add = async (list: File[]): Promise<void> => {
    setError(undefined);
    const bad: string[] = [];
    let next = [...files];
    for (const file of list) {
      const picked = await pickFile(file);
      if (typeof picked === 'string') bad.push(picked);
      else if (target !== undefined && picked.role !== 'board') bad.push(`${file.name}: an update takes the board file only.`);
      else next = [...next.filter((f) => f.role !== picked.role), picked];
    }
    setRejected(bad);
    setFiles(next);
  };

  const publish = async (): Promise<void> => {
    if (board === undefined) return;
    setError(undefined);
    // the record the import writes: the board, or (pack-owned) the copy forked for it first, so no job fails on a read-only record
    let dest = id;
    if (target !== undefined && owner !== undefined && copyId !== undefined) {
      dest = forked ?? copyId;
      if (forked === undefined) {
        setBusy('Forking…');
        const fork = await call('POST', `/api/definitions/pcbas/${encodeURIComponent(target.id)}/fork`, { id: copyId });
        if (!fork.ok) {
          setBusy(undefined);
          setError(words(fork));
          return;
        }
        setForked(copyId);
      }
    }
    setBusy(target === undefined ? 'Reading…' : 'Applying…');
    const of = (role: Role): Picked | undefined => files.find((f) => f.role === role);
    const text = (p: Picked | undefined): { fileName: string; text: string } | undefined => (p === undefined ? undefined : { fileName: p.file.name, text: new TextDecoder().decode(p.bytes) });
    const gerbers = of('gerbers');
    const bom = text(of('bom'));
    const cpl = text(of('cpl'));
    const bundle: BoardSetBundle = {
      format: BOARD_SET_FORMAT,
      version: 1,
      board: { fileName: board.file.name, base64: base64Of(board.bytes) },
      ...(gerbers === undefined ? {} : { gerbers: { fileName: gerbers.file.name, base64: base64Of(gerbers.bytes) } }),
      ...(bom === undefined ? {} : { bom }),
      ...(cpl === undefined ? {} : { cpl }),
    };
    const mapping = { ...(of('bom') === undefined ? {} : { bom: of('bom')!.mapping }), ...(of('cpl') === undefined ? {} : { cpl: of('cpl')!.mapping }) };
    const options: Record<string, string> =
      target !== undefined
        ? { update: dest }
        : { id, label: fields.label.trim(), partNumber: fields.partNumber.trim(), ...(fields.revision.trim() === '' ? {} : { revision: fields.revision.trim() }), ...(hasParts ? { mapping: JSON.stringify(mapping) } : {}) };
    const name = `${board.file.name.replace(/\.[^.]+$/, '')}.board-set.json`;
    const started = await call('POST', `/api/modules/${MODULE_ID}/_import/board-set`, { fileName: name, base64: base64Of(new TextEncoder().encode(JSON.stringify(bundle))), job: true, options });
    if (!started.ok) {
      setBusy(undefined);
      setError(words(started));
      return;
    }
    let job = started.body['job'] as JobView;
    while (!['done', 'failed', 'cancelled'].includes(job.status)) {
      await sleep(700);
      const polled = await call('GET', `/api/jobs/${encodeURIComponent(job.id)}`);
      if (polled.ok) job = polled.body['job'] as JobView;
    }
    if (job.status !== 'done') {
      setBusy(undefined);
      setError(job.error ?? 'The import stopped.');
      return;
    }
    setBusy('Publishing…');
    const published = await call('POST', `/api/jobs/${encodeURIComponent(job.id)}/publish`, {});
    if (!published.ok) {
      setBusy(undefined);
      setError(words(published));
      return;
    }
    // the board file is the board's 3D model source too
    if (board.file.name.toLowerCase().endsWith('.kicad_pcb')) {
      setBusy('Attaching the 3D model…');
      await call('POST', `/api/models/pcbas/${encodeURIComponent(dest)}/upload`, { name: board.file.name, data: base64Of(board.bytes) }, { 'if-match': '*' });
    }
    setBusy(undefined);
    const proposal = job.result?.proposal;
    const skipped = proposal?.skipped ?? [];
    const href = recordHref(`pcbas/${dest}`)!;
    if (skipped.length === 0) (props.open ?? ((to: string) => location.assign(to)))(href);
    setDone({ id: dest, skipped, notes: proposal?.notes ?? [] });
  };

  const field = (key: keyof typeof fields, label: string, extra: Record<string, unknown> = {}): ReactElement =>
    h(
      'label',
      { key, style: { display: 'grid', gap: 2, ...DIM } },
      label,
      h('input', { ...INPUT, ...extra, value: fields[key], 'data-testid': `board-import-${key}`, onChange: (e: { target: { value: string } }) => setFields({ ...fields, [key]: e.target.value }) }),
    );

  const accept = target === undefined ? '.kicad_pcb,.net,.zip,.csv' : '.kicad_pcb,.net';
  return h(
    'div',
    { 'data-testid': 'board-import-page', style: { display: 'grid', gap: 10, padding: '10px 16px', maxWidth: 880 } },
    target === undefined
      ? null
      : h('h2', { style: { margin: 0, fontSize: 'var(--fs-md)', fontWeight: 600 } }, 'Update ', h('a', { href: recordHref(`pcbas/${target.id}`) }, target.label), ' from file'),
    updateId !== undefined && target === undefined ? h('p', { role: 'alert' }, `There is no board '${updateId}'.`) : null,
    target === undefined || owner === undefined
      ? null
      : h(
          'p',
          { 'data-testid': 'board-import-pack-owned', style: { ...DIM, margin: 0 }, title: `Records an installed pack ships are read-only here; a pack update would replace an edit. The copy remembers it came from ${owner.pack} ${owner.version}.` },
          `From the ${owner.pack} pack, read-only here: Fork and apply updates a copy of your own (${forked ?? copyId}).`,
        ),
    h(
      'label',
      {
        className: 'cs-ui-filedrop',
        'data-testid': 'board-import-drop',
        style: { minHeight: 72, width: '100%', boxSizing: 'border-box' },
        onDragOver: (e: { preventDefault: () => void }) => e.preventDefault(),
        onDrop: (e: { preventDefault: () => void; dataTransfer: { files: FileList } }) => {
          e.preventDefault();
          void add(Array.from(e.dataTransfer.files));
        },
      },
      h('span', null, target === undefined ? 'Drop the .kicad_pcb, plus Gerber .zip, BOM and placement .csv if you have them' : 'Drop the new .kicad_pcb'),
      h('input', {
        type: 'file',
        multiple: target === undefined,
        accept,
        className: 'cs-ui-sr',
        'data-testid': 'board-import-input',
        onChange: (e: { target: { files: FileList | null; value: string } }) => {
          void add(Array.from(e.target.files ?? []));
          e.target.value = '';
        },
      }),
    ),
    files.length === 0 ? null : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, ...files.map((f) => h(Chip, { key: f.role, picked: f, onRemove: () => setFiles(files.filter((x) => x !== f)) }))),
    rejected.length === 0 ? null : h('p', { role: 'alert', style: { margin: 0, color: 'var(--err)' } }, rejected.join(' ')),
    typeof read === 'string' ? h('p', { role: 'alert', style: { margin: 0, color: 'var(--err)' } }, read) : null,
    ok === undefined
      ? null
      : h(
          'section',
          { 'data-testid': 'board-import-preview', style: { display: 'flex', gap: 16, alignItems: 'flex-start', borderTop: '1px solid var(--line)', paddingTop: 10 } },
          ok.top === undefined
            ? null
            : h('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ok.top)}`, alt: 'Board outline', style: { width: 200, maxHeight: 140, objectFit: 'contain', background: 'var(--paper)', borderRadius: 'var(--r-sm)' } }),
          h(
            'div',
            { style: { display: 'grid', gap: 8, flex: 1 } },
            h(
              'div',
              { 'data-testid': 'board-import-counts', style: DIM },
              `${ok.derived.pcba.terminals.length} terminals · ${ok.source.footprints.length} parts · ${ok.derived.pcba.internalLinks.length} links`,
            ),
            target === undefined
              ? h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: '2fr 1fr 80px', gap: 8 } },
                  field('label', 'Name'),
                  field('partNumber', 'Part number', needsPn ? { placeholder: 'needed for the BOM', 'aria-invalid': true } : {}),
                  field('revision', 'Rev'),
                )
              : h(Changes, { changes: changes!, before: target, after: refreshed!, dangling, anchored }),
            taken === undefined ? null : h('div', { role: 'alert', 'data-testid': 'board-import-taken' }, 'Already in the Library: ', h('a', { href: recordHref(`pcbas/${taken.id}`) }, taken.label), ' · ', h('a', { href: `?update=${encodeURIComponent(taken.id)}`, 'data-testid': 'board-import-update-instead' }, 'update it from this file')),
            sameNumber === undefined ? null : h('div', { style: { color: 'var(--warn)' } }, `${sameNumber.partNumber} ${sameNumber.revision} is already `, h('a', { href: recordHref(`pcbas/${sameNumber.id}`) }, sameNumber.label)),
          ),
        ),
    ...files.filter((f) => f.role === 'bom' || f.role === 'cpl').map((f) => h(Columns, { key: f.role, picked: f, onChange: (mapping) => setFiles(files.map((x) => (x === f ? { ...x, mapping } : x))) })),
    done !== undefined
      ? null
      : h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'center' } },
          h('button', { ...BUTTON(true), type: 'button', disabled: blocked, onClick: () => void publish(), 'data-testid': 'board-import-publish' }, target === undefined ? 'Publish' : owner === undefined ? 'Apply' : 'Fork and apply'),
          busy === undefined ? null : h('span', { role: 'status', style: DIM }, busy),
        ),
    error === undefined ? null : h('div', { role: 'alert', 'data-testid': 'board-import-error', style: { color: 'var(--err)', whiteSpace: 'pre-line' } }, ...linked(error, db)),
    done === undefined
      ? null
      : h(
          'div',
          { 'data-testid': 'board-import-done', style: { display: 'grid', gap: 6 } },
          h('div', null, 'Published · ', h('a', { href: recordHref(`pcbas/${done.id}`), 'data-testid': 'board-import-open' }, 'open the board')),
          done.skipped.length === 0
            ? null
            : h('details', { 'data-testid': 'board-import-skipped' }, h('summary', null, `Skipped ${done.skipped.length} art anchor${done.skipped.length === 1 ? '' : 's'}`), h('div', { style: { ...DIM, fontFamily: 'var(--font-mono)' } }, done.skipped.map((s) => s.split(': ').pop()).join(', '))),
        ),
  );
}
