/**
 * Pack art: the drawings a catalog pack (or a module that carries one) ships
 * for the physical shapes it adds (`specs/drawing-language.md` §7).
 *
 * Two kinds of record, both plain JSON with a `src`, both **presentation, not
 * truth** — nothing in the model refers to them, and a catalog without them
 * draws the abstract pin table:
 *
 *  - a **connector drawing** (`art/connectors/<id>.json`): a mating face as
 *    painted shapes (each with a paint *tone* the host themes) plus one handle
 *    per pin, keyed by the body, the body's `drawing` name or the family it
 *    draws. The canvas, the schematic and the connector pickers all read it.
 *  - a **body layout** (`art/body-layouts.json`): the standard position
 *    layouts a family offers when someone makes a new body ("DIN-8 270°"),
 *    each naming the drawing it is.
 *
 * Pictures with anchors — SVG faces, outlines, a stock's cutaway — are not
 * here: they are depictions (`depictions/<id>/meta.json`, `./depictions`),
 * the artwork mechanism the base already has, and a pack ships those in the
 * same directory layout.
 *
 * Pure: parsing never throws, it returns issues. Reading a pack directory is
 * the one function that touches the filesystem.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { recordMetaIssues, type Issue, type RecordMeta } from '@wirehub/model';

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

/** The paint roles a drawing uses; the host maps each to its theme. */
export const ART_TONES = ['flange', 'shell', 'insert', 'hole', 'metal', 'boot', 'grip', 'knurl', 'band', 'copper', 'dark', 'key'] as const;
export type ArtToneName = (typeof ART_TONES)[number];

export const ART_PIN_FORMS = ['pin', 'socket', 'blade', 'finger', 'lug', 'shell'] as const;
export type ArtPinFormName = (typeof ART_PIN_FORMS)[number];

export type ArtShapeRecord =
  | { el: 'path'; d: string; tone: ArtToneName; ifDefined?: string }
  | { el: 'circle'; cx: number; cy: number; r: number; tone: ArtToneName; ifDefined?: string }
  | {
      el: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
      tone: ArtToneName;
      /** painted the colour of this terminal's conductor, when the connector's wiring knows it (a colour band on a grip) */
      band?: string;
      /** the terminals whose colour the band takes, in turn, when the connector has no `band` terminal (a tip-less plug's band is its ring's, else its sleeve's) */
      bandFallback?: string[];
      /** any shape: drawn only when the connector has this terminal (the lug tag of a conductor it omits is not on the part) */
      ifDefined?: string;
    };

export interface ArtPinRecord {
  /** the body position / connector pin id the handle sits on */
  terminal: string;
  form: ArtPinFormName;
  /** centre, in the drawing's own units (px) */
  x: number;
  y: number;
  r?: number;
  width?: number;
  height?: number;
  /** drawn only when the connector has this pin (a shell contact a pinout may leave out) */
  ifDefined?: boolean;
}

export interface ArtLabelRecord {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
}

/** Which way a connector drawing looks: the face a builder plugs into, or the side profile. */
export const ART_RECORD_VIEWS = ['face', 'profile'] as const;
export type ArtRecordView = (typeof ART_RECORD_VIEWS)[number];

/**
 * A connector's drawing, as data: a mating face (the default) or a side
 * profile.
 *
 * A **profile** is facing-aware. It is authored once with the cable end on
 * the left (the lugs that carry the pin handles at the left edge, the business
 * end to the right) and the host mirrors it left to right when the wire leaves
 * from the right, so the lugs always face the wire. Its paths may use only the
 * absolute commands `M L H V Z` (what a mirror can reflect exactly). A face is
 * never mirrored.
 */
export interface ConnectorArtRecord extends RecordMeta {
  /** kebab-case; the file name */
  id: string;
  /** which connectors it draws — any match counts: body ids … */
  bodies?: string[];
  /** … a body's `drawing` names … */
  drawings?: string[];
  /** … and vocab family ids */
  families?: string[];
  /** `face` (default) or `profile` (see above) */
  view?: ArtRecordView;
  /** draws only connectors of this gender (`male` is also what a connector without a gender is); absent: either */
  gender?: 'male' | 'female';
  /** a caption word (`SCART`) */
  short: string;
  width: number;
  height: number;
  /** pin positions follow the family's general shape, not a mechanical drawing */
  approximate: boolean;
  shapes: ArtShapeRecord[];
  pins: ArtPinRecord[];
  labels: ArtLabelRecord[];
  src: string;
}

