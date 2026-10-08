/**
 * The module's page, `/m/board-import/boards`: the review step for the three
 * importers. Pick the file (and, for a Gerber set or a BOM, the board), set
 * what the file cannot say (a revision, a column mapping), start the import as
 * a job, read its proposal and plan — the SVG art is previewed — and publish
 * it. After a KiCad board is published its `.kicad_pcb` can be attached as
 * the board's 3D model source (the server builds it with the KiCad library
 * models in a model-cache job).
 *
 * The same importers are offered by the Library's Import… button, without
 * the options. Written with `createElement` (no JSX): the server imports
 * this file through Node's type stripping.
 */

import type { PcbaDefinition } from '@wirehub/model';
import type { RouteProps } from '@wirehub/modules';
import { createElement as h, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';

import { BOM_FIELDS, CPL_FIELDS, detectColumns, isPlacement, tableOf, type BomField, type CplField } from './bom.ts';
import { BOARD_BOM_FORMAT } from './importers.ts';

export const MODULE_ID = 'board-import';

type Importer = 'kicad-board' | 'gerbers' | 'fab-bom';

interface JobView {
  id: string;
  status: string;
  error?: string;
  steps?: { text: string }[];
  result?: { notes?: string[]; proposal?: Proposal; changes?: number };
  publishedVersion?: string;
}

interface Proposal {
  definitions: Record<string, { id: string; label: string }[]>;
  existing: string[];
  boardParts?: string[];
  depictions?: string[];
  notes: string[];
}

interface PlanFile {
  path: string;
  status: string;
  content?: string;
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
  const error = typeof answer.body['error'] === 'string' ? answer.body['error'] : `That failed (HTTP ${answer.status}).`;
  const hint = typeof answer.body['hint'] === 'string' ? ` ${answer.body['hint']}` : '';
  return `${error}${hint}`;
}

export function base64Of(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function field(label: string, control: ReactNode, key?: string): ReactElement {
  return h('label', { key, style: { display: 'grid', gap: 4, fontSize: 13 } }, h('span', null, label), control);
}

function BoardSelect(props: { boards: readonly PcbaDefinition[]; value: string; onChange: (id: string) => void; testId: string }): ReactElement {
  return h(
    'select',
    { value: props.value, onChange: (e: { target: { value: string } }) => props.onChange(e.target.value), 'data-testid': props.testId },
    h('option', { value: '' }, 'Match by file name'),
    ...props.boards.map((b) => h('option', { key: b.id, value: b.id }, `${b.label} (${b.partNumber} ${b.revision})`)),
  );
}

/** Column mapping for one CSV: a select per field, prefilled with what was detected. */
function Mapping<F extends string>(props: { fields: readonly F[]; header: readonly string[]; value: Partial<Record<F, string>>; onChange: (next: Partial<Record<F, string>>) => void; testId: string }): ReactElement {
  return h(
    'div',
    { 'data-testid': props.testId, style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 } },
    ...props.fields.map((f) =>
      field(
        f,
        h(
          'select',
          {
            value: props.value[f] ?? '',
            'data-field': f,
            onChange: (e: { target: { value: string } }) => {
              const next = { ...props.value };
              if (e.target.value === '') delete next[f];
              else next[f] = e.target.value;
              props.onChange(next);
            },
          },
          h('option', { value: '' }, '(none)'),
          ...props.header.map((c) => h('option', { key: c, value: c }, c)),
        ),
        f,
      ),
    ),
  );
}

interface Started {
  importer: Importer;
  fileName: string;
  /** the board file, kept for "attach its 3D model" */
  boardFile?: { name: string; base64: string };
}

function JobPanel(props: { job: JobView | undefined; files: PlanFile[]; started: Started | undefined; message: string | undefined; onPublish: () => void; onAttach: () => void; publishing: boolean }): ReactElement | null {
  const { job } = props;
  if (job === undefined) return props.message === undefined ? null : h('p', { role: 'status', 'data-testid': 'board-import-message' }, props.message);
  const proposal = job.result?.proposal;
  const created = proposal === undefined ? [] : Object.entries(proposal.definitions).flatMap(([kind, list]) => list.map((r) => `${kind}/${r.id} — ${r.label}`));
  const art = props.files.filter((f) => f.path.endsWith('.svg') && f.content !== undefined);
  const pcbaId = proposal?.definitions['pcbas']?.[0]?.id ?? proposal?.existing.find((e) => e.startsWith('pcbas/'))?.slice('pcbas/'.length);
  return h(
    'section',
    { 'data-testid': 'board-import-job', style: { border: '1px solid var(--cs-border, #ccc)', borderRadius: 6, padding: 12, display: 'grid', gap: 8 } },
    h('strong', null, `Import ${props.started?.fileName ?? ''}: ${job.status}${job.publishedVersion === undefined ? '' : ', published'}`),
    job.error === undefined ? null : h('p', { role: 'alert' }, job.error),
    (job.result?.notes ?? []).length === 0 ? null : h('ul', null, ...(job.result?.notes ?? []).map((note, i) => h('li', { key: i }, note))),
    created.length === 0 ? null : h('div', null, h('em', null, 'New records'), h('ul', null, ...created.map((c) => h('li', { key: c }, c)))),
    (proposal?.boardParts ?? []).length === 0 ? null : h('div', null, `Placed parts for ${proposal!.boardParts!.join(', ')}`),
    (proposal?.depictions ?? []).length === 0 ? null : h('div', null, `Board art for ${proposal!.depictions!.join(', ')}`),
    (proposal?.existing ?? []).length === 0 ? null : h('div', null, `Already in the Library (kept): ${proposal!.existing.join(', ')}`),
    props.files.length === 0 ? null : h('div', null, h('em', null, 'Plan'), h('ul', null, ...props.files.map((f) => h('li', { key: f.path }, `${f.status} ${f.path}`)))),
    art.length === 0
      ? null
      : h(
          'div',
          { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          ...art.map((f) => h('figure', { key: f.path, style: { margin: 0 } }, h('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(f.content!)}`, alt: f.path, style: { maxWidth: 320, maxHeight: 240, background: '#fff' } }), h('figcaption', null, f.path.split('/').pop()))),
        ),
    job.status === 'done' && job.publishedVersion === undefined ? h('button', { type: 'button', onClick: props.onPublish, disabled: props.publishing, 'data-testid': 'board-import-publish' }, props.publishing ? 'Publishing…' : 'Publish') : null,
    job.publishedVersion !== undefined && props.started?.boardFile !== undefined && pcbaId !== undefined
      ? h('button', { type: 'button', onClick: props.onAttach, 'data-testid': 'board-import-attach-model' }, `Attach ${props.started.boardFile.name} as ${pcbaId}'s 3D model`)
      : null,
    props.message === undefined ? null : h('p', { role: 'status' }, props.message),
  );
}

export function BoardImportPage(props: RouteProps): ReactElement {
  const boards = useMemo(() => [...props.db.pcbas].sort((a, b) => (a.label < b.label ? -1 : 1)), [props.db.pcbas]);
  const [kicadFile, setKicadFile] = useState<File>();
  const [kicad, setKicad] = useState({ id: '', partNumber: '', revision: '' });
  const [kicadParts, setKicadParts] = useState(false);
  const [gerberFile, setGerberFile] = useState<File>();
  const [gerberBoard, setGerberBoard] = useState('');
  const [bomBoard, setBomBoard] = useState('');
  const [bom, setBom] = useState<{ file: File; text: string; header: string[]; mapping: Partial<Record<BomField, string>> }>();
  const [cpl, setCpl] = useState<{ file: File; text: string; header: string[]; mapping: Partial<Record<CplField, string>> }>();
  const [started, setStarted] = useState<Started>();
  const [job, setJob] = useState<JobView>();
  const [files, setFiles] = useState<PlanFile[]>([]);
  const [message, setMessage] = useState<string>();
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (job === undefined || ['done', 'failed', 'cancelled'].includes(job.status)) return;
    const timer = setInterval(() => {
      void call('GET', `/api/jobs/${encodeURIComponent(job.id)}`).then((answer) => {
        if (!answer.ok) return;
        setJob(answer.body['job'] as JobView);
        setFiles((answer.body['files'] as PlanFile[] | undefined) ?? []);
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);

  const start = async (importer: Importer, fileName: string, bytes: Uint8Array, options: Record<string, string>, boardFile?: Started['boardFile']): Promise<void> => {
    setJob(undefined);
    setFiles([]);
    setMessage(`Reading ${fileName}…`);
    setStarted({ importer, fileName, ...(boardFile === undefined ? {} : { boardFile }) });
    const answer = await call('POST', `/api/modules/${MODULE_ID}/_import/${importer}`, { fileName, base64: base64Of(bytes), job: true, ...(Object.keys(options).length === 0 ? {} : { options }) });
    if (!answer.ok) {
      setMessage(words(answer));
      return;
    }
    setMessage(undefined);
    setJob(answer.body['job'] as JobView);
  };

  const startKicad = async (): Promise<void> => {
    if (kicadFile === undefined) return;
    const bytes = await bytesOf(kicadFile);
    const options: Record<string, string> = Object.fromEntries(Object.entries(kicad).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
    if (kicadParts) options['parts'] = 'yes';
    const isBoard = kicadFile.name.toLowerCase().endsWith('.kicad_pcb');
    await start('kicad-board', kicadFile.name, bytes, options, isBoard ? { name: kicadFile.name, base64: base64Of(bytes) } : undefined);
  };
  const startGerbers = async (): Promise<void> => {
    if (gerberFile === undefined) return;
    await start('gerbers', gerberFile.name, await bytesOf(gerberFile), gerberBoard === '' ? {} : { board: gerberBoard });
  };
  const startBom = async (): Promise<void> => {
    if (bom === undefined && cpl === undefined) return;
    const bundle = {
      format: BOARD_BOM_FORMAT,
      version: 1,
      ...(bom === undefined ? {} : { bom: { fileName: bom.file.name, text: bom.text } }),
      ...(cpl === undefined ? {} : { cpl: { fileName: cpl.file.name, text: cpl.text } }),
    };
    const name = `${(bom ?? cpl)!.file.name.replace(/\.[^.]+$/, '')}.board-bom.json`;
    const options: Record<string, string> = { mapping: JSON.stringify({ ...(bom === undefined ? {} : { bom: bom.mapping }), ...(cpl === undefined ? {} : { cpl: cpl.mapping }) }) };
    if (bomBoard !== '') options['board'] = bomBoard;
    await start('fab-bom', name, new TextEncoder().encode(JSON.stringify(bundle)), options);
  };
  const pickCsv = async (file: File | undefined, kind: 'bom' | 'cpl'): Promise<void> => {
    if (file === undefined) {
      if (kind === 'bom') setBom(undefined);
      else setCpl(undefined);
      return;
    }
    const text = new TextDecoder().decode(await bytesOf(file));
    const { header } = tableOf(text, kind);
    if (kind === 'bom') setBom({ file, text, header, mapping: detectColumns<BomField>(header, 'bom') });
    else setCpl({ file, text, header, mapping: detectColumns<CplField>(header, 'cpl') });
    if (kind === 'bom' && isPlacement(text)) setMessage(`${file.name} looks like a placement file; put it in the placement box.`);
  };
  const publish = async (): Promise<void> => {
    if (job === undefined) return;
    setPublishing(true);
    const answer = await call('POST', `/api/jobs/${encodeURIComponent(job.id)}/publish`, {});
    setPublishing(false);
    if (!answer.ok) {
      setMessage(words(answer));
      return;
    }
    setJob(answer.body['job'] as JobView);
    setMessage(answer.body['committed'] === false ? String(answer.body['hint'] ?? 'Nothing to change.') : 'Published.');
  };
  const attach = async (): Promise<void> => {
    const board = started?.boardFile;
    const pcbaId = job?.result?.proposal?.definitions['pcbas']?.[0]?.id ?? job?.result?.proposal?.existing.find((e) => e.startsWith('pcbas/'))?.slice('pcbas/'.length);
    if (board === undefined || pcbaId === undefined) return;
    const answer = await call('POST', `/api/models/pcbas/${encodeURIComponent(pcbaId)}/upload`, { name: board.name, data: board.base64 }, { 'if-match': '*' });
    setMessage(answer.ok ? `Linked: ${pcbaId}'s 3D model is built by the model-cache job; open the board in the Library to see it.` : words(answer));
  };

  const card = (title: string, testId: string, ...body: ReactNode[]): ReactElement =>
    h('section', { 'data-testid': testId, style: { border: '1px solid var(--cs-border, #ccc)', borderRadius: 6, padding: 12, display: 'grid', gap: 8 } }, h('h3', { style: { margin: 0 } }, title), ...body);

  return h(
    'div',
    { 'data-testid': 'board-import-page', style: { display: 'grid', gap: 16, padding: 16, maxWidth: 960 } },
    h('h2', { style: { margin: 0 } }, 'Board import'),
    h('p', { style: { margin: 0 } }, 'Bring a board in from its open fabrication files: the KiCad board first (it makes the board and its pads), then its Gerbers (the art) and its BOM and placement files (the parts on it). Each import is a plan you read before it is published.'),
    card(
      'KiCad board or netlist → board',
      'board-import-kicad',
      field('File (.kicad_pcb or .net)', h('input', { type: 'file', accept: '.kicad_pcb,.net', 'data-testid': 'board-import-kicad-file', onChange: (e: { target: { files: FileList | null } }) => setKicadFile(e.target.files?.[0] ?? undefined) })),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 } },
        ...(['id', 'partNumber', 'revision'] as const).map((k) =>
          field(k === 'id' ? 'Board id (optional)' : k === 'partNumber' ? 'Part number (optional)' : 'Revision (optional)', h('input', { value: kicad[k], 'data-testid': `board-import-kicad-${k}`, onChange: (e: { target: { value: string } }) => setKicad({ ...kicad, [k]: e.target.value }) }), k),
        ),
      ),
      h(
        'label',
        { style: { display: 'flex', gap: 6, alignItems: 'center' }, title: 'For a board with no fab BOM: one component per distinct footprint part (by MPN, else category, value and package) and the parts placed on the board.' },
        h('input', { type: 'checkbox', checked: kicadParts, 'data-testid': 'board-import-kicad-parts', onChange: (e: { target: { checked: boolean } }) => setKicadParts(e.target.checked) }),
        'Also propose components and placed parts from the footprints',
      ),
      h('button', { type: 'button', disabled: kicadFile === undefined, onClick: () => void startKicad(), 'data-testid': 'board-import-kicad-start' }, 'Read the board'),
    ),
    card(
      'Gerber set → board art',
      'board-import-gerbers',
      field('Board', h(BoardSelect, { boards, value: gerberBoard, onChange: setGerberBoard, testId: 'board-import-gerber-board' })),
      field('Gerber set (.zip)', h('input', { type: 'file', accept: '.zip', 'data-testid': 'board-import-gerber-file', onChange: (e: { target: { files: FileList | null } }) => setGerberFile(e.target.files?.[0] ?? undefined) })),
      h('button', { type: 'button', disabled: gerberFile === undefined, onClick: () => void startGerbers(), 'data-testid': 'board-import-gerber-start' }, 'Render the art'),
    ),
    card(
      'Fab BOM and placement → parts on the board',
      'board-import-bom',
      field('Board', h(BoardSelect, { boards, value: bomBoard, onChange: setBomBoard, testId: 'board-import-bom-board' })),
      field('BOM (.csv)', h('input', { type: 'file', accept: '.csv', 'data-testid': 'board-import-bom-file', onChange: (e: { target: { files: FileList | null } }) => void pickCsv(e.target.files?.[0] ?? undefined, 'bom') })),
      bom === undefined ? null : h(Mapping<BomField>, { fields: BOM_FIELDS, header: bom.header, value: bom.mapping, onChange: (mapping) => setBom({ ...bom, mapping }), testId: 'board-import-bom-mapping' }),
      field('Placement / CPL (.csv, optional)', h('input', { type: 'file', accept: '.csv', 'data-testid': 'board-import-cpl-file', onChange: (e: { target: { files: FileList | null } }) => void pickCsv(e.target.files?.[0] ?? undefined, 'cpl') })),
      cpl === undefined ? null : h(Mapping<CplField>, { fields: CPL_FIELDS, header: cpl.header, value: cpl.mapping, onChange: (mapping) => setCpl({ ...cpl, mapping }), testId: 'board-import-cpl-mapping' }),
      h('button', { type: 'button', disabled: bom === undefined && cpl === undefined, onClick: () => void startBom(), 'data-testid': 'board-import-bom-start' }, 'Read the parts'),
    ),
    h(JobPanel, { job, files, started, message, onPublish: () => void publish(), onAttach: () => void attach(), publishing }),
  );
}
