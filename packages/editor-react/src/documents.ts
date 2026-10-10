/**
 * The Documents view's logic, with no React in it.
 *
 * The editor's second job. The canvas answers "what is this cable?"; the
 * documents answer "how do I build it, what do I buy, and what should the meter
 * read?" — and a non-technical user must be able to get all three without a
 * terminal (`specs/studio-workbench.md`). They are the same four artifacts the
 * CLI emits, from the same derivations: this file computes nothing itself, it
 * only chooses which `@wirehub/docs` renderer to call and how to describe
 * the result in words a bench can act on.
 *
 * Two rules the pane depends on:
 *
 * - **A document is derived, never stored.** It is a pure function of the open
 *   design and the definition library, so it can be thrown away and rebuilt
 *   whenever either changes — which is exactly what the pane does, debounced.
 * - **Rendering never throws.** A derivation that fails comes back as
 *   `{ error }` with the message, the way `renderPreview` already does, because
 *   a screen that dead-ends is the one thing the workbench spec forbids.
 *
 * Artwork comes in from the host as a `DepictionSource`, and the default is
 * `false` — abstract blocks. The catalog's own tree needs a filesystem, and the
 * host that mounts this pane is usually a browser.
 */

import { errors, validateDesign, type CableDesign, type Db, type Issue, type KnownPartNumber, type PartNumberScheme } from '@wirehub/model';
import type { Outcome } from './persistence.ts';
import {
  deriveTestSpec,
  deriveLabels, labelSheetSvg, labelSheetPages, labelPresetFor, type LabelSheetOptions,
  resolveTestParameters,
  sheetRenderOptions,
  baseExport,
  type FormatOptions,
  type FormatOutput,
  type TestParameters,
  testSpecToMarkdown,
  renderBomMarkdown,
  renderBomSheet,
  renderBuildSheet,
  renderDrawingSheet,
  renderTestSpecSheet,
  deriveFormboard,
  formboardHtml,
  sheetFrameFor,
  type BuildSheetOptions,
  type PaperId,
  type RevisionRow,
  type DocumentFacts,
  type DocumentIdentity,
  type DrawingMeta,
  type LengthVariant,
  type SheetSettings,
} from '@wirehub/docs';
import type { DepictionSource } from '@wirehub/render-svg';

/* ------------------------------------------------------------------ *
 * The three documents
 * ------------------------------------------------------------------ */

export type DocumentKind = 'build-sheet' | 'bom' | 'test-spec' | 'drawing' | 'formboard' | 'labels';

/** Sub-view order, most-used first — the bench opens the build sheet. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = ['build-sheet', 'bom', 'test-spec', 'drawing', 'formboard', 'labels'];

export const DOCUMENT_LABELS: Readonly<Record<DocumentKind, string>> = {
  'build-sheet': 'Build sheet',
  bom: 'BOM',
  'test-spec': 'Continuity spec',
  drawing: 'Drawing sheet',
  formboard: 'Formboard',
  labels: 'Wire labels',
};

/** One plain sentence per document, for someone who has not met them before. */
export const DOCUMENT_BLURBS: Readonly<Record<DocumentKind, string>> = {
  'build-sheet': 'The bench flow, one page per stage: kit & cut, each end with its board and numbered landings, assembly, test.',
  bom: 'The design’s part number, then its parts by section, each with its part number.',
  'test-spec': 'What the meter should read when the design is finished, including the opens that are meant to be open.',
  drawing:
    'The engineering drawing (landscape, on the sheet’s paper): title block, revision table, BOM, connector faces coloured by conductor, the wire table and remarks. Part number, revision and the other title-block facts are edited above the sheet.',
  formboard:
    'The design laid flat at true length for the board: runs, branch angles, pegs at the ends and breakouts, connectors, labels. An overview sheet, then pages tiled at the chosen scale with registration marks.',
  labels: 'Wire markers for each end of each run, on the stock chosen for this print.',
};