/** One standard layout a family offers for a new body. */
export interface BodyLayoutRecord extends RecordMeta {
  /** picker key, kebab-case */
  id: string;
  /** what the picker shows: "SCART, 21 pins" */
  label: string;
  /** vocab family id */
  family: string;
  /** the body id stem: `scart-21` → `scart-21-male` */
  stem: string;
  /** the drawing the body names (a `drawings` entry of a connector drawing, or a built-in) */
  drawing?: string;
  positions: { id: string; kind?: 'shell' }[];
  src: string;
}

/** Everything one pack's `art/` directory holds. */
export interface PackArt {
  connectors: ConnectorArtRecord[];
  bodyLayouts: BodyLayoutRecord[];
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

function problem(where: string, message: string): Issue {
  return { code: 'bad-art-record', severity: 'error', message, where };
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(isString) ? (value as string[]) : undefined;
}

/** a path a mirror can reflect: absolute M L H V Z with plain numbers */
const MIRRORABLE_PATH = /^\s*(?:[MLHVZ]\s*(?:-?\d*\.?\d+(?:\s*,?\s*-?\d*\.?\d+)*)?\s*)+$/;

function shapeIssue(shape: unknown, where: string, profile = false): string | undefined {
  if (!isObject(shape)) return 'a shape is not an object';
  if (!(ART_TONES as readonly string[]).includes(shape['tone'] as string)) return `shape tone '${String(shape['tone'])}' is not one of ${ART_TONES.join(', ')}`;
  if (shape['ifDefined'] !== undefined && !isString(shape['ifDefined'])) return 'ifDefined must name a terminal';
  switch (shape['el']) {
    case 'path':
      if (!isString(shape['d'])) return `${where}: a path has no d`;
      return profile && !MIRRORABLE_PATH.test(shape['d'] as string) ? 'a profile path may use only absolute M, L, H, V and Z commands' : undefined;
    case 'circle':
      return isNumber(shape['cx']) && isNumber(shape['cy']) && isNumber(shape['r']) ? undefined : 'a circle needs cx, cy, r';
    case 'rect':
      if (shape['band'] !== undefined && !isString(shape['band'])) return 'a rect band must name a terminal';
      if (shape['bandFallback'] !== undefined && (strings(shape['bandFallback']) === undefined || shape['band'] === undefined)) return 'bandFallback must be a list of terminals, and needs a band';
      return isNumber(shape['x']) && isNumber(shape['y']) && isNumber(shape['width']) && isNumber(shape['height']) && (shape['rx'] === undefined || isNumber(shape['rx']))
        ? undefined
        : 'a rect needs x, y, width, height';
    default:
      return `shape el '${String(shape['el'])}' is not path, circle or rect`;
  }
}

/** A connector drawing record, parsed; `record` is absent when it has errors. */
export function parseConnectorArt(raw: unknown, where: string): { record?: ConnectorArtRecord; issues: Issue[] } {
  const issues: Issue[] = [];
  const bad = (message: string): void => void issues.push(problem(where, message));
  if (!isObject(raw)) return { issues: [problem(where, 'not an object')] };
  if (typeof raw['id'] !== 'string' || !KEBAB.test(raw['id'])) bad('id must be kebab-case');
  if (!isString(raw['short'])) bad('short (the caption word) is required');
  if (!isString(raw['src'])) bad('src (where the drawing comes from) is required');
  if (!isNumber(raw['width']) || !isNumber(raw['height']) || (raw['width'] as number) <= 0 || (raw['height'] as number) <= 0) bad('width and height must be positive numbers');
  if (typeof raw['approximate'] !== 'boolean') bad('approximate must be true or false');
  if (raw['view'] !== undefined && !(ART_RECORD_VIEWS as readonly unknown[]).includes(raw['view'])) bad(`view must be one of ${ART_RECORD_VIEWS.join(', ')}`);
  if (raw['gender'] !== undefined && raw['gender'] !== 'male' && raw['gender'] !== 'female') bad('gender must be male or female');
  issues.push(...recordMetaIssues(raw, where));
  for (const key of ['bodies', 'drawings', 'families'] as const) {
    if (raw[key] !== undefined && strings(raw[key]) === undefined) bad(`${key} must be a list of ids`);
  }
  if (['bodies', 'drawings', 'families'].every((key) => raw[key] === undefined || (raw[key] as unknown[]).length === 0)) bad('it names no body, drawing or family it draws');
  const shapes = raw['shapes'];
  if (!Array.isArray(shapes) || shapes.length === 0) bad('shapes must be a non-empty list');
  else for (const shape of shapes) {
    const why = shapeIssue(shape, where, raw['view'] === 'profile');
    if (why !== undefined) bad(why);
  }
  const pins = raw['pins'];
  if (!Array.isArray(pins) || pins.length === 0) bad('pins must be a non-empty list');
  else {
    const seen = new Set<string>();
    for (const pin of pins) {
      if (!isObject(pin) || !isString(pin['terminal'])) {
        bad('a pin has no terminal');
        continue;
      }
      const id = pin['terminal'] as string;
      if (seen.has(id)) bad(`pin '${id}' is listed twice`);
      seen.add(id);
      if (!(ART_PIN_FORMS as readonly string[]).includes(pin['form'] as string)) bad(`pin '${id}' form must be one of ${ART_PIN_FORMS.join(', ')}`);
      if (!isNumber(pin['x']) || !isNumber(pin['y'])) bad(`pin '${id}' needs x and y`);
    }
  }
  const labels = raw['labels'];
  if (!Array.isArray(labels)) bad('labels must be a list (empty is fine)');
  else for (const label of labels) {
    if (!isObject(label) || !isNumber(label['x']) || !isNumber(label['y']) || typeof label['text'] !== 'string' || !['start', 'middle', 'end'].includes(label['anchor'] as string)) bad('a label needs x, y, text and an anchor');
  }
  if (issues.length > 0) return { issues };
  return { record: raw as unknown as ConnectorArtRecord, issues };
}

/** A body layout list, parsed. */
export function parseBodyLayouts(raw: unknown, where: string): { records: BodyLayoutRecord[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const records: BodyLayoutRecord[] = [];
  if (!Array.isArray(raw)) return { records, issues: [problem(where, 'body layouts are a list')] };
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const at = `${where}[${index}]`;
    const before = issues.length;
    if (!isObject(item)) {
      issues.push(problem(at, 'not an object'));
      return;
    }
    for (const key of ['id', 'stem', 'family'] as const) if (typeof item[key] !== 'string' || !KEBAB.test(item[key] as string)) issues.push(problem(at, `${key} must be kebab-case`));
    for (const key of ['label', 'src'] as const) if (!isString(item[key])) issues.push(problem(at, `${key} is required`));
    issues.push(...recordMetaIssues(item, at));
    if (typeof item['id'] === 'string') {
      if (seen.has(item['id'])) issues.push(problem(at, `layout '${item['id']}' is listed twice`));
      seen.add(item['id']);
    }
    const positions = item['positions'];
    if (!Array.isArray(positions) || positions.length === 0 || !positions.every((p) => isObject(p) && isString(p['id']) && (p['kind'] === undefined || p['kind'] === 'shell'))) {
      issues.push(problem(at, 'positions must be a list of { id, kind? }'));
    }
    if (issues.length === before) records.push(item as unknown as BodyLayoutRecord);
  });
  return { records, issues };
}

