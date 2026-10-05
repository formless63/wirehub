/**
 * Flows for the gaps a private shop's migration found, one body for both backends
 * (`migration-gaps.server.test.ts`, `pg/migration-gaps.server.test.ts`):
 *
 * - `runSchemeAndSelectorsFlow`: a numbering scheme with exclusions, range unions and multi-segment matches through
 *   Settings' check, and a `cable-end` rule through the rules test;
 * - `runVendorPdfPackFlow`: signed-pack PDFs under `docs/` and `assets/` are pinned, installed, linked from library
 *   records, served by `/api/blobs` with safe headers, replaced on update and removed on disable;
 * - `runBrandingFlow`: a licensed typeface and drawing art entered in Settings, Branding (and a font a pack ships)
 *   are stored as data and used in the drawing, the HTML sheets and the PDFs;
 * - `runBenchRulesPackFlow`: a data pack's `bench-rules.json` is read at runtime, follows install, update and
 *   disable, and a bad rule refuses the pack;
 * - `runPadMapPreviewFlow`: a pack that ships an auxiliary PCBA pad table is previewed with the
 *   same data the installed catalog will have, so preview validation equals post-install validation.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDesigns } from '@wirehub/catalog';
import { renderBuildSheet } from '@wirehub/docs';
import { validateDesign, type CableDesign, type Db } from '@wirehub/model';
import { expect } from 'vitest';

import type { StudioUser } from '../server/me.ts';

export const OWNER: StudioUser = { name: 'Olive Owner', source: 'session', role: 'owner' };

export interface FlowCall {
  (method: string, path: string, body?: unknown, user?: StudioUser, headers?: Record<string, string>): Promise<{ status: number; body: any; headers?: Record<string, string>; bytes?: Uint8Array }>;
}

const SRC = 'synthetic example: migration-gap flow';

/** the starter terminal-board design, landing its ground on a named pad, as a pack's design file */
function padDesign(): CableDesign {
  const base = structuredClone(loadDesigns().find((d) => d.id === 'de9-terminal-board') as CableDesign);
  base.id = 'pad-landing';
  base.label = 'Pad landing (synthetic)';
  base.joints = base.joints.map((j) => (j.b.instance === 'u1' && j.b.terminal === 'GND' ? { ...j, b: { ...j.b, pad: 'GND1' } } : j));
  return base;
}

const PAD_TABLE = { src: SRC, boards: { 'pair-terminal-board': { src: SRC, terminals: { GND: [{ ref: 'GND1', side: 'top' }, { ref: 'GND2', side: 'bottom' }] } } } };

const padPack = (withPads: boolean, version: string) => ({
  format: 1,
  manifest: { format: 1, id: 'pad-pack', name: 'Pad pack', version, license: 'CC0-1.0' },
  files: {
    'components.json': [{ id: 'pad-pack-r', label: '2 ohm resistor', kind: 'resistor', value: '2', terminals: [{ id: 'a' }, { id: 'b' }], src: SRC }],
    'designs/pad-landing.json': padDesign(),
    ...(withPads ? { 'pcba-pads.json': PAD_TABLE } : {}),
  },
});

