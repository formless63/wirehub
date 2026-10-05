/**
 * The wire spec sheet — a generated specification for one wire stock.
 *
 * Modelled on the sheets stocks are bought against — the manufacturers'
 * datasheets and cable specifications: a title block, a description, the colour /
 * signal map, a table per construction (conductor, shielded core, insulated
 * core, outer jacket), the cross-section drawn **to scale** with its lay
 * note, the performance block as the vendor states it, and the revision
 * history.
 *
 * Everything on the sheet derives from the compiled `WireDefinition` (the
 * record every other document reads); the recipe and its parts, when given,
 * add what only a vendor sheet knows — tolerances, AWG, nominal Ø, lay
 * length, performance figures — each cited. Grounding follows the shield
 * bonding rules: a foil or tape is never shown as a ground (it is trimmed
 * back), a fully bonded stock's shields are one copper mass, and a coax
 * stock's ground at the source is its drain.
 *
 * House rules as the rest of the package: deterministic string output, no
 * clock (a date only appears when the caller or the recipe gives one), no
 * external resource, every class `cs-`-prefixed.
 *
 * **Document number.** The stock's part number, in its canonical form, and
 * nothing else; a stock with no part number yet prints its id. Exported,
 * downloaded and printed files are named `<prefix><document
 * number>` (the prefix is `WIRE_SPEC_FILE_PREFIX` unless the hub's branding sets one). The organisation's name and its standard's name are options (a
 * branding module sets them); a source document (`specRef`, the vendor's own
 * files) is a citation only; the manufacturer is a field of the stock.
 */

import {
  canonicalPartNumber,
  isGroup,
  resolveElementPath,
  signalWordsOf,
  type ConductorElement,
  type Element,
  type GroupElement,
  type InsulationElement,
  type ShieldElement,
  type WireDefinition,
  type WirePart,
  type WireRecipe,
} from '@wirehub/model';
import { renderCrossSection } from '@wirehub/render-svg';

import { registeredTitleBlock } from './drawing/assets.ts';
import { brandSheetCss } from './drawing/brand-font.ts';
import { escapeHtml } from './text.ts';

export interface WireSpecOptions {
  /** the recipe the stock was compiled from — adds tolerances, performance, revisions */
  recipe?: WireRecipe;
  /** the parts library the recipe names */
  parts?: readonly WirePart[];
  /** overrides the revision (default: the recipe's latest revision) */
  revision?: string;
  /** a date to print; omitted = the latest revision's date, else none */
  date?: string;
  /** return the `.cs-root` fragment only, for embedding */
  fragment?: boolean;
  /** paper size for `@page` (default A4) */
  paper?: 'A4' | 'Letter';
  /** the `manufacturers` vocab list's entries — the manufacturer's name (default: its id, title-cased) */
  manufacturers?: readonly { id: string; label: string }[];
  /** where a vendor document opens in-app (an asset URL); omitted = cited by name only */
  vendorDocHref?: (asset: string) => string | undefined;
  /** the organisation the sheet is issued by (the header mark); default `WireHub` */
  organisation?: string;
  /** the name of the document standard (default `WIRE_SPEC_STANDARD`) */
  standard?: string;
  /** a rights / confidentiality line for the footer; omitted = none */
  rightsNotice?: string;
  /** the prefix of the sheet's file name and print title (default: the registered branding's, else `WIRE_SPEC_FILE_PREFIX`) */
  filePrefix?: string;
}

/** What the generated sheets are called, unless the caller names its own standard. */
export const WIRE_SPEC_STANDARD = 'WireHub Standard';
/** The prefix of every exported, downloaded or printed spec-sheet file. */
export const WIRE_SPEC_FILE_PREFIX = 'WSS_';

/* ------------------------------------------------------------------ *
 * Reading the stock
 * ------------------------------------------------------------------ */

interface CoreRow {
  path: string;
  colour: string;
  signal: string;
  kind: 'coax' | 'shielded-core' | 'plain' | 'insulated';
  conductor?: ConductorElement;
  dielectric?: InsulationElement;
  insulation?: InsulationElement;
  shield?: ShieldElement;
  sheath?: InsulationElement;
}

