/**
 * Brother P-touch Editor `.lbx` files (cs-gqbj): one file per wire label, laid out as the tape preview
 * (`tape-label.ts`) shows it, for a shop that designs and prints in P-touch Editor.
 *
 * An `.lbx` is a zip of `label.xml` (the layout) and `prop.xml` (document properties). The files
 * written here use the element and attribute structure P-touch Editor 5.4 writes (the namespaces
 * `http://schemas.brother.info/ptouch/2007/lbx/...`). Text is one `text:text` object per template line
 * (font family by name: Editor uses the fonts installed on the PC that opens the file), the QR a
 * `barcode:barcode`. Deterministic: no clock (fixed timestamps), no randomness.
 *
 * Not inferred from a Brother file: `autoLength="true"` labels (Editor's own files in hand were
 * all fixed length: the auto-length form follows the bil-lbx library's reading), the QR object's
 * attributes (bil-lbx, MIT), and the `.lbx` paper values of tapes other than 12 mm (`label-presets.ts`).
 * A QR on a light-ink-on-dark tape is left out of the `.lbx` (Editor would print it as a negative),
 * the preview and PDF still show it.
 */

import { registeredBrandFont, registeredTitleBlock } from '../drawing/assets.ts';
import { PT_PER_MM, END_MARGIN_MM, isDarkTape, tapeLayout, type TapeLayout } from './tape-label.ts';
import { labelPresetOf, type LabelPreset } from './label-presets.ts';
import { tapeContent, type LabelSheetOptions, type WireLabel } from './labels.ts';
import { zipStored } from './table.ts';

export interface LbxPrinter {
  id: string;
  label: string;
  /** `style:paper` printerName / printerID */
  printerName: string;
  printerId: number;
  src: string;
}

export const LBX_PRINTERS: readonly LbxPrinter[] = [
  { id: 'generic', label: 'Any P-touch printer', printerName: 'Brother P-touch', printerId: 0, src: 'Generic values: P-touch Editor picks a printer when the named one is not installed (not verified against Editor).' },
  { id: 'pt-d610bt', label: 'Brother PT-D610BT', printerName: 'Brother PT-D610BT', printerId: 31792, src: 'Brother PT-D610BT as P-touch Editor 5.4 names it, with its printer id from Editor-written files.' },
];

export const LBX_PRINTER_IDS: readonly string[] = LBX_PRINTERS.map((p) => p.id);

export function lbxPrinterOf(id: string | undefined): LbxPrinter {
  return LBX_PRINTERS.find((p) => p.id === (id ?? registeredTitleBlock().labelPrinter)) ?? (LBX_PRINTERS[0] as LbxPrinter);
}

/* ------------------------------------------------------------------ *
 * XML
 * ------------------------------------------------------------------ */

const esc = (v: string | number | boolean): string => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = (name: string, attrs: Record<string, string | number | boolean> = {}, ...children: string[]): string => {
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return children.length === 0 ? `<${name}${a}/>` : `<${name}${a}>${children.join('')}</${name}>`;
};
const text = (name: string, value: string): string => `<${name}>${esc(value)}</${name}>`;
const pt = (mm: number): string => `${Math.round(mm * PT_PER_MM * 10) / 10}pt`;
const ptv = (v: number): string => `${Math.round(v * 10) / 10}pt`;

const NS = {
  'xmlns:pt': 'http://schemas.brother.info/ptouch/2007/lbx/main',
  'xmlns:style': 'http://schemas.brother.info/ptouch/2007/lbx/style',
  'xmlns:text': 'http://schemas.brother.info/ptouch/2007/lbx/text',
  'xmlns:draw': 'http://schemas.brother.info/ptouch/2007/lbx/draw',
  'xmlns:image': 'http://schemas.brother.info/ptouch/2007/lbx/image',
  'xmlns:barcode': 'http://schemas.brother.info/ptouch/2007/lbx/barcode',
  'xmlns:database': 'http://schemas.brother.info/ptouch/2007/lbx/database',
  'xmlns:table': 'http://schemas.brother.info/ptouch/2007/lbx/table',
  'xmlns:cable': 'http://schemas.brother.info/ptouch/2007/lbx/cable',
};