export interface DocumentOptions {
  /** Local print options; absent fields follow the hub defaults. */
  labels?: LabelSheetOptions;
  /**
   * `false` (default) abstract blocks · `true` the catalog tree (Node only) ·
   * a source: that source. Only the build sheet has a drawing on it.
   */
  depictions?: boolean | DepictionSource;
  paper?: PaperId;
  /** printed in the title block verbatim; omitted keeps the output deterministic */
  generatedAt?: string;
  /** the drawing sheet's sidecar: title-block facts and an optional photo */
  drawing?: DrawingSidecar;
  /** the build sheet / BOM / continuity spec's document number, revision and status */
  document?: DocumentIdentity;
  /** the numbering scheme and the numbers in use: an unmapped part carries the scheme's proposal */
  partNumbers?: { scheme: PartNumberScheme; known: readonly KnownPartNumber[] };
  /** the host's short names for the title block (destination, sync, stock) */
  facts?: DocumentFacts;
  /** a length family's suffix: print the build sheet and BOM for that one variation */
  variation?: string;
  /** the saved revision being printed */
  revisionNumber?: number;
  /** the drawing's revision table (the saved revisions, oldest first) */
  revisions?: readonly RevisionRow[];
  /** formboard: paper millimetres per board millimetre (1 is 1:1) */
  scale?: number;
  /** cables in the build: the BOM's quantity breaks are read at this (default 1) */
  buildQty?: number;
  /** the design's continuity test parameters (the drawing sidecar's `test`) */
  testParameters?: TestParameters;
  /** the organisation's defaults under them */
  testDefaults?: TestParameters;
}

/** The build sheet's and BOM's options from the pane's (sidecar meta, part numbers, facts). */
function benchInput(options: DocumentOptions): Record<string, unknown> {
  return {
    ...(options.drawing?.meta === undefined ? {} : { drawing: options.drawing.meta }),
    ...(options.partNumbers === undefined ? {} : { partNumbers: options.partNumbers }),
    ...(options.facts === undefined ? {} : { facts: options.facts }),
    ...(options.variation === undefined ? {} : { variation: options.variation }),
    ...(options.revisionNumber === undefined ? {} : { revisionNumber: options.revisionNumber }),
    ...(options.buildQty === undefined ? {} : { buildQty: options.buildQty }),
    ...(options.testDefaults === undefined ? {} : { testDefaults: options.testDefaults }),
  };
}

export { sheetRenderOptions };

export type DocumentResult = { html: string; pageSize?: { width: number; height: number } } | { error: string };

/**
 * Render one document as a **complete standalone HTML document** — doctype,
 * `@page`, its own stylesheet — because that is what an `<iframe srcdoc>` and
 * the browser's print dialog both want. Nothing here reaches for the network or
 * the filesystem; the bytes are self-contained by the docs package's own rules.
 */