function coreRows(wire: WireDefinition, recipe: WireRecipe | undefined): CoreRow[] {
  const rows: CoreRow[] = [];
  for (const child of wire.structure.children) {
    const recipeCore = recipe?.cores.find((core) => core.id === child.id);
    if (isGroup(child)) {
      const conductor = child.children.find((c): c is ConductorElement => c.kind === 'conductor');
      const colour = recipeCore?.colour ?? conductor?.color ?? '';
      const shield = child.children.find((c): c is ShieldElement => c.kind === 'shield');
      const byId = (id: string): InsulationElement | undefined =>
        child.children.find((c): c is InsulationElement => c.kind === 'insulation' && c.id === id);
      rows.push({
        path: child.id,
        colour,
        signal: recipeCore === undefined ? signalFromLabel(child) : signalWordsOf(recipeCore),
        kind: child.role === 'coax' ? 'coax' : shield === undefined ? 'insulated' : 'shielded-core',
        ...(conductor === undefined ? {} : { conductor }),
        ...(byId('dielectric') === undefined ? {} : { dielectric: byId('dielectric')! }),
        ...(byId('insulation') === undefined ? {} : { insulation: byId('insulation')! }),
        ...(shield === undefined ? {} : { shield }),
        ...(byId('sheath') === undefined ? {} : { sheath: byId('sheath')! }),
      });
    } else if (child.kind === 'conductor' && child.bare !== true) {
      rows.push({
        path: child.id,
        colour: recipeCore?.colour ?? child.color ?? '',
        signal: recipeCore === undefined ? signalFromLabel(child) : signalWordsOf(recipeCore),
        kind: 'plain',
        conductor: child,
      });
    }
  }
  return rows;
}

/** "Video R coax (red)" → "Video R" — the stock's own words when there is no recipe. */
function signalFromLabel(element: Element): string {
  const label = element.label ?? element.id;
  return label.replace(/\s+(coax|shielded core|centre conductor|conductor)\b.*$/i, '').replace(/\s*\(.*\)$/, '');
}

function mmText(value: number | undefined, tol?: number): string {
  if (value === undefined) return '—';
  const text = `${value.toFixed(2)} mm`;
  return tol === undefined ? text : `${text} (± ${tol.toFixed(2)})`;
}

function titleCase(value: string): string {
  return value.replace(/(^|\s)([a-z])/g, (_m, space: string, ch: string) => `${space}${ch.toUpperCase()}`);
}

/** "Copper braid", "Aluminium/polyester foil" — never "foil foil". */
function shieldingWords(shield: ShieldElement): string {
  const material = shield.material ?? '';
  const words = material.toLowerCase().includes(shield.construction) ? material : `${material} ${shield.construction}`;
  const text = words.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function partOf(parts: ReadonlyMap<string, WirePart>, id: string | undefined): WirePart | undefined {
  return id === undefined ? undefined : parts.get(id);
}

/* ------------------------------------------------------------------ *
 * HTML helpers
 * ------------------------------------------------------------------ */

const e = escapeHtml;

function specTable(title: string, rows: [string, string][], note?: string): string {
  if (rows.length === 0) return '';
  return [
    '<section class="cs-ws-block">',
    `<h3 class="cs-ws-h">${e(title)}</h3>`,
    '<table class="cs-ws-kv"><tbody>',
    ...rows.map(([k, v]) => `<tr><th scope="row">${e(k)}</th><td>${e(v)}</td></tr>`),
    '</tbody></table>',
    note === undefined ? '' : `<p class="cs-ws-note">${e(note)}</p>`,
    '</section>',
  ].join('');
}

const SWATCH: Readonly<Record<string, string>> = {
  red: '#c8102e',
  green: '#00843d',
  blue: '#0033a0',
  yellow: '#f2c500',
  white: '#ffffff',
  black: '#1b1b1b',
  brown: '#6b4226',
  purple: '#6d2a8a',
  orange: '#e27000',
  grey: '#8a8d8f',
};

function swatch(colour: string): string {
  const paint = SWATCH[colour] ?? '#cccccc';
  return `<span class="cs-ws-sw" style="background:${paint}" aria-hidden="true"></span>`;
}

/* ------------------------------------------------------------------ *
 * The sheet
 * ------------------------------------------------------------------ */

/** The document number the sheet carries: the stock's canonical part number, else its id (see above). */
export function wireSpecDocNumber(wire: WireDefinition): string {
  return canonicalPartNumber(wire.partNumber) ?? wire.partNumber ?? wire.id;
}

/** What a file prefix may be: letters, digits, dot, dash and underscore (it is part of a file name). */
export const FILE_PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,16}$/;

/**
 * `WSS_2W-300112-00` — the file name (without extension) an export, download
 * or print takes. The prefix is `prefix`, else the registered branding's
 * (the hub's setting), else `WIRE_SPEC_FILE_PREFIX`; an unusable one falls back.
 */