const objectStyle = (x: number, y: number, w: number, h: number, name: string): string =>
  el(
    'pt:objectStyle',
    { x: ptv(x), y: ptv(y), width: ptv(w), height: ptv(h), backColor: '#FFFFFF', backPrintColorNumber: '0', ropMode: 'COPYPEN', angle: '0', anchor: 'TOPLEFT', flip: 'NONE' },
    el('pt:pen', { style: 'NULL', widthX: '0.5pt', widthY: '0.5pt', color: '#000000', printColorNumber: '1' }),
    el('pt:brush', { style: 'NULL', color: '#000000', printColorNumber: '1', id: '0' }),
    el('pt:expanded', { objectName: name, ID: '0', lock: '0', templateMergeTarget: 'LABELLIST', templateMergeType: 'NONE', templateMergeID: '0', linkStatus: 'NONE', linkID: '0' }),
  );

const FALLBACK_FAMILY = 'Arial';

function textObject(row: TapeLayout['rows'][number], layout: TapeLayout, index: number, marginPt: number, bandTop: number): string {
  const family = row.family ?? registeredBrandFont()?.regular.family ?? FALLBACK_FAMILY;
  const fontInfo = (): string =>
    el(
      'text:ptFontInfo',
      {},
      el('text:logFont', { name: family, width: '0', italic: 'false', weight: row.bold ? '700' : '400', charSet: '0', pitchAndFamily: '2' }),
      el('text:fontExt', { effect: 'NOEFFECT', underline: '0', strikeout: '0', size: ptv(row.sizePt), orgSize: '28.8pt', textColor: '#000000', textPrintColorNumber: '1' }),
    );
  const fixed = !layout.autoLength;
  return el(
    'text:text',
    {},
    objectStyle(layout.left * PT_PER_MM, marginPt + (row.top - bandTop) * PT_PER_MM, layout.width * PT_PER_MM, row.height * PT_PER_MM, `Text${index + 1}`),
    fontInfo(),
    el('text:textControl', { control: fixed ? 'LONGTEXTFIXED' : 'FREE', clipFrame: 'false', aspectNormal: 'true', shrink: fixed, autoLF: 'false', avoidImage: 'false' }),
    el('text:textAlign', { horizontalAlignment: row.align.toUpperCase(), verticalAlignment: 'CENTER', inLineAlignment: 'BASELINE' }),
    el('text:textStyle', { vertical: 'false', nullBlock: 'false', charSpace: '0', lineSpace: '0', orgPoint: ptv(row.sizePt), combinedChars: 'false' }),
    text('pt:data', row.text),
    el('text:stringItem', { charLen: [...row.text].length }, fontInfo()),
  );
}

function qrObject(layout: TapeLayout, marginPt: number, bandTop: number): string | undefined {
  const qr = layout.qr;
  if (qr === undefined || isDarkTape(layout.tape)) return undefined;
  const cell = Math.round((qr.size / qr.modules) * PT_PER_MM * 10) / 10;
  return el(
    'barcode:barcode',
    {},
    objectStyle(qr.x * PT_PER_MM, marginPt + (qr.y - bandTop) * PT_PER_MM, qr.size * PT_PER_MM, qr.size * PT_PER_MM, 'QR'),
    el('barcode:barcodeStyle', { protocol: 'QRCODE', lengths: String(qr.payload.length), zeroFill: 'false', barWidth: '1.2pt', barRatio: '1:3', humanReadable: 'false', humanReadableAlignment: 'LEFT', checkDigit: 'false', autoLengths: 'false', margin: 'false', sameLengthBar: 'false', bearerBar: 'false' }),
    el('barcode:qrcodeStyle', { model: '2', eccLevel: '15%', cellSize: ptv(cell), mbcs: '932', removeCharKind: '0', removeCharString: '', joint: '1', jointSpace: '8', jointVertically: 'false', version: 'auto', changeVersionDrag: 'false' }),
    text('pt:data', qr.payload),
  );
}