export async function runPadMapPreviewFlow(call: FlowCall): Promise<void> {
  // without the pad table the design names a pad nobody declared: the preview says so and refuses
  const bare = await call('POST', '/api/packs/install', { bundle: padPack(false, '1.0.0') }, OWNER);
  expect(bare.status, JSON.stringify(bare.body)).toBe(200);
  expect(bare.body.applicable).toBe(false);
  expect(JSON.stringify(bare.body.plan.issues)).toContain('pad-unknown');

  // with it, the preview loads the pack's pad table: no errors, the same as after the install
  const preview = await call('POST', '/api/packs/install', { bundle: padPack(true, '1.0.0') }, OWNER);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.plan.issues).toEqual([]);
  expect(preview.body.applicable).toBe(true);

  const done = await call('POST', '/api/packs/install', { bundle: padPack(true, '1.0.0'), apply: true }, OWNER);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.installed).toBe(true);
  const db = (await call('GET', '/api/db')).body as Db;
  expect(db.pcbas.find((p) => p.id === 'pair-terminal-board')?.terminals.find((t) => t.id === 'GND')?.pads?.map((p) => p.ref)).toEqual(['GND1', 'GND2']);
  const design = (await call('GET', '/api/designs/pad-landing')).body as CableDesign;
  expect(validateDesign(design, db).filter((i) => i.severity === 'error')).toEqual([]);

  // an update that drops the pad table is previewed with the table gone: the pack's own design now fails, and the plan says so
  const update = await call('POST', '/api/packs/install', { bundle: padPack(false, '1.0.1') }, OWNER);
  expect(update.status, JSON.stringify(update.body)).toBe(200);
  expect(update.body.kind).toBe('update');
  expect(update.body.applicable).toBe(false);
  expect(JSON.stringify(update.body.plan.issues)).toContain('pad-unknown');
  expect(update.body.plan.diff.removed.map((r: any) => [r.file, r.id])).toEqual([['pcba-pads.json', 'pair-terminal-board']]);
  // keeping the table (a patch version) is fine
  const keep = await call('POST', '/api/packs/install', { bundle: padPack(true, '1.0.1') }, OWNER);
  expect(keep.body.plan.issues).toEqual([]);
  expect(keep.body.applicable).toBe(true);

  // disabling the pack takes its pad table with it
  const gone = await call('DELETE', '/api/packs/pad-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  const after = (await call('GET', '/api/db')).body as Db;
  expect(after.pcbas.find((p) => p.id === 'pair-terminal-board')?.terminals.find((t) => t.id === 'GND')?.pads).toBeUndefined();
}

const benchRule = (text: string) => ({ id: 'pack-prep', phase: 'prep', src: SRC, steps: [{ text, src: 'synthetic example: a pack work instruction' }] });
const benchPack = (version: string, rules: unknown[]) => ({
  format: 1,
  manifest: { format: 1, id: 'bench-pack', name: 'Bench pack', version, license: 'CC0-1.0' },
  files: {
    'components.json': [{ id: 'bench-pack-r', label: '3 ohm resistor', kind: 'resistor', value: '3', terminals: [{ id: 'a' }, { id: 'b' }], src: SRC }],
    'bench-rules.json': rules,
  },
});

export async function runBenchRulesPackFlow(call: FlowCall): Promise<void> {
  const sheet = async (): Promise<string> => {
    const db = (await call('GET', '/api/db')).body as Db;
    const design = (await call('GET', '/api/designs/de9-crossover')).body as CableDesign;
    return renderBuildSheet(design, db);
  };
  const generic = await sheet();
  expect(generic).toContain('Cut to length');

  // a pack whose bench rule cannot be printed is refused whole, the problem named
  const bad = await call('POST', '/api/packs/install', { bundle: benchPack('1.0.0', [{ ...benchRule('x'), id: 'Bad Id' }]), apply: true }, OWNER);
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.body)).toMatch(/bench-rules\.json.*kebab-case/);
  expect(await sheet()).toBe(generic);

  // install: the sheet prints the pack's steps at once, with no restart and no module code
  const done = await call('POST', '/api/packs/install', { bundle: benchPack('1.0.0', [benchRule('Strip per PACK-WI-1.')]), apply: true }, OWNER);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.installed).toBe(true);
  expect(((await call('GET', '/api/db')).body as Db).benchRules?.map((r) => r.id)).toEqual(['pack-prep']);
  const installed = await sheet();
  expect(installed).toContain('Strip per PACK-WI-1.');
  expect(installed).not.toContain('Cut to length');

  // update: the changed rule replaces the old one
  const update = await call('POST', '/api/packs/install', { bundle: benchPack('1.0.1', [benchRule('Strip per PACK-WI-2.')]), apply: true }, OWNER);
  expect(update.status, JSON.stringify(update.body)).toBe(200);
  expect(update.body.kind).toBe('update');
  const updated = await sheet();
  expect(updated).toContain('Strip per PACK-WI-2.');
  expect(updated).not.toContain('PACK-WI-1');

  // disable: the pack's rules go with it and the generic steps are back
  const gone = await call('DELETE', '/api/packs/bench-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  expect(((await call('GET', '/api/db')).body as Db).benchRules).toBeUndefined();
  expect(await sheet()).toBe(generic);
}