export function wireSpecFileStem(wire: WireDefinition, prefix?: string): string {
  const chosen = [prefix, registeredTitleBlock().filePrefix].find((p) => p !== undefined && FILE_PREFIX_PATTERN.test(p)) ?? WIRE_SPEC_FILE_PREFIX;
  return `${chosen}${wireSpecDocNumber(wire).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

/** `WSS_2W-300112-00.html` / `.pdf`. */
export function wireSpecFileName(wire: WireDefinition, ext: 'html' | 'pdf' = 'html', prefix?: string): string {
  return `${wireSpecFileStem(wire, prefix)}.${ext}`;
}

/** The manufacturer's name, from the vocab list when given. */
export function wireManufacturerName(
  wire: Pick<WireDefinition, 'manufacturer'>,
  manufacturers?: readonly { id: string; label: string }[],
): string | undefined {
  if (wire.manufacturer === undefined || wire.manufacturer === '') return undefined;
  return manufacturers?.find((entry) => entry.id === wire.manufacturer)?.label ?? titleCase(wire.manufacturer);
}

/** Scale the cutaway so it prints about 70 mm across: the largest of these that fits. */
export function wireSpecScale(odMm: number | undefined): number {
  const scales = [25, 20, 15, 12, 10, 8, 6, 5, 4];
  if (odMm === undefined || odMm <= 0) return 8;
  return scales.find((s) => s * odMm <= 75) ?? 4;
}

/** How the stock is grounded, in the owner's words (shield-bonding rules). */
export function groundingNotes(wire: WireDefinition): string[] {
  const notes: string[] = [];
  const root = wire.structure;
  const overall = root.children.find((c): c is ShieldElement => c.kind === 'shield');
  const drain = root.children.find((c): c is ConductorElement => c.kind === 'conductor' && c.bare === true);
  const coreShields = root.children.filter(isGroup).flatMap((g) =>
    g.children.filter((c) => c.kind === 'shield').map((c) => `${g.id}.${c.id}`),
  );
  const mass = (wire.bonded ?? []).find(
    (set) => coreShields.length > 0 && coreShields.every((path) => set.members.includes(path)),
  );
  const foil = overall !== undefined && (overall.construction === 'foil' || overall.construction === 'tape');
  if (mass !== undefined) {
    notes.push(
      `All ${coreShields.length} core shields${drain !== undefined && mass.members.includes(drain.id) ? ' and the drain' : ''} are one copper mass for the whole length: terminate them together, as one.`,
    );
  } else if (coreShields.length > 0) {
    notes.push('Each core shield is its own screen: twist it to the ground pad on the same face as its signal.');
  }
  if (foil) notes.push(`The ${overall.construction} is trimmed back at both ends and never landed.`);
  if (drain !== undefined && mass === undefined) {
    notes.push('The drain stands for the foil and drain together: land it at the source end only, cut it at the destination.');
  }
  if (overall !== undefined && !foil) notes.push(`The overall ${overall.construction} shield is the ground return.`);
  return notes;
}

function layNote(wire: WireDefinition, rows: CoreRow[]): string {
  const lay = wire.layOrder;
  if (lay === undefined) return '';
  const name = (path: string): string => titleCase(rows.find((row) => row.path === path)?.colour ?? path);
  if (lay.arrangement === 'figure-8') {
    const other = lay.viewedFrom === undefined ? undefined : lay.viewedFrom === 'source' ? 'destination' : 'source';
    return `Figure-8: two legs moulded side by side. Left to right${lay.viewedFrom === undefined ? '' : ` looking into the ${lay.viewedFrom} end`}: ${lay.ring.map(name).join(', ')}${other === undefined ? '' : ` (the ${other} end reads them right to left)`}.`;
  }
  const other = lay.direction === 'ccw' ? 'CW' : 'CCW';
  const from = lay.viewedFrom === undefined ? '' : ` (looking into the ${lay.viewedFrom} end; the ${lay.viewedFrom === 'source' ? 'destination' : 'source'} end reads ${other})`;
  const centre =
    lay.center !== undefined
      ? ` Centre: ${name(lay.center)}.`
      : lay.inner !== undefined
        ? ` Centre pair: ${lay.inner.map(name).join(', ')}.`
        : '';
  return `Adhere to color order shown. ${lay.direction.toUpperCase()} from 12 o'clock: ${lay.ring.map(name).join(', ')}${from}.${centre}`;
}