export interface LbxFile {
  /** `label.xml` */
  labelXml: string;
  /** `prop.xml` */
  propXml: string;
  /** what could not be put in the file, in words */
  notes: string[];
}

export interface LbxOptions {
  printer?: LbxPrinter;
  /** the design revision, written to the properties */
  revision?: number;
}

/** The two XML parts of one label's `.lbx`. */
export function lbxParts(label: WireLabel, preset: LabelPreset, options: LabelSheetOptions = {}, lbx: LbxOptions = {}): LbxFile {
  if (preset.kind !== 'tape' || preset.tape === undefined) throw new Error(`'${preset.id}' is not a P-touch tape; use one of the tze-… presets.`);
  const layout = tapeLayout(label, preset, tapeContent(options));
  const { tape } = layout;
  const printer = lbx.printer ?? lbxPrinterOf(options.printer);
  const margin = tape.width.marginPt;
  const paperLength = Math.round(layout.lengthMm * PT_PER_MM * 10) / 10;
  const bandLength = Math.max(0, paperLength - 2 * END_MARGIN_MM * PT_PER_MM);
  const notes: string[] = [];
  if (layout.qrNote !== undefined) notes.push(layout.qrNote);
  const qr = qrObject(layout, margin, layout.bandTop);
  if (layout.qr !== undefined && qr === undefined) notes.push('QR left out of the .lbx: on light ink over dark tape P-touch would print it as a negative. The preview and PDF show it.');
  const objects = [...layout.rows.map((r, i) => textObject(r, layout, i, margin, layout.bandTop)), ...(qr === undefined ? [] : [qr])];
  const dark = isDarkTape(tape);
  const paper = el('style:paper', {
    media: '0',
    width: ptv(tape.width.paperPt),
    height: layout.autoLength ? '2834.4pt' : ptv(paperLength),
    marginLeft: ptv(margin),
    marginTop: '5.6pt',
    marginRight: ptv(margin),
    marginBottom: '5.6pt',
    orientation: 'landscape',
    autoLength: layout.autoLength,
    monochromeDisplay: 'true',
    printColorDisplay: 'false',
    printColorsID: '0',
    paperColor: dark ? '#000000' : '#FFFFFF',
    paperInk: dark ? '#FFFFFF' : '#000000',
    split: '1',
    format: tape.width.format,
    backgroundTheme: '0',
    printerID: printer.printerId,
    printerName: printer.printerName,
  });
  const labelXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    el(
      'pt:document',
      { ...NS, version: '1.7', generator: 'WireHub' },
      el(
        'pt:body',
        { currentSheet: 'Sheet 1', direction: 'LTR' },
        el(
          'style:sheet',
          { name: 'Sheet 1' },
          paper,
          el('style:cutLine', { regularCut: '0pt', freeCut: '' }),
          el('style:backGround', { x: '5.6pt', y: ptv(margin), width: ptv(bandLength), height: ptv(tape.width.paperPt - 2 * margin), brushStyle: 'NULL', brushId: '0', userPattern: 'NONE', userPatternId: '0', color: '#000000', printColorNumber: '1', backColor: '#FFFFFF', backPrintColorNumber: '0' }),
          el('pt:objects', {}, ...objects),
        ),
      ),
    );
  const stamp = '2000-01-01T00:00:00Z';
  const propXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    el(
      'meta:properties',
      { 'xmlns:meta': 'http://schemas.brother.info/ptouch/2007/lbx/meta', 'xmlns:dc': 'http://purl.org/dc/elements/1.1/', 'xmlns:dcterms': 'http://purl.org/dc/terms/' },
      text('meta:appName', 'WireHub'),
      text('dc:title', label.lines[0] ?? label.id),
      text('dc:subject', label.id),
      text('dc:creator', 'WireHub'),
      text('meta:keyword', ''),
      text('dc:description', notes.join(' ')),
      text('meta:template', ''),
      text('dcterms:created', stamp),
      text('dcterms:modified', stamp),
      text('meta:lastPrinted', ''),
      text('meta:modifiedBy', 'WireHub'),
      text('meta:revision', String(lbx.revision ?? 1)),
      text('meta:editTime', '0'),
      text('meta:numPages', '1'),
      text('meta:numWords', '0'),
      text('meta:numChars', '0'),
      text('meta:security', '0'),
    );
  return { labelXml, propXml, notes };
}