export function renderDocument(
  kind: DocumentKind,
  design: CableDesign,
  db: Db,
  options: DocumentOptions = {},
): DocumentResult {
  const shared = {
    ...(options.paper === undefined ? {} : { paper: options.paper }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    ...(options.document === undefined ? {} : { document: options.document }),
  };
  try {
    switch (kind) {
      case 'build-sheet':
        return {
          html: renderBuildSheet(design, db, { ...shared, ...benchInput(options), depictions: options.depictions ?? false }),
        };
      case 'bom':
        return { html: renderBomSheet(design, db, { ...shared, ...benchInput(options), depictions: options.depictions ?? false }) };
      case 'test-spec':
        return {
          html: renderTestSpecSheet(design, db, {
            ...shared,
            ...(options.testParameters === undefined ? {} : { testParameters: options.testParameters }),
            ...(options.testDefaults === undefined ? {} : { testDefaults: options.testDefaults }),
          }),
        };
      case 'formboard':
        return {
          html: formboardHtml(
            deriveFormboard(design, db, {
              ...(options.variation === undefined ? {} : { variation: options.variation }),
              ...(options.drawing?.meta === undefined ? {} : { drawing: options.drawing.meta }),
            }),
            {
              ...(options.paper === undefined ? {} : { paper: options.paper }),
              frame: sheetFrameFor(design, db, { ...shared, ...benchInput(options) } as BuildSheetOptions, 'FORMBOARD', 'landscape', 'strip'),
              ...(options.scale === undefined ? {} : { scale: options.scale }),
              ...(options.revisionNumber === undefined ? {} : { revisionNumber: options.revisionNumber }),
            },
          ),
        };
      case 'labels': {
        const input = { ...options.labels, ...shared, design: design.id,
          frame: sheetFrameFor(design, db, { ...shared, ...benchInput(options) } as BuildSheetOptions, 'LABELS', 'portrait', 'strip') };
        const labels = deriveLabels(design, db);
        const count = labelSheetPages(labels.length, input);
        const pages = Array.from({ length: count }, (_, i) => labelSheetSvg(labels, { ...input, page: i + 1 }));
        const preset = labelPresetFor(input);
        // Tape lengths can differ. Named pages preserve each label's own dimensions when printed.
        const sizes = pages.map((svg) => {
          const size = /width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
          return { width: Number(size?.[1] ?? preset.layout.pageWidth), height: Number(size?.[2] ?? preset.layout.pageHeight) };
        });
        const wrapped = pages.map((svg, index) => {
          const { width, height } = sizes[index]!;
          return `<style>@page label${index}{size:${width}mm ${height}mm;margin:0}.label-page-${index}{page:label${index};width:${width}mm;height:${height}mm}</style><section class="label-page label-page-${index}">${svg}</section>`;
        }).join('');
        return { pageSize: { width: Math.max(...sizes.map((size) => size.width)), height: Math.max(...sizes.map((size) => size.height)) }, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wire labels</title><style>html,body{margin:0;padding:0}.label-page{break-after:page;overflow:hidden}.label-page:last-child{break-after:auto}.label-page svg{display:block}</style></head><body>${wrapped}</body></html>` };
      }
      case 'drawing':
        return {
          html: renderDrawingSheet(design, db, {
            ...(options.drawing?.meta === undefined ? {} : { meta: options.drawing.meta }),
            ...(options.drawing?.photo === undefined ? {} : { photo: options.drawing.photo }),
            ...(options.paper === undefined ? {} : { paper: options.paper }),
            ...(options.document?.status === undefined ? {} : { state: options.document.status }),
            ...(options.revisions === undefined ? {} : { revisions: options.revisions }),
          }),
        };
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * The BOM or continuity spec as markdown, for pasting into a work order or a
 * purchase note; `undefined` for a document that has
 * no markdown form, or a design the derivation cannot handle.
 */
export function documentMarkdown(kind: DocumentKind, design: CableDesign, db: Db, options: DocumentOptions = {}): string | undefined {
  try {
    if (kind === 'bom') return renderBomMarkdown(design, db, { ...(options.document === undefined ? {} : { document: options.document }), ...benchInput(options), depictions: options.depictions ?? false });
    if (kind === 'test-spec') return testSpecToMarkdown(deriveTestSpec(design, db), resolveTestParameters(options.testParameters, options.testDefaults));
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * One of the base exports (`@wirehub/docs`'s `BASE_EXPORTS`: CSV, XLSX, JSON,
 * label sheet) for the design shown, with the same sidecar, part-number and
 * revision inputs the printed sheets use. Never throws.
 */
export function renderExport(
  id: string,
  design: CableDesign,
  db: Db,
  options: FormatOptions = {},
): { output: FormatOutput } | { error: string } {
  const format = baseExport(id);
  if (format === undefined) return { error: `There is no export called '${id}'.` };
  try {
    return { output: format.render(design, db, options) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * Put text on the clipboard — the async Clipboard API where the page is a
 * secure context, else the old `execCommand('copy')` on a hidden textarea
 * (the studio is often reached over plain http on the LAN, where
 * `navigator.clipboard` does not exist). Resolves whether it worked.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea
    }
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/* ------------------------------------------------------------------ *
 * Draft or saved
 * ------------------------------------------------------------------ */

export type SaveState = 'saved' | 'draft' | 'unsaved';

export interface DraftStatus {
  state: SaveState;
  /** the chip's own words */
  label: string;
  /** one sentence explaining what the label means for these documents */
  detail: string;
}

/**
 * Same document? Identity first — an untouched design is the very object the
 * host handed in — then bytes, so an edit-and-undo round trip reads as saved
 * again rather than as a phantom draft.
 */
export function sameDesign(a: CableDesign, b: CableDesign): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Which state the documents describe. The build sheet is what someone takes to
 * the bench, so it must never be ambiguous about whether it shows the design on
 * file or the edits still in the editor.
 */
export function draftStatus(current: CableDesign, saved: CableDesign | undefined): DraftStatus {
  if (saved === undefined) {
    return {
      state: 'unsaved',
      label: 'Draft — never saved',
      detail: 'This design has not been written to the catalog yet. These documents show what is in the editor.',
    };
  }
  if (sameDesign(current, saved)) {
    return {
      state: 'saved',
      label: 'As saved',
      detail: 'These documents match the design as it is stored in the catalog.',
    };
  }
  return {
    state: 'draft',
    label: 'Draft — unsaved changes',
    detail: 'These documents include edits that are not saved yet. Save the design if you want the file on disk to match this print.',
  };
}

/* ------------------------------------------------------------------ *
 * What to tell the user
 * ------------------------------------------------------------------ */

/** Nothing has been placed yet — there is no cable to describe. */
export function isEmptyDesign(design: CableDesign): boolean {
  const { connectors, segments, components, pcbas } = design.instances;
  return (
    connectors.length === 0 &&
    segments.length === 0 &&
    components.length === 0 &&
    pcbas.length === 0
  );
}

/** The validator's errors for this design — the ones that block a build. */
export function documentBlockers(design: CableDesign, db: Db): Issue[] {
  return errors(validateDesign(design, db));
}

/**
 * The warning banner's sentence.
 *
 * The documents are still rendered underneath it, deliberately. A design with
 * errors is precisely when someone needs to *see* the BOM and the continuity
 * table to work out what went wrong, the build sheet already prints its own
 * Validation section, and refusing to draw would leave the screen with nothing
 * to act on — which the workbench spec calls a dead end. So: draw it, and say
 * plainly that it is not fit to build from.
 */
export function blockerSentence(issues: Issue[]): string {
  if (issues.length === 0) return '';
  const count = issues.length === 1 ? 'One problem' : `${issues.length} problems`;
  return `${count} must be fixed before this design can be built — these documents are for working out the fix, not for the bench.`;
}

/* ------------------------------------------------------------------ *
 * The drawing sheet's sidecar
 * ------------------------------------------------------------------ */

/**
 * What the drawing sheet prints that the cable model does not carry: part
 * number, revision, designer, date, orderable lengths, the part numbers
 * purchasing actually orders — and a product photo. Kept beside the design,
 * never inside it: none of it is an electrical fact.
 */
export interface DrawingSidecar {
  meta: DrawingMeta;
  /** a `data:image/…` URI */
  photo?: string;
  /** the organisation's default test parameters, when the server has any (`WIREHUB_TEST_DEFAULTS`) */
  testDefaults?: TestParameters;
}

/**
 * Where sidecars live. The studio binds the workbench API; a host without one
 * leaves it out and the form still drives the preview — it just cannot save.
 */
export interface DrawingAdapter {
  load(designId: string): Promise<Outcome<DrawingSidecar>>;
  save(designId: string, meta: DrawingMeta): Promise<Outcome<DrawingMeta>>;
  /** `null` removes the photo */
  savePhoto(designId: string, photo: string | null): Promise<Outcome<{ photo?: string }>>;
}

/**
 * The stale-write guard's marker (`server/etag.ts`'s `staleWriteResponse`),
 * read off any failed `Outcome` without caring which adapter sent it — a 409
 * that did not carry the marker (an old server, a test double) still counts,
 * since that is the status code the guard answers with.
 */
export function isStaleWrite(outcome: Extract<Outcome<unknown>, { ok: false }>): boolean {
  return outcome.status === 409 || (outcome.issues ?? []).some((issue) => issue.code === 'stale-write');
}

/**
 * A three-way field merge: `base` is what a form last knew as saved, `mine`
 * is its unsaved edit, `theirs` is what is on the server now. A field this
 * form never touched (`mine` still reads as `base`) silently takes the
 * server's value — the normal case when *something else* rewrote the record,
 * e.g. a version save bumping the drawing's `revision`. A field only this
 * form touched keeps the edit. Both sides changing it to the same value is
 * not a conflict either. Only "both sides touched it, to different values"
 * is — `mine` is kept (nothing is silently thrown away) and `conflict: true`
 * says a person has to look.
 */
export function mergeField<T>(base: T, mine: T, theirs: T): { value: T; conflict: boolean } {
  const eq = (a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (eq(base, mine)) return { value: theirs, conflict: false };
  if (eq(base, theirs) || eq(mine, theirs)) return { value: mine, conflict: false };
  return { value: mine, conflict: true };
}

/** One `DrawingMeta` field both this form and the server changed, to different values. */
export interface DrawingFieldConflict {
  field: keyof DrawingMeta;
  mine: unknown;
  theirs: unknown;
}

/** A stale drawing save this form could not merge away entirely on its own. */
export interface DrawingConflict {
  fields: DrawingFieldConflict[];
  photo?: { mine?: string; theirs?: string };
}

const DRAWING_META_KEYS: (keyof DrawingMeta)[] = [
  'title',
  'partNumber',
  'revision',
  'designer',
  'date',
  'material',
  'lengths',
  'materials',
  'remarks',
  'cutaway',
  'sheet',
  'test',
  'src',
];

/** `mergeField`, applied to every field of a `DrawingMeta`. */
export function mergeDrawingMeta(
  base: DrawingMeta,
  mine: DrawingMeta,
  theirs: DrawingMeta,
): { merged: DrawingMeta; conflicts: DrawingFieldConflict[] } {
  const merged: Record<string, unknown> = { ...mine };
  const conflicts: DrawingFieldConflict[] = [];
  for (const key of DRAWING_META_KEYS) {
    const { value, conflict } = mergeField(base[key], mine[key], theirs[key]);
    if (conflict) {
      conflicts.push({ field: key, mine: mine[key], theirs: theirs[key] });
      continue; // `mine`'s value stays in `merged` (the spread above) until a person resolves it
    }
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return { merged: merged as DrawingMeta, conflicts };
}

/** A short label for a conflict banner — the field names people actually see. */
export const DRAWING_FIELD_LABELS: Record<keyof DrawingMeta, string> = {
  title: 'Title',
  partNumber: 'Part number',
  revision: 'Revision',
  designer: 'Designer',
  date: 'Date',
  material: 'Material',
  lengths: 'Lengths',
  materials: 'BOM wording',
  remarks: 'Extra remarks',
  cutaway: 'Cable illustration',
  sheet: 'Sheet options',
  test: 'Test parameters',
  src: 'Reference',
};

/** A conflicting value, for the banner — never blank-looking. */
export function describeConflictValue(value: unknown): string {
  if (value === undefined || value === '') return '(blank)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

const LENGTH_LINE = /^\s*(?:(-?[\w.]+)\s*=\s*)?(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:[(/]\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:overall)?\s*\)?)?\s*$/i;

/**
 * The lengths box, one variant per line, written the way the sheet prints
 * them: `-36 = 1830`, or `-36 = 1530 (1830 overall)` when a breakout makes the
 * trunk shorter than the cable. A bare `1830` is a single, unsuffixed length.
 */
export function parseLengths(text: string): { lengths: LengthVariant[]; problems: string[] } {
  const lengths: LengthVariant[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    const match = LENGTH_LINE.exec(raw);
    if (match === null) {
      problems.push(`Line ${index + 1} ("${raw.trim()}") is not a length. Write it as -36 = 1830, or -36 = 1530 (1830 overall).`);
      return;
    }
    const [, suffix, mm, overall] = match;
    lengths.push({
      suffix: suffix ?? '',
      mm: Number(mm),
      ...(overall === undefined ? {} : { overallMm: Number(overall) }),
    });
  });
  return { lengths, problems };
}

export function formatLengths(lengths: readonly LengthVariant[] | undefined): string {
  return (lengths ?? [])
    .map((v) => {
      const base = v.suffix === '' ? String(v.mm) : `${v.suffix} = ${v.mm}`;
      return v.overallMm === undefined ? base : `${base} (${v.overallMm} overall)`;
    })
    .join('\n');
}