/* ------------------------------------------------------------------ *
 * Reading a pack directory
 * ------------------------------------------------------------------ */

/**
 * The art in a pack directory (`<dir>/art/connectors/*.json`,
 * `<dir>/art/body-layouts.json`), parsed. A file that cannot be read or
 * parsed becomes an issue and is left out; a pack with no `art/` is empty.
 */
export function loadPackArt(packDir: string): { art: PackArt; issues: Issue[] } {
  const art: PackArt = { connectors: [], bodyLayouts: [] };
  const issues: Issue[] = [];
  const connectorsDir = join(packDir, 'art', 'connectors');
  if (existsSync(connectorsDir)) {
    for (const name of readdirSync(connectorsDir).filter((n) => n.endsWith('.json')).sort()) {
      const where = `art/connectors/${name}`;
      try {
        const parsed = parseConnectorArt(JSON.parse(readFileSync(join(connectorsDir, name), 'utf8')), where);
        issues.push(...parsed.issues);
        if (parsed.record !== undefined) {
          if (`${parsed.record.id}.json` !== name) issues.push(problem(where, `the file name must be the record id '${parsed.record.id}'`));
          else art.connectors.push(parsed.record);
        }
      } catch (error) {
        issues.push(problem(where, `cannot read: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }
  const layoutsFile = join(packDir, 'art', 'body-layouts.json');
  if (existsSync(layoutsFile)) {
    try {
      const parsed = parseBodyLayouts(JSON.parse(readFileSync(layoutsFile, 'utf8')), 'art/body-layouts.json');
      issues.push(...parsed.issues);
      art.bodyLayouts.push(...parsed.records);
    } catch (error) {
      issues.push(problem('art/body-layouts.json', `cannot read: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return { art, issues };
}