const enc = new TextEncoder();

/** One label as an `.lbx` file (a stored zip of `label.xml` and `prop.xml`). */
export function lbxFile(label: WireLabel, preset: LabelPreset, options: LabelSheetOptions = {}, lbx: LbxOptions = {}): { bytes: Uint8Array; notes: string[] } {
  const parts = lbxParts(label, preset, options, lbx);
  return { bytes: zipStored([{ name: 'label.xml', data: enc.encode(parts.labelXml) }, { name: 'prop.xml', data: enc.encode(parts.propXml) }]), notes: parts.notes };
}

const safe = (v: string): string => v.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/** The file name of a label's `.lbx`: `<design>-<label id>.lbx`. */
export function lbxFileName(label: WireLabel, design?: string): string {
  return `${[design, label.id].filter((v): v is string => v !== undefined && v !== '').map(safe).join('-')}.lbx`;
}

/** The tape preset an `.lbx` is made for: the one asked for (a tape), else the hub's if it is a tape, else TZe-335 12 mm white on black. */
export function lbxPresetFor(options: LabelSheetOptions): LabelPreset {
  const asked = labelPresetOf(options.preset);
  if (asked !== undefined) {
    if (asked.kind !== 'tape') throw new Error(`'${asked.id}' is not a P-touch tape; use one of the tze-… presets.`);
    return asked;
  }
  const hub = labelPresetOf(registeredTitleBlock().labelPreset);
  return hub?.kind === 'tape' ? hub : (labelPresetOf('tze-12-335') as LabelPreset);
}

export interface LbxOutput {
  mimeType: string;
  fileName: string;
  body: Uint8Array;
  notes: string[];
}

/**
 * The `.lbx` export of a design's labels: one label (`page` picks the n-th, copies counted) is that
 * `.lbx`; otherwise a zip with one `.lbx` per label. P-touch Editor opens one label per file.
 */
export function lbxExport(labels: readonly WireLabel[], options: LabelSheetOptions = {}, stem = 'labels', revision?: number): LbxOutput {
  const preset = lbxPresetFor(options);
  const lbx: LbxOptions = { printer: lbxPrinterOf(options.printer), ...(revision === undefined ? {} : { revision }) };
  const copies = Math.max(1, Math.floor(options.copies ?? 1));
  const all = labels.flatMap((l) => Array.from({ length: copies }, () => l));
  const pick = options.page === undefined ? undefined : all[Math.min(Math.max(1, Math.floor(options.page)), all.length) - 1];
  const chosen = pick === undefined ? labels : [pick];
  const files = chosen.map((l) => ({ label: l, ...lbxFile(l, preset, options, lbx) }));
  const notes = [...new Set(files.flatMap((f) => f.notes))];
  if (files.length === 1) {
    const only = files[0] as (typeof files)[number];
    return { mimeType: 'application/octet-stream', fileName: lbxFileName(only.label, options.design), body: only.bytes, notes };
  }
  const seen = new Set<string>();
  const entries = files.map((f) => {
    let name = lbxFileName(f.label, undefined);
    while (seen.has(name)) name = name.replace(/\.lbx$/, '-2.lbx');
    seen.add(name);
    return { name, data: f.bytes };
  });
  return { mimeType: 'application/zip', fileName: `${stem}.zip`, body: zipStored(entries), notes };
}
