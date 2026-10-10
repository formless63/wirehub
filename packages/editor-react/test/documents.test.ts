/**
 * The Documents view's logic.
 *
 * What matters here is that the documents are the *same* deliverables the CLI
 * emits, derived from the design the user is looking at right now — and that
 * the pane can always say something useful about them: which state they show
 * (saved or draft), why a design has nothing to document, and what went wrong
 * when a derivation fails.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { CableDesign, Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  blockerSentence,
  documentBlockers,
  draftStatus,
  isEmptyDesign,
  isStaleWrite,
  formatLengths,
  mergeDrawingMeta,
  mergeField,
  parseLengths,
  renderDocument,
  sameDesign,
  sheetRenderOptions,
  DOCUMENT_KINDS,
} from '../src/documents.ts';
import { editorReducer, initialEditorState } from '../src/store.ts';
import { dataUriBytes, downscaleTarget, PHOTO_SIZE_LIMIT } from '../src/panels/DrawingForm.tsx';

const db: Db = loadDb();
const design = loadDesign('de9-crossover');

function html(result: ReturnType<typeof renderDocument>): string {
  expect('html' in result, 'error' in result ? result.error : '').toBe(true);
  return 'html' in result ? result.html : '';
}

describe('renderDocument', () => {
  it('builds each document as a complete, self-contained page', () => {
    for (const kind of DOCUMENT_KINDS) {
      const document = html(renderDocument(kind, design, db));
      expect(document.startsWith('<!doctype html>'), kind).toBe(true);
      // the drawing and the formboard are landscape on the caller's paper, the other sheets portrait; A4 by default
      expect(document, kind).toContain(kind === 'labels' ? '@page label0{size:210mm 297mm;margin:0}' : kind === 'drawing' ? '@page{size:297mm 210mm;margin:0}' : kind === 'formboard' ? '@page{size:297mm 210mm;margin:0}' : '@page{size:210mm 297mm;margin:8mm');
      // nothing to fetch: an iframe with no network is still a correct sheet.
      // (`xmlns="http://www.w3.org/2000/svg"` is a namespace name, not a fetch)
      const clean = document.replace(/xmlns(:\w+)?="[^"]*"/g, '');
      expect(clean, kind).not.toMatch(/<script|<link\b|https?:\/\//i);
    }
  });

  it('gives the BOM and the continuity spec their own sheets', () => {
    const bom = html(renderDocument('bom', design, db));
    expect(bom).toContain('BILL OF MATERIALS');
    expect(bom).toContain('cs-bomtable');
    expect(bom).not.toContain('cs-table--paths');

    const spec = html(renderDocument('test-spec', design, db));
    expect(spec).toContain('CONTINUITY &amp; TEST SPEC');
    // a section with nothing in it is not printed: this design has no path through anything
    expect(spec).toContain('cs-table--nets');
    expect(spec).not.toContain('cs-table--paths');
    expect(spec).not.toContain('through something');
    expect(spec).not.toContain('cs-bomtable');
  });

  it('prints the resolved PN (an owner-cited productRef) over a drawing PN that disagrees — as the Cables list does', () => {
    if (design.productRef === undefined) return;
    const bom = html(renderDocument('bom', design, db, { drawing: { meta: { partNumber: 'CBL-00102-36' } } }));
    expect(bom).toMatch(new RegExp(`data-frame-field="pn">${design.productRef}<`));
  });

  it('follows the draft, not the design on file', () => {
    const state = initialEditorState(design, db);
    const edited = editorReducer(state, { type: 'delete-joint', index: 0 });
    expect(edited.rejection).toBeUndefined();
    const before = html(renderDocument('test-spec', state.design, db));
    const after = html(renderDocument('test-spec', edited.design, db));
    expect(after).not.toBe(before);
  });

  it('still builds a design the validator has errors about — that is when it is needed', () => {
    const broken = {
      ...design,
      instances: { ...design.instances, segments: [{ id: 'wX', def: 'no-such-wire' }] },
    } as CableDesign;
    const sheet = html(renderDocument('build-sheet', broken, db));
    expect(sheet).toContain('data-stage="Test"');
    // and the sheet says out loud that it is not fit to build from
    expect(sheet).toContain('Validation');
  });

  it('reports a derivation that cannot run at all instead of throwing', () => {
    const malformed = { ...design, joints: undefined } as unknown as CableDesign;
    const result = renderDocument('build-sheet', malformed, db);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.length).toBeGreaterThan(0);
  });

  it('honours the paper size', () => {
    expect(html(renderDocument('bom', design, db, { paper: 'letter' }))).toContain('@page{size:215.9mm 279.4mm');
  });
});

describe('draftStatus', () => {
  it('calls an untouched design saved, by identity and by bytes', () => {
    expect(draftStatus(design, design).state).toBe('saved');
    expect(draftStatus(design, JSON.parse(JSON.stringify(design)) as CableDesign).label).toBe(
      'As saved',
    );
  });

  it('calls an edited design a draft and says the changes are not written', () => {
    const state = initialEditorState(design, db);
    const edited = editorReducer(state, { type: 'delete-joint', index: 0 });
    const status = draftStatus(edited.design, design);
    expect(status.state).toBe('draft');
    expect(status.label).toBe('Draft — unsaved changes');
    expect(status.detail).toMatch(/not saved/);
  });

  it('goes back to saved when the edit is undone', () => {
    const state = initialEditorState(design, db);
    const edited = editorReducer(state, { type: 'delete-joint', index: 0 });
    const undone = editorReducer(edited, { type: 'undo' });
    expect(draftStatus(undone.design, design).state).toBe('saved');
  });

  it('says so when the design has never been saved at all', () => {
    const status = draftStatus(design, undefined);
    expect(status.state).toBe('unsaved');
    expect(status.label).toMatch(/never saved/);
  });

  it('compares documents, not object identity', () => {
    expect(sameDesign(design, design)).toBe(true);
    expect(sameDesign(design, { ...design, label: 'renamed' })).toBe(false);
  });
});

describe('what the pane tells the user', () => {
  it('knows a design with nothing on it', () => {
    const blank: CableDesign = {
      ...design,
      instances: { connectors: [], segments: [], components: [], pcbas: [] },
      joints: [],
    };
    expect(isEmptyDesign(blank)).toBe(true);
    expect(isEmptyDesign(design)).toBe(false);
  });

  it('lists the validator’s errors, in the validator’s words, and says what they mean', () => {
    const broken = {
      ...design,
      instances: { ...design.instances, connectors: [{ id: 'jX', def: 'invented-connector' }] },
    } as CableDesign;
    const blockers = documentBlockers(broken, db);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.every((issue) => issue.severity === 'error')).toBe(true);
    expect(blockerSentence(blockers)).toMatch(/must be fixed/);

    // a clean design gets no banner at all
    expect(documentBlockers(design, db)).toHaveLength(0);
    expect(blockerSentence([])).toBe('');
  });
});

describe('the drawing sheet lengths box', () => {
  it('reads the lines the way the sheet prints them', () => {
    expect(parseLengths('-34 = 1220\n-36 = 1830 MM\n\n-38 = 2140 (2440 overall)')).toEqual({
      lengths: [
        { suffix: '-34', mm: 1220 },
        { suffix: '-36', mm: 1830 },
        { suffix: '-38', mm: 2140, overallMm: 2440 },
      ],
      problems: [],
    });
    expect(parseLengths('300').lengths).toEqual([{ suffix: '', mm: 300 }]);
  });

  it('says which line it could not read', () => {
    expect(parseLengths('-34 = 1220\nsix feet').problems[0]).toMatch(/^Line 2/);
  });

  it('writes back what it reads', () => {
    const text = '-34 = 1220\n-38 = 2140 (2440 overall)';
    expect(formatLengths(parseLengths(text).lengths)).toBe(text);
  });

  it('renders the drawing with its sidecar', () => {
    const sheet = html(renderDocument('drawing', design, db, { drawing: { meta: { partNumber: 'CBL-TEST-01' } } }));
    expect(sheet).toContain('CBL-TEST-01');
  });
});

describe('sheet options', () => {
  const today = (): string => '2026.09.24';

  it('the document number defaults to the part number, the revision to the drawing, and no date unless stamped', () => {
    expect(sheetRenderOptions({ partNumber: 'CBL-00101-3X', revision: '2' }, design, today)).toEqual({
      document: { number: 'CBL-00101-3X', revision: '2' },
    });
    expect(sheetRenderOptions({}, { ...design, productRef: 'PR-1' }, today)).toEqual({ document: { number: 'PR-1' } });
    const { productRef: _ref, ...bare } = design;
    expect(sheetRenderOptions({}, bare, today)).toEqual({});
  });

  it('stored options win, and the stamp asks the clock', () => {
    const meta = { partNumber: 'CBL-1', sheet: { paper: 'letter' as const, number: 'DOC-9', revision: 'B', status: 'RELEASED', stampDate: true } };
    expect(sheetRenderOptions(meta, design, today)).toEqual({
      paper: 'letter',
      generatedAt: '2026.09.24',
      document: { number: 'DOC-9', revision: 'B', status: 'RELEASED' },
    });
  });

  it('reaches the printed title block', () => {
    const out = renderDocument('bom', design, db, sheetRenderOptions({ sheet: { number: 'DOC-9', status: 'DRAFT', stampDate: true, paper: 'letter' } }, design, today));
    expect('html' in out && out.html).toContain('DOC-9');
    expect('html' in out && out.html).toContain('2026.09.24');
    expect('html' in out && out.html).toContain('@page{size:215.9mm 279.4mm');
  });
});

describe('the stale-write recovery', () => {
  it('isStaleWrite reads the marker `server/etag.ts` sends, and the bare 409 an older server might send instead', () => {
    expect(isStaleWrite({ ok: false, message: 'x', issues: [{ code: 'stale-write', severity: 'error', message: 'x' }] })).toBe(true);
    expect(isStaleWrite({ ok: false, message: 'x', status: 409 })).toBe(true);
    expect(isStaleWrite({ ok: false, message: 'x', status: 422, issues: [{ code: 'bad-value', severity: 'error', message: 'x' }] })).toBe(false);
  });

  it('mergeField takes the side that actually changed, and only flags a conflict when both sides changed it differently', () => {
    // nobody touched it
    expect(mergeField('a', 'a', 'a')).toEqual({ value: 'a', conflict: false });
    // only the server did — the version-save case
    expect(mergeField('a', 'a', 'b')).toEqual({ value: 'b', conflict: false });
    // only this form did
    expect(mergeField('a', 'b', 'a')).toEqual({ value: 'b', conflict: false });
    // both did, to the same thing
    expect(mergeField('a', 'b', 'b')).toEqual({ value: 'b', conflict: false });
    // both did, to different things — a real conflict; `mine` is kept, nothing guessed
    expect(mergeField('a', 'b', 'c')).toEqual({ value: 'b', conflict: true });
  });

  it('mergeDrawingMeta applies that field-by-field: a version save\'s `revision` merges silently, an edited field is kept', () => {
    const base = { partNumber: 'CBL-1' };
    const mine = { partNumber: 'CBL-2' }; // edited here
    const theirs = { partNumber: 'CBL-1', revision: '0' }; // a version save set the revision
    expect(mergeDrawingMeta(base, mine, theirs)).toEqual({
      merged: { partNumber: 'CBL-2', revision: '0' },
      conflicts: [],
    });
  });

  it('mergeDrawingMeta reports a field both sides changed, to different values, instead of picking one', () => {
    const base = { partNumber: 'CBL-1', designer: 'Alex' };
    const mine = { partNumber: 'CBL-2', designer: 'Alex' };
    const theirs = { partNumber: 'CBL-3', designer: 'Alex' };
    expect(mergeDrawingMeta(base, mine, theirs)).toEqual({
      merged: { partNumber: 'CBL-2', designer: 'Alex' }, // kept as typed, not overwritten
      conflicts: [{ field: 'partNumber', mine: 'CBL-2', theirs: 'CBL-3' }],
    });
  });

  it('mergeDrawingMeta drops a field the server cleared, when this form never touched it', () => {
    const base = { partNumber: 'CBL-1', designer: 'Alex' };
    const mine = { partNumber: 'CBL-2', designer: 'Alex' };
    const theirs = { partNumber: 'CBL-1' }; // designer cleared elsewhere
    expect(mergeDrawingMeta(base, mine, theirs)).toEqual({ merged: { partNumber: 'CBL-2' }, conflicts: [] });
  });
});

describe('the drawing photo, resized to fit instead of refused', () => {
  it('leaves a photo already under the limit alone', () => {
    expect(downscaleTarget(4000, 3000, PHOTO_SIZE_LIMIT - 1, PHOTO_SIZE_LIMIT)).toBeUndefined();
    expect(downscaleTarget(4000, 3000, PHOTO_SIZE_LIMIT, PHOTO_SIZE_LIMIT)).toBeUndefined();
  });

  it('shrinks the long edge first, keeping the aspect ratio', () => {
    // ~4x over the limit: the byte-vs-area heuristic wants roughly a half-scale
    const target = downscaleTarget(4000, 2000, PHOTO_SIZE_LIMIT * 4, PHOTO_SIZE_LIMIT);
    expect(target).toBeDefined();
    const t = target!;
    expect(t.width).toBeLessThan(4000);
    expect(t.height).toBeLessThan(2000);
    // aspect ratio kept within rounding
    expect(t.width / t.height).toBeCloseTo(4000 / 2000, 1);
    // scaling down by ~sqrt(1/4) = 0.5, backed off — comfortably between a
    // quarter and all of the original, never enlarged
    expect(t.width).toBeGreaterThan(1000);
    expect(t.width).toBeLessThan(2200);
  });

  it('never asks for less than 200px on the long edge, even for a wildly oversized source', () => {
    const target = downscaleTarget(20000, 10000, PHOTO_SIZE_LIMIT * 20000, PHOTO_SIZE_LIMIT)!;
    expect(Math.max(target.width, target.height)).toBe(200);
  });

  it('dataUriBytes reads a data URI\'s decoded size without decoding it', () => {
    // "AAA" -> 2 bytes (one '=' pad), "AAAA" -> 3 bytes (no pad) — arithmetic every base64 decoder agrees on
    expect(dataUriBytes('data:image/png;base64,AAAA')).toBe(3);
    expect(dataUriBytes('data:image/png;base64,AAA=')).toBe(2);
    expect(dataUriBytes('data:image/png;base64,AA==')).toBe(1);
    expect(dataUriBytes(`data:image/jpeg;base64,${Buffer.from('a'.repeat(300)).toString('base64')}`)).toBe(300);
  });
});

describe('the formboard document', () => {
  it('prints every page, at the scale asked, in the paper asked', () => {
    const one = html(renderDocument('formboard', design, db, { scale: 0.1 }));
    const many = html(renderDocument('formboard', design, db, { scale: 1, paper: 'letter' }));
    expect(many).toContain('@page{size:279.4mm 215.9mm;margin:0}');
    expect(many.match(/cs-formboard-page">/g)?.length).toBeGreaterThan(one.match(/cs-formboard-page">/g)?.length ?? 0);
    expect(one).toContain('tiles at 1:10');
  });
});