const GAP_SCHEME = {
  type: 'declarative',
  id: 'gap-scheme',
  template: '{level}{type}-{seq}',
  segments: [
    { id: 'level', type: 'choice', values: [{ value: '1', kinds: ['connector', 'wire'] }, { value: '2', kinds: ['design'] }] },
    { id: 'type', type: 'choice', values: [{ value: 'C', kinds: ['connector'] }, { value: 'W', kinds: ['wire'] }, { value: 'A', kinds: ['design'] }] },
    {
      id: 'seq',
      type: 'counter',
      width: 4,
      per: ['level', 'type'],
      exclude: [13],
      ranges: [
        { match: [{ level: '1', type: 'C' }, { level: '2', type: 'A' }], spans: [{ from: 10, to: 14 }, { from: 100, to: 101 }], exclude: [{ from: 11, to: 12 }] },
        { from: 1, to: 99 },
      ],
    },
  ],
  src: SRC,
};

export async function runSchemeAndSelectorsFlow(call: FlowCall): Promise<void> {
  // the scheme: spans hop over the gap, exclusions are skipped, a combination that matches no list keeps its own range
  const preview = await call('POST', '/api/settings/part-numbers/preview', { scheme: GAP_SCHEME, samples: ['1C-0012', '1C-0013', '1C-0050', '1C-0014'], suggest: [{ kind: 'connector' }, { kind: 'wire' }, { kind: 'design' }] }, OWNER);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body.suggestions.map((x: any) => x.suggestion?.pn)).toEqual(['1C-0010', '1W-0001', '2A-0010']);
  const text = JSON.stringify(preview.body);
  expect(text).toContain('pn-excluded');
  expect(text).toContain('pn-out-of-range');
  // refused with the problem named, nothing saved
  const bad = await call('POST', '/api/settings/part-numbers/preview', { scheme: { ...GAP_SCHEME, segments: GAP_SCHEME.segments.map((x: any) => (x.id === 'seq' ? { ...x, exclude: [{ from: 9, to: 1 }] } : x)) } }, OWNER);
  expect(JSON.stringify(bad.body)).toMatch(/from <= to/);

  // the selectors: each cable end of the starter's DE-9 to terminal board design, tested over every design
  const rule = {
    id: 'end-needs-board-pn',
    severity: 'warning',
    each: 'cable-end',
    where: { gt: [{ path: 'boardCount' }, 0] },
    require: { some: { in: 'boards', where: { startsWith: [{ path: 'partNumber' }, 'ZZZ'] } } },
    message: '{id}: the board here has no ZZZ part number',
    src: SRC,
  };
  const run = await call('POST', '/api/rules/preview', { rule }, OWNER);
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  expect(run.body.ok, JSON.stringify(run.body)).toBe(true);
  expect(run.body.designs.map((d: any) => [d.id, d.issues, d.examples[0].where])).toEqual([['de9-terminal-board', 1, 'w1@b']]);
  const view = await call('GET', '/api/rules', undefined, OWNER);
  expect(view.body.subjects.design).toContain('cable-end');
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** a small, valid-looking PDF; `mark` makes each one different */
export const pdfBytes = (mark: string, extra = ''): Uint8Array => new TextEncoder().encode(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${extra}>>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n% ${mark}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const pdfPack = (version: string, pdfs: Record<string, Uint8Array>, link: Uint8Array | undefined, manifestExtra: object = {}) => ({
  format: 1,
  manifest: { format: 1, id: 'pdf-pack', name: 'Vendor documents', version, license: 'CC0-1.0', ...manifestExtra },
  files: {
    'components.json': [
      {
        id: 'pdf-pack-r',
        label: '4 ohm resistor',
        kind: 'resistor',
        value: '4',
        terminals: [{ id: 'a' }, { id: 'b' }],
        ...(link === undefined ? {} : { vendorDocs: [{ asset: sha(link), label: 'the vendor datasheet', src: 'synthetic example: a vendor document' }] }),
        src: SRC,
      },
    ],
    ...Object.fromEntries(Object.entries(pdfs).map(([path, bytes]) => [path, b64(bytes)])),
  },
});

export async function runVendorPdfPackFlow(call: FlowCall, options: { strictRemoval?: boolean } = {}): Promise<void> {
  const v1 = pdfBytes('datasheet one');
  const other = pdfBytes('drawing');
  const blob = (bytes: Uint8Array) => call('GET', `/api/blobs/${sha(bytes)}`);

  // refused whole: not a PDF, a PDF with a script, a path that is not docs/ or assets/, a PDF that is too large, a pin that does not match
  const notPdf = await call('POST', '/api/packs/install', { bundle: pdfPack('1.0.0', { 'docs/a.pdf': new TextEncoder().encode('<html>not a pdf</html>') }, undefined) }, OWNER);
  expect(notPdf.status, JSON.stringify(notPdf.body)).toBe(400);
  expect(JSON.stringify(notPdf.body)).toMatch(/not a PDF/);
  const script = await call('POST', '/api/packs/install', { bundle: pdfPack('1.0.0', { 'docs/a.pdf': pdfBytes('x', '/OpenAction << /S /JavaScript /JS (app.alert(1)) >> ') }, undefined) }, OWNER);
  expect(script.status, JSON.stringify(script.body)).toBe(400);
  expect(JSON.stringify(script.body)).toMatch(/active content/);
  const elsewhere = await call('POST', '/api/packs/install', { bundle: pdfPack('1.0.0', { 'sheets/a.pdf': v1 }, undefined) }, OWNER);
  expect(elsewhere.status).toBe(400);
  const big = await call('POST', '/api/packs/install', { bundle: pdfPack('1.0.0', { 'docs/big.pdf': new Uint8Array([...pdfBytes('big'), ...new Uint8Array(5 * 1024 * 1024)]) }, undefined) }, OWNER);
  expect(big.status, JSON.stringify(big.body).slice(0, 200)).toBe(413);
  const pinned = await call('POST', '/api/packs/install', { bundle: pdfPack('1.0.0', { 'docs/a.pdf': v1 }, undefined, { files: { 'docs/a.pdf': sha(other), 'components.json': '0'.repeat(64) } }) }, OWNER);
  expect(pinned.status, JSON.stringify(pinned.body)).toBe(422);
  expect(JSON.stringify(pinned.body)).toMatch(/does not match the sha256/);

  // install: pinned, installed, linked from the record, served by content address as an attachment that cannot run
  const files = { 'docs/c146-datasheet.pdf': v1, 'assets/vendor/drawing.pdf': other };
  const done = await call('POST', '/api/packs/install', { bundle: pdfPack('1.0.0', files, v1), apply: true }, OWNER);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.installed).toBe(true);
  const db = (await call('GET', '/api/db')).body as Db;
  expect(db.components.find((c) => c.id === 'pdf-pack-r')?.vendorDocs).toEqual([{ asset: sha(v1), label: 'the vendor datasheet', src: 'synthetic example: a vendor document' }]);
  const served = await blob(v1);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
  expect(served.bytes && Buffer.from(served.bytes).equals(Buffer.from(v1))).toBe(true);
  const h = Object.fromEntries(Object.entries(served.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  expect(h['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['content-security-policy']).toContain("default-src 'none'");
  expect((await blob(other)).status).toBe(200);
  // opens in the app by the same address the library's vendor documents use
  const inApp = await call('GET', `/api/assets/${sha(v1)}`);
  expect(inApp.status, JSON.stringify(inApp.body)).toBe(200);
  expect(inApp.bytes && Buffer.from(inApp.bytes).equals(Buffer.from(v1))).toBe(true);
  // a record whose link is malformed is an error of the library, not a silent dead link
  const { validateDb } = await import('@wirehub/model');
  const broken: Db = { ...db, components: db.components.map((c) => (c.id === 'pdf-pack-r' ? { ...c, vendorDocs: [{ asset: 'nope', label: '', src: '' }] } : c)) };
  expect(validateDb(broken).some((i) => i.code === 'record-vendor-docs')).toBe(true);

  // update: the PDF that changed is replaced, the one that went is removed
  const v2 = pdfBytes('datasheet two');
  const update = await call('POST', '/api/packs/install', { bundle: pdfPack('1.1.0', { 'docs/c146-datasheet.pdf': v2 }, v2), apply: true }, OWNER);
  expect(update.status, JSON.stringify(update.body)).toBe(200);
  expect(update.body.kind).toBe('update');
  expect((await blob(v2)).status).toBe(200);
  if (options.strictRemoval) {
    expect((await blob(v1)).status).toBe(404);
    expect((await blob(other)).status).toBe(404);
  }

  // disable: the pack's PDFs go with it
  const gone = await call('DELETE', '/api/packs/pdf-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  expect((await blob(v2)).status).toBe(404);
  expect(((await call('GET', '/api/db')).body as Db).components.some((c) => c.id === 'pdf-pack-r')).toBe(false);
}

/** a bundled Liberation Sans face with its family renamed (same length), so it is not mistaken for the bundled one */
export function brandmark(bold = false): Uint8Array {
  // vitest runs with the package as its working directory
  const bytes = Buffer.from(readFileSync(join(process.cwd(), '..', '..', 'packages', 'docs', 'fonts', `LiberationSans-${bold ? 'Bold' : 'Regular'}.ttf`)));
  const utf16be = (text: string): Buffer => Buffer.from(Buffer.from(text, 'utf16le').swap16());
  // the name table keeps the family in Mac Roman (latin1) and in Windows (UTF-16BE) records
  for (const [from, to] of [[Buffer.from('Liberation Sans', 'latin1'), Buffer.from('Brandmark Sans1', 'latin1')], [utf16be('Liberation Sans'), utf16be('Brandmark Sans1')]] as const) {
    for (let at = bytes.indexOf(from); at >= 0; at = bytes.indexOf(from, at + from.length)) to.copy(bytes, at);
  }
  return new Uint8Array(bytes);
}

const textOf = (r: { bytes?: Uint8Array }): string => Buffer.from(r.bytes ?? new Uint8Array()).toString('latin1');

export async function runBrandingFlow(call: FlowCall): Promise<void> {
  const etagOf = async (): Promise<string> => (await call('GET', '/api/settings/branding', undefined, OWNER)).headers?.['ETag'] ?? '';
  const put = async (body: unknown) => call('PUT', '/api/settings/branding', body, OWNER, { 'if-match': await etagOf() });
  const doc = (kind: string, format: string) => call('GET', `/api/designs/de9-crossover/documents/${kind}?format=${format}`, undefined, OWNER);

  // nothing uploaded yet; the page states what a font must be and what the uploader confirms
  const none = await call('GET', '/api/settings/branding/fonts', undefined, OWNER);
  expect(none.status, JSON.stringify(none.body)).toBe(200);
  expect(none.body.fonts).toEqual([]);
  expect(none.body.limits.formats).toEqual(['ttf', 'otf', 'woff2']);
  const generic = await doc('build-sheet', 'html');
  expect(textOf(generic)).not.toContain("font-family:'CS Brand'");

  // an upload needs the licence confirmed, and a real font
  const regular = brandmark(false);
  const noLicence = await call('POST', '/api/settings/branding/fonts', { name: 'Brandmark-Regular.ttf', data: Buffer.from(regular).toString('base64') }, OWNER);
  expect(noLicence.status).toBe(400);
  expect(JSON.stringify(noLicence.body)).toMatch(/licence/);
  const notFont = await call('POST', '/api/settings/branding/fonts', { name: 'x.ttf', data: Buffer.from('not a font at all, just text').toString('base64'), licence: true }, OWNER);
  expect(notFont.status).toBe(400);
  expect(JSON.stringify(notFont.body)).toMatch(/not a TrueType, OpenType or WOFF2 font/);
  const big = await call('POST', '/api/settings/branding/fonts', { name: 'big.ttf', data: Buffer.alloc(2 * 1024 * 1024, 1).toString('base64'), licence: true }, OWNER);
  expect(big.status).toBe(413);

  const up = await call('POST', '/api/settings/branding/fonts', { name: 'Brandmark-Regular.ttf', data: Buffer.from(regular).toString('base64'), licence: true }, OWNER);
  expect(up.status, JSON.stringify(up.body)).toBe(200);
  expect(up.body.font).toMatchObject({ family: 'Brandmark Sans1', subfamily: 'Regular', format: 'ttf', source: 'upload', embeddable: true, rasterizable: true });
  const bold = await call('POST', '/api/settings/branding/fonts', { name: 'Brandmark-Bold.ttf', data: Buffer.from(brandmark(true)).toString('base64'), licence: true }, OWNER);
  expect(bold.status, JSON.stringify(bold.body)).toBe(200);
  // the same bytes again are the same font (content addressed)
  const again = await call('POST', '/api/settings/branding/fonts', { name: 'copy.ttf', data: Buffer.from(regular).toString('base64'), licence: true }, OWNER);
  expect(again.body.font.id).toBe(up.body.font.id);
  expect(((await call('GET', '/api/settings/branding/fonts', undefined, OWNER)).body.fonts as unknown[]).length).toBe(2);

  // choosing a font this hub does not hold is refused; choosing the uploaded one sets it
  expect((await put({ font: { regular: 'f'.repeat(64) } })).status).toBe(400);
  const set = await put({ font: { regular: up.body.font.id, bold: bold.body.font.id } });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.font.regular).toMatchObject({ id: up.body.font.id, family: 'Brandmark Sans1', mime: 'font/ttf', embeddable: true });
  expect(set.body.font.regular.widths['A']).toBeGreaterThan(500);
  expect(set.body.font.bold.id).toBe(bold.body.font.id);

  // the HTML sheets and the drawing carry it inline; the browser engine's print keeps it first
  const sheet = textOf(await doc('build-sheet', 'html'));
  expect(sheet).toContain("font-family:'CS Brand'");
  expect(sheet).toContain('data:font/ttf;base64,');
  expect(sheet).toContain("--cs-font:'CS Brand'");
  for (const kind of ['bom', 'test-spec']) expect(textOf(await doc(kind, 'html'))).toContain("font-family:'CS Brand'");
  const drawing = textOf(await doc('drawing', 'html'));
  expect(drawing).toContain("font-family:'CS Brand'");
  expect(drawing).toContain(`font-family="'CS Brand','CS Sans'`);
  expect(textOf(await doc('formboard', 'html'))).toContain("font-family:'CS Brand'");
  // the drawing's PDF without a browser engine (rasterised) still draws, and the formboard's vector PDF embeds the face as a subset
  const rasterPdf = await doc('drawing', 'pdf');
  expect(rasterPdf.status, JSON.stringify(rasterPdf.body)).toBe(200);
  expect(textOf(rasterPdf).startsWith('%PDF-')).toBe(true);
  const vectorPdf = await doc('formboard', 'pdf');
  expect(vectorPdf.status, JSON.stringify(vectorPdf.body)).toBe(200);
  expect(textOf(vectorPdf)).toMatch(/\/BaseFont \/[A-Z]{6}\+BrandmarkSans1/);
  expect(textOf(vectorPdf)).toMatch(/\/BaseFont \/[A-Z]{6}\+BrandmarkSans1-Bold/);

  // drawing art: this hub's own faces and cutaways as data, cleaned on the way in
  const cutaway = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525 131"><script>alert(1)</script><rect id="zz-art-mark" width="10" height="10"/></svg>', width: 525, height: 131 };
  const badArt = await put({ art: { cutaways: { 'Not An Id': cutaway } } });
  expect(badArt.status).toBe(400);
  expect((await put({ art: { cutaways: { 'shielded-2pair-24awg': { svg: 1 } } } })).status).toBe(400);
  expect((await put({ art: { widgets: {} } })).status).toBe(400);
  const art = await put({ art: { cutaways: { 'shielded-2pair-24awg': cutaway }, faces: { 'de9-female': { material: 'Test face', width: 20, height: 10, art: [{ d: 'M0 0L5 5' }], pins: [{ id: '1', x: 2, y: 2, w: 2, h: 2, shape: 'circle' }], labels: [], src: 'synthetic example' } } } });
  expect(art.status, JSON.stringify(art.body)).toBe(200);
  expect(art.body.ownArt.cutaways['shielded-2pair-24awg'].svg).not.toContain('script');
  expect(art.body.art.faces['de9-female'].material).toBe('Test face');
  const reread = await call('GET', '/api/settings/branding', undefined, OWNER);
  expect(reread.body.ownArt.cutaways['shielded-2pair-24awg'].svg).toContain('zz-art-mark');
  expect(reread.body.art.cutaways['shielded-2pair-24awg']).toBeDefined();
  expect(((await call('GET', '/api/db')).body as Db).drawingArt?.faces?.['de9-female']).toBeDefined();
  const artDoc = await doc('drawing', 'html');
  expect(artDoc.status, JSON.stringify(artDoc.body)).toBe(200);
  const withArt = textOf(artDoc);
  expect(withArt).toContain('zz-art-mark');
  expect(withArt).not.toContain('alert(1)');
  // the typeface survives the art being saved (a PUT keeps what it does not mention)
  expect((await call('GET', '/api/settings/branding', undefined, OWNER)).body.font.regular.id).toBe(up.body.font.id);

  // removing them returns the generic sheets
  const cleared = await put({ font: null, art: null });
  expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  expect(cleared.body.font).toBeUndefined();
  expect(textOf(await doc('build-sheet', 'html'))).not.toContain("font-family:'CS Brand'");
  expect(textOf(await doc('drawing', 'html'))).not.toContain('zz-art-mark');
  expect(((await call('GET', '/api/db')).body as Db).drawingArt).toBeUndefined();
}

const fontPack = (version: string, withLicence: boolean) => ({
  format: 1,
  manifest: { format: 1, id: 'font-pack', name: 'A licensed face', version, license: 'CC0-1.0' },
  files: {
    'components.json': [{ id: 'font-pack-r', label: '5 ohm resistor', kind: 'resistor', value: '5', terminals: [{ id: 'a' }, { id: 'b' }], src: SRC }],
    'fonts/brandmark-regular.ttf': Buffer.from(brandmark(false)).toString('base64'),
    ...(withLicence ? { 'fonts/brandmark-regular.json': { family: 'Brandmark Sans', license: 'LicenseRef-synthetic-example', src: SRC } } : {}),
  },
});

export async function runPackFontFlow(call: FlowCall): Promise<void> {
  const doc = (kind: string) => call('GET', `/api/designs/de9-crossover/documents/${kind}?format=html`, undefined, OWNER);
  const etagOf = async (): Promise<string> => (await call('GET', '/api/settings/branding', undefined, OWNER)).headers?.['ETag'] ?? '';

  // a font without its licence sidecar is refused whole
  const bare = await call('POST', '/api/packs/install', { bundle: fontPack('1.0.0', false), apply: true }, OWNER);
  expect(bare.status, JSON.stringify(bare.body)).toBe(422);
  expect(JSON.stringify(bare.body)).toMatch(/needs fonts\/brandmark-regular\.json/);

  // installed, it is a font the hub may choose, from the pack, with no upload and no checkbox
  const done = await call('POST', '/api/packs/install', { bundle: fontPack('1.0.0', true), apply: true }, OWNER);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const fonts = (await call('GET', '/api/settings/branding/fonts', undefined, OWNER)).body.fonts as { id: string; source: string; pack?: string; family: string }[];
  expect(fonts.map((f) => [f.source, f.pack, f.family])).toEqual([['pack', 'font-pack', 'Brandmark Sans1']]);
  const set = await call('PUT', '/api/settings/branding', { font: { regular: fonts[0]!.id } }, OWNER, { 'if-match': await etagOf() });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.font.regular.id).toBe(fonts[0]!.id);
  expect(Buffer.from((await doc('build-sheet')).bytes ?? new Uint8Array()).toString('latin1')).toContain("font-family:'CS Brand'");

  // the pack goes: its font is no longer there, and the documents are set in the bundled sans again
  const gone = await call('DELETE', '/api/packs/font-pack', undefined, OWNER);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  expect((await call('GET', '/api/settings/branding', undefined, OWNER)).body.font).toBeUndefined();
  expect(Buffer.from((await doc('build-sheet')).bytes ?? new Uint8Array()).toString('latin1')).not.toContain("font-family:'CS Brand'");
}