/** The spec sheet, as a standalone printable HTML document (or a fragment). */
export function renderWireSpecSheet(wire: WireDefinition, options: WireSpecOptions = {}): string {
  const branding = registeredTitleBlock();
  const organisation = options.organisation ?? branding.organisation ?? 'WireHub';
  const standard = options.standard ?? branding.standard ?? WIRE_SPEC_STANDARD;
  const rightsNotice = options.rightsNotice ?? branding.rights;
  const recipe = options.recipe;
  const parts = new Map((options.parts ?? []).map((part) => [part.id, part]));
  const rows = coreRows(wire, recipe);
  const docNumber = wireSpecDocNumber(wire);
  const latest = recipe?.revisions?.[recipe.revisions.length - 1];
  const revision = options.revision ?? latest?.rev ?? '—';
  const date = options.date ?? latest?.date;
  const root = wire.structure;
  const jacket = root.children.find((c): c is InsulationElement => c.kind === 'insulation' && c.id === 'jacket')
    ?? root.children.filter((c): c is InsulationElement => c.kind === 'insulation').pop();
  const overall = root.children.find((c): c is ShieldElement => c.kind === 'shield');
  const drain = root.children.find((c): c is ConductorElement => c.kind === 'conductor' && c.bare === true);
  const jacketPart = partOf(parts, recipe?.jacket);
  const drainPart = partOf(parts, recipe?.overall?.drain);

  /* --- colour / signal map ---------------------------------------- */

  const kindWord: Record<CoreRow['kind'], string> = {
    coax: 'coax',
    'shielded-core': 'shielded',
    insulated: 'insulated',
    plain: 'insulated',
  };
  const lay = wire.layOrder;
  const layIndex = (path: string): string => {
    if (lay === undefined) return '';
    const at = lay.ring.indexOf(path);
    if (at >= 0) return String(at + 1);
    if (lay.center === path) return 'C';
    const inner = lay.inner?.indexOf(path) ?? -1;
    return inner >= 0 ? `C${inner + 1}` : '';
  };
  const mapRows = rows.map(
    (row) =>
      `<tr><td class="cs-ws-num">${e(layIndex(row.path))}</td><td>${swatch(row.colour)}${e(titleCase(row.colour))}</td>` +
      `<td>${e(row.signal)}</td><td>${e(kindWord[row.kind])}</td><td>${row.shield === undefined ? 'no' : 'yes'}</td></tr>`,
  );
  if (drain !== undefined) {
    mapRows.push(
      `<tr><td class="cs-ws-num">D</td><td>${swatch('grey')}Bare</td><td>Drain</td><td>drain</td><td>—</td></tr>`,
    );
  }
  const colourMap = [
    '<section class="cs-ws-block">',
    '<h3 class="cs-ws-h">Conductors and lay</h3>',
    '<table class="cs-ws-grid"><thead><tr><th>Lay</th><th>Colour</th><th>Signal</th><th>Built as</th><th>Shielded</th></tr></thead><tbody>',
    ...mapRows,
    '</tbody></table>',
    '</section>',
  ].join('');

  /* --- construction tables ----------------------------------------- */

  const conductorBlocks: string[] = [];
  const seenFormation = new Set<string>();
  for (const row of rows) {
    const c = row.conductor;
    if (c === undefined) continue;
    const key = `${c.material}|${c.formation}|${c.odMm}`;
    if (seenFormation.has(key)) continue;
    seenFormation.add(key);
    const recipeCore = recipe?.cores.find((core) => core.id === row.path);
    const assembly = partOf(parts, recipeCore?.part);
    const conductorPart = partOf(parts, recipeCore?.conductor ?? (assembly?.kind === 'core' ? assembly.conductor : undefined));
    const cp = conductorPart?.kind === 'conductor' ? conductorPart : undefined;
    const users = rows.filter((r) => r.conductor !== undefined && `${r.conductor.material}|${r.conductor.formation}|${r.conductor.odMm}` === key);
    conductorBlocks.push(
      specTable(
        seenFormation.size === 1 && rows.every((r) => users.includes(r)) ? 'Conductor specifications' : `Conductor specifications — ${users.map((u) => titleCase(u.colour)).join(', ')}`,
        [
          ['Type', titleCase(c.material?.split(',')[0] ?? '—')],
          ...(c.formation === undefined ? [] : [['Formation (strands × Ø)', c.formation.replace(/^[A-Z]+ /, '').replace('x', ' × ')] as [string, string]]),
          ...(cp?.awg === undefined ? [] : [['Gauge', cp.awg] as [string, string]]),
          ...(c.areaMm2 === undefined ? [] : [['Nominal area', `${c.areaMm2} mm²`] as [string, string]]),
          ...(cp?.nominalMm === undefined ? [] : [['Nominal diameter', mmText(cp.nominalMm)] as [string, string]]),
          ...(c.odMm === undefined ? [] : [['Outer diameter', mmText(c.odMm)] as [string, string]]),
          ...(cp?.strandTolMm === undefined ? [] : [['Strand tolerance', `± ${cp.strandTolMm} mm`] as [string, string]]),
        ],
      ),
    );
  }

  const shielded = rows.filter((row) => row.shield !== undefined);
  const shieldedBlock = (() => {
    if (shielded.length === 0) return '';
    const first = shielded[0]!;
    const recipeCore = recipe?.cores.find((core) => core.id === first.path);
    const assembly = partOf(parts, recipeCore?.part);
    const shieldPart = partOf(parts, assembly?.kind === 'core' ? assembly.shield : undefined);
    const sp = shieldPart?.kind === 'shield' ? shieldPart : undefined;
    const ins = first.dielectric ?? first.insulation;
    const insPart = partOf(parts, assembly?.kind === 'core' ? (assembly.dielectric ?? assembly.insulation) : undefined);
    const sheathPart = partOf(parts, assembly?.kind === 'core' ? assembly.sheath : undefined);
    const tol = (p: WirePart | undefined): number | undefined => (p?.kind === 'insulation' ? p.tolMm : undefined);
    const shield = first.shield!;
    const legs = wire.layOrder?.arrangement === 'figure-8';
    const rowsOut: [string, string][] = [
      ['Number of shielded cores', String(shielded.length)],
      ...(ins === undefined ? [] : [[first.dielectric === undefined ? 'Core insulation' : 'Dielectric', ins.material ?? '—'] as [string, string], ['Insulated diameter', mmText(ins.odMm, tol(insPart))] as [string, string]]),
      ['Shielding', shieldingWords(shield)],
      ...(sp?.strands === undefined || sp.strandMm === undefined ? [] : [['Shield construction', `${sp.strands} × ${sp.strandMm.toFixed(2)} mm${sp.layMm === undefined ? '' : `, lay ${sp.layMm}${sp.layTolMm === undefined ? '' : ` ± ${sp.layTolMm}`} mm`}${sp.hand === undefined ? '' : ` ${sp.hand}`}`] as [string, string]]),
      ...(shield.coveragePct === undefined ? [] : [['Shielding coverage', shield.coveragePct] as [string, string]]),
      ['Shielded diameter', mmText(shield.odMm)],
      ...(first.sheath === undefined
        ? []
        : [
            [legs ? 'Leg jacket' : 'Sheath', `${legs && first.sheath.color !== undefined ? `${titleCase(first.sheath.color)} ` : ''}${first.sheath.material ?? '—'}`] as [string, string],
            [legs ? 'Leg jacket diameter' : 'Sheath diameter', mmText(first.sheath.odMm, tol(sheathPart))] as [string, string],
          ]),
      ['Colours', shielded.map((row) => titleCase(row.colour)).join(', ')],
    ];
    return specTable(first.kind === 'coax' ? 'Shielded conductor specifications (coax)' : 'Shielded conductor specifications', rowsOut);
  })();

  const insulatedRows = rows.filter((row) => row.shield === undefined);
  const insulatedBlock = (() => {
    if (insulatedRows.length === 0) return '';
    const first = insulatedRows[0]!;
    const od = first.kind === 'plain' ? first.conductor?.insulatedOdMm : first.insulation?.odMm;
    const recipeCore = recipe?.cores.find((core) => core.id === first.path);
    const assembly = partOf(parts, recipeCore?.part);
    const insPart = partOf(parts, assembly?.kind === 'core' ? assembly.insulation : undefined);
    const material = insPart?.kind === 'insulation' ? insPart.material : first.insulation?.material ?? first.conductor?.material?.split(',').slice(1).join(',').replace(/insulated/i, '').trim();
    return specTable('Insulated conductor specifications', [
      ['Number of insulated cores', String(insulatedRows.length)],
      ['Core insulation', material === undefined || material === '' ? '—' : material],
      ['Insulated diameter', mmText(od, insPart?.kind === 'insulation' ? insPart.tolMm : undefined)],
      ['Shielding coverage', '0 %'],
      ['Colours', insulatedRows.map((row) => titleCase(row.colour)).join(', ')],
    ]);
  })();

  const jacketRows: [string, string][] = [];
  const profile = wire.profile;
  if (profile?.shape === 'figure-8') {
    jacketRows.push(['Construction', 'Figure-8: two jacketed legs moulded together, no overall jacket']);
    if (jacket !== undefined) jacketRows.push(['Jacket type', `${titleCase(jacket.color ?? '')} ${jacket.material ?? ''}`.trim()]);
    jacketRows.push(['Overall width × height', `${profile.widthMm.toFixed(2)} × ${profile.heightMm.toFixed(2)} mm`]);
    jacketRows.push(['Leg diameter', mmText(profile.legOdMm)]);
    jacketRows.push(['Leg pitch (centre to centre)', mmText(profile.pitchMm)]);
    jacketRows.push(['Web thickness', `${mmText(profile.webMm)}${/INFERRED/.test(profile.src) ? ' (inferred)' : ''}`]);
  } else if (jacket !== undefined) {
    jacketRows.push(['Jacket type', `${titleCase(jacket.color ?? '')} ${jacket.material ?? ''}`.trim()]);
    jacketRows.push(['Outer cable diameter', mmText(jacket.odMm ?? wire.odMm, jacketPart?.kind === 'jacket' ? jacketPart.tolMm : undefined)]);
  }
  if (overall !== undefined) {
    jacketRows.push(['Shielding', shieldingWords(overall)]);
    if (overall.coveragePct !== undefined) jacketRows.push(['Shielding coverage', overall.coveragePct]);
    if (overall.odMm !== undefined) jacketRows.push(['Ø over the shield', mmText(overall.odMm)]);
  }
  if (drain !== undefined) {
    jacketRows.push(['Drain wire', `${drain.formation ?? 'bare copper'}${drain.odMm === undefined ? '' : `, Ø ${drain.odMm.toFixed(2)} mm`}${/INFERRED/.test(drain.src ?? '') ? ' (Ø inferred)' : ''}`]);
  }
  if (recipe?.overall?.filler !== undefined) jacketRows.push(['Grouping / filler', recipe.overall.filler]);
  if (recipe?.lay?.layLengthMm !== undefined) {
    jacketRows.push([
      'Assembly lay',
      `${recipe.lay.layLengthMm}${recipe.lay.layLengthTolMm === undefined ? '' : ` ± ${recipe.lay.layLengthTolMm}`} mm${recipe.lay.hand === undefined ? '' : `, ${recipe.lay.hand}`}`,
    ]);
  }
  const jacketBlock = specTable('Outer jacket specifications', jacketRows);

  const performance = recipe?.performance ?? [];
  const performanceBlock =
    performance.length === 0
      ? ''
      : [
          '<section class="cs-ws-block">',
          '<h3 class="cs-ws-h">Technical performance specifications</h3>',
          '<table class="cs-ws-kv"><tbody>',
          ...performance.map((p) => `<tr><th scope="row">${e(p.name)}</th><td>${e(p.value)}</td></tr>`),
          '</tbody></table>',
          '<p class="cs-ws-note">As the manufacturer\'s documents state them (see Sources).</p>',
          '</section>',
        ].join('');

  /* --- the drawing -------------------------------------------------- */

  const scale = wireSpecScale(jacket?.odMm ?? wire.odMm);
  const drawing = renderCrossSection(wire, { scale, title: 'Cross-section' });
  const lay_ = layNote(wire, rows);
  const grounding = groundingNotes(wire);
  const drawingBlock = [
    '<section class="cs-ws-block cs-ws-drawing">',
    `<h3 class="cs-ws-h">Cross-section <span class="cs-ws-scale">scale ${scale}:1</span></h3>`,
    `<div class="cs-ws-svg">${drawing}</div>`,
    lay_ === '' ? '' : `<p class="cs-ws-lay"><strong>Note:</strong> ${e(lay_)}</p>`,
    grounding.length === 0 ? '' : `<ul class="cs-ws-ground">${grounding.map((g) => `<li>${e(g)}</li>`).join('')}</ul>`,
    '</section>',
  ].join('');

  /* --- sources and revisions ---------------------------------------- */

  const sources = new Set<string>();
  sources.add(wire.src);
  if (wire.profile !== undefined) sources.add(wire.profile.src);
  for (const p of performance) sources.add(`Performance: ${p.src}`);
  if (lay !== undefined) sources.add(lay.src);
  for (const set of wire.bonded ?? []) sources.add(set.src);
  const addSources = (element: Element): void => {
    if (element.src !== undefined && element.kind !== 'group') sources.add(element.src);
    if (isGroup(element)) element.children.forEach(addSources);
  };
  addSources(root as GroupElement);
  const sourceList = [...sources];

  const revisions = recipe?.revisions ?? [];
  const revisionBlock = [
    '<section class="cs-ws-block cs-ws-revs">',
    '<h3 class="cs-ws-h">Revision history</h3>',
    '<table class="cs-ws-grid"><thead><tr><th>Rev</th><th>Date</th><th>Change</th></tr></thead><tbody>',
    ...(revisions.length === 0
      ? ['<tr><td>—</td><td>—</td><td>No revision recorded</td></tr>']
      : revisions.map((r) => `<tr><td>${e(r.rev)}</td><td>${e(r.date)}</td><td>${e(r.note)}</td></tr>`)),
    '</tbody></table>',
    '</section>',
  ].join('');

  const description =
    recipe?.description ??
    `${wire.label}${rows.length === 0 ? '' : `: ${rows.length} cores`}${overall === undefined ? '' : ` under an overall ${overall.construction}`}.`;
  const inferredCount = countInferred(root);
  const maker = wireManufacturerName(wire, options.manufacturers);
  const vendorDocs = wire.vendorDocs ?? [];
  const docsBlock =
    vendorDocs.length === 0
      ? ''
      : [
          '<section class="cs-ws-block cs-ws-docs">',
          '<h3 class="cs-ws-h">Vendor documents</h3>',
          '<ul>',
          ...vendorDocs.map((doc) => {
            const href = options.vendorDocHref?.(doc.asset);
            const name = href === undefined ? e(doc.label) : `<a href="${e(href)}" target="_blank" rel="noopener">${e(doc.label)}</a>`;
            return `<li>${name} <span class="cs-ws-src">${e(doc.src)}</span></li>`;
          }),
          '</ul>',
          `<p class="cs-ws-note">The manufacturer's own files, cited as sources; this sheet is the ${e(standard)}.</p>`,
          '</section>',
        ].join('');

  const body = [
    '<div class="cs-root cs-ws">',
    `<style>${WIRE_SPEC_STYLESHEET}${brandSheetCss()}</style>`,
    '<header class="cs-ws-head">',
    '<div class="cs-ws-bar" aria-hidden="true"></div>',
    `<div class="cs-ws-brand"><span class="cs-ws-mark">${e(organisation.toUpperCase())}</span><span class="cs-ws-kind">${e(standard)} · Wire specification</span></div>`,
    `<div class="cs-ws-doc"><span class="cs-ws-docno">${e(docNumber)}</span><span class="cs-ws-rev">Rev ${e(revision)}${date === undefined ? '' : ` · ${e(date)}`}</span></div>`,
    '</header>',
    '<div class="cs-ws-title">',
    `<p class="cs-ws-over">${e(standard)}</p>`,
    `<h1>${e(wire.label)}</h1>`,
    `<p class="cs-ws-desc">${e(description)}</p>`,
    '<dl class="cs-ws-facts">',
    fact('Part number', wire.partNumber === undefined ? 'not assigned' : docNumber),
    fact('Manufacturer', maker ?? 'not recorded'),
    fact('Stock id', wire.id),
    ...(inferredCount === 0 ? [] : [fact('Inferred values', `${inferredCount} (marked in the sources)`)]),
    '</dl>',
    '</div>',
    '<div class="cs-ws-cols">',
    '<div class="cs-ws-col">',
    colourMap,
    jacketBlock,
    performanceBlock,
    '</div>',
    '<div class="cs-ws-col">',
    ...conductorBlocks,
    shieldedBlock,
    insulatedBlock,
    '</div>',
    '</div>',
    drawingBlock,
    docsBlock,
    revisionBlock,
    '<section class="cs-ws-block cs-ws-sources">',
    '<h3 class="cs-ws-h">Sources</h3>',
    `<ol>${sourceList.map((s) => `<li>${e(s)}</li>`).join('')}</ol>`,
    '</section>',
    `<footer class="cs-ws-foot"><span>${e(standard)} · ${e(docNumber)} · Rev ${e(revision)}</span>${rightsNotice === undefined ? '' : `<span>${e(rightsNotice)}</span>`}<span>Derived from the stock record — one derivation, however it is printed</span></footer>`,
    '</div>',
  ].join('');

  if (options.fragment === true) return body;
  const paper = options.paper ?? 'A4';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // the title is what a browser names the printed PDF: <prefix><number>
    `<title>${e(wireSpecFileStem(wire, options.filePrefix))}</title>`,
    `<style>@page{size:${paper} portrait;margin:12mm}html,body{margin:0;padding:0;background:#ffffff}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('');
}

function fact(key: string, value: string): string {
  return `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`;
}

function countInferred(root: GroupElement): number {
  let count = 0;
  const walk = (element: Element): void => {
    if (element.kind !== 'group' && /INFERRED/.test(element.src ?? '')) count += 1;
    if (isGroup(element)) element.children.forEach(walk);
  };
  root.children.forEach(walk);
  return count;
}

/** Look an element up by path — re-exported for the studio's hover text. */
export function wireSpecElement(wire: WireDefinition, path: string): Element | undefined {
  return resolveElementPath(wire.structure, path);
}

export const WIRE_SPEC_STYLESHEET = `@layer wirehub.docs{
.cs-ws{--ws-ink:#15181c;--ws-muted:#5a636d;--ws-rule:#c9d0d6;--ws-head:#eef1f4;--ws-accent:#c2602a;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:9.5pt;line-height:1.35;color:var(--ws-ink);background:#fff;
max-width:186mm;margin:0 auto;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cs-ws *{box-sizing:border-box}
.cs-ws-head{display:grid;grid-template-columns:1fr auto;align-items:end;gap:4mm;padding-top:3mm;position:relative}
.cs-ws-bar{grid-column:1/-1;height:1.6mm;border-radius:1mm;background:linear-gradient(90deg,#d6453d,#3aa35b,#3a6fd6,#d6453d)}
.cs-ws-brand{display:flex;flex-direction:column;gap:.6mm}
.cs-ws-mark{font-weight:800;letter-spacing:.32em;font-size:15pt}
.cs-ws-kind{text-transform:uppercase;letter-spacing:.14em;font-size:7.5pt;color:var(--ws-muted)}
.cs-ws-doc{display:flex;flex-direction:column;align-items:flex-end;gap:.6mm}
.cs-ws-docno{font-family:ui-monospace,"IBM Plex Mono",Menlo,Consolas,monospace;font-weight:700;font-size:15pt}
.cs-ws-rev{font-family:ui-monospace,"IBM Plex Mono",Menlo,Consolas,monospace;font-size:8pt;color:var(--ws-muted)}
.cs-ws-title{border-top:.5mm solid var(--ws-ink);margin-top:2.5mm;padding-top:2.5mm}
.cs-ws-over{margin:0;text-transform:uppercase;letter-spacing:.12em;font-size:8pt;font-weight:700}
.cs-ws h1{margin:.5mm 0 1.5mm;font-size:17pt;font-weight:600}
.cs-ws-desc{margin:0 0 2mm;max-width:150mm}
.cs-ws-facts{display:flex;flex-wrap:wrap;gap:1mm 6mm;margin:0 0 3mm;padding:0}
.cs-ws-facts div{display:flex;gap:1.5mm}
.cs-ws-facts dt{color:var(--ws-muted)}
.cs-ws-facts dd{margin:0;font-family:ui-monospace,"IBM Plex Mono",Menlo,Consolas,monospace;font-size:8.5pt}
.cs-ws-cols{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
.cs-ws-block{margin:0 0 3.5mm;break-inside:avoid}
.cs-ws-h{margin:0 0 1.2mm;font-size:9.5pt;font-weight:700;border-bottom:.3mm solid var(--ws-ink);padding-bottom:.6mm;display:flex;justify-content:space-between;align-items:baseline}
.cs-ws-scale{font-weight:400;font-size:8pt;color:var(--ws-muted)}
.cs-ws table{width:100%;border-collapse:collapse}
.cs-ws-kv th{text-align:left;font-weight:400;color:var(--ws-muted);padding:.5mm 2mm .5mm 0;width:48%;vertical-align:top}
.cs-ws-kv td{padding:.5mm 0;vertical-align:top}
.cs-ws-grid th{text-align:left;background:var(--ws-head);font-weight:600;padding:.7mm 1.5mm;font-size:8.5pt}
.cs-ws-grid td{padding:.6mm 1.5mm;border-bottom:.2mm solid var(--ws-rule)}
.cs-ws-grid td:nth-child(2){white-space:nowrap}
.cs-ws-num{font-family:ui-monospace,"IBM Plex Mono",Menlo,Consolas,monospace;text-align:center;width:9mm}
.cs-ws-sw{display:inline-block;width:3mm;height:3mm;border-radius:50%;border:.2mm solid #555;margin-right:1.5mm;vertical-align:-.4mm}
.cs-ws-note{margin:1mm 0 0;color:var(--ws-muted);font-size:8pt}
.cs-ws-drawing{border-top:.3mm solid var(--ws-rule);padding-top:2mm}
.cs-ws-svg{display:flex;justify-content:center}
.cs-ws-svg svg{max-width:100%;height:auto}
.cs-ws-lay{margin:1.5mm 0 1mm}
.cs-ws-ground{margin:1mm 0 0;padding-left:4.5mm;color:var(--ws-ink)}
.cs-ws-ground li{margin:.3mm 0}
.cs-ws-docs ul{margin:0;padding-left:4.5mm}
.cs-ws-docs li{margin:.3mm 0}
.cs-ws-docs a{color:inherit}
.cs-ws-src{color:var(--ws-muted);font-size:7.5pt;overflow-wrap:anywhere}
.cs-ws-sources ol{margin:0;padding-left:5mm;font-size:7.5pt;color:var(--ws-muted)}
.cs-ws-sources li{margin:.4mm 0;overflow-wrap:anywhere}
.cs-ws-foot{display:flex;justify-content:space-between;gap:4mm;border-top:.3mm solid var(--ws-ink);padding-top:1mm;margin-top:3mm;font-size:7pt;color:var(--ws-muted);text-transform:uppercase;letter-spacing:.04em}
@media screen{.cs-ws{padding:6mm 5mm}}
@media screen and (max-width:640px){.cs-ws{font-size:10pt;padding:4mm 3mm}.cs-ws-cols{grid-template-columns:1fr}.cs-ws-head{grid-template-columns:1fr}.cs-ws-doc{align-items:flex-start}.cs-ws-foot{flex-direction:column}}
}`;
