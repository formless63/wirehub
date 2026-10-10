/**
 * Parametric 3D models (the Library's 3D tab for a part that has no model
 * file).
 *
 * A model link may carry a `parametric` spec instead of stored bytes: a shape
 * name and the dimensions (millimetres) it is drawn from. The viewer builds
 * the geometry from the spec, the same way every time, so a fresh hub shows a
 * 3D model for the starter connectors with nothing downloaded or converted.
 * The spec is data, the geometry is the presentation layer's
 * (`packages/editor-react/src/parametric-model.ts`); the model only says what a
 * spec is and when it is well formed.
 *
 * Pure: values in, problems out.
 */

/** The shapes the viewer can draw. */
export const PARAMETRIC_SHAPES = ['d-sub', 'xlr', 'rj45', 'jst-xh', 'terminal-block', 'obd2', 'sealed-rectangular'] as const;
export type ParametricShape = (typeof PARAMETRIC_SHAPES)[number];

/** Required parameters: dimensions in millimetres, except `rows` (a count); `pins` is a separate count. */
export const PARAMETRIC_PARAMS: Record<ParametricShape, readonly string[]> = {
  'd-sub': ['flangeWidthMm', 'flangeHeightMm', 'mountPitchMm', 'shellWidthMm', 'shellHeightMm', 'pinPitchMm', 'rowPitchMm', 'shellDepthMm', 'hoodDepthMm'],
  xlr: ['shellDiameterMm', 'shellLengthMm', 'bootDiameterMm', 'bootLengthMm', 'pinCircleDiameterMm'],
  rj45: ['widthMm', 'heightMm', 'lengthMm', 'latchHeightMm', 'contactPitchMm', 'bootLengthMm'],
  'jst-xh': ['pitchMm', 'widthMm', 'heightMm', 'depthMm'],
  'terminal-block': ['pitchMm', 'heightMm', 'depthMm'],
  obd2: ['widthMm', 'heightMm', 'lengthMm', 'pinPitchMm', 'rowPitchMm'],
  'sealed-rectangular': ['widthMm', 'heightMm', 'lengthMm', 'pinPitchMm', 'rowPitchMm', 'rows'],
};

export interface ParametricSpec {
  shape: ParametricShape;
  /** the contact side: a plug / pin body is `male`, a socket / receptacle `female` */
  gender?: 'male' | 'female';
  /** contacts, ways or cavities */
  pins: number;
  /** the shape's dimensions (`PARAMETRIC_PARAMS`), millimetres */
  params: Record<string, number>;
}

export function isParametricShape(value: unknown): value is ParametricShape {
  return typeof value === 'string' && (PARAMETRIC_SHAPES as readonly string[]).includes(value);
}

/** What is wrong with a spec, in words; empty when it can be drawn. */
export function parametricProblems(spec: unknown): string[] {
  if (typeof spec !== 'object' || spec === null) return ['a parametric model is an object'];
  const s = spec as Record<string, unknown>;
  if (!isParametricShape(s['shape'])) return [`'${String(s['shape'])}' is not a shape (one of ${PARAMETRIC_SHAPES.join(', ')})`];
  const problems: string[] = [];
  if (s['gender'] !== undefined && s['gender'] !== 'male' && s['gender'] !== 'female') problems.push("gender must be 'male' or 'female'");
  const pins = s['pins'];
  if (typeof pins !== 'number' || !Number.isInteger(pins) || pins < 1 || pins > 64) problems.push('pins must be a whole number from 1 to 64');
  const params = s['params'];
  if (typeof params !== 'object' || params === null) return [...problems, 'params must be an object of dimensions'];
  for (const name of PARAMETRIC_PARAMS[s['shape']]) {
    const v = (params as Record<string, unknown>)[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 500) problems.push(`${name} must be a number of millimetres above 0 and up to 500`);
  }
  if (s['shape'] === 'obd2' && pins !== 16) problems.push('obd2 has 16 contacts');
  if (s['shape'] === 'sealed-rectangular') {
    const rows = (params as Record<string, unknown>)['rows'];
    if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 4) problems.push('rows must be a whole number from 1 to 4');
    else if (typeof pins === 'number' && pins % rows !== 0) problems.push('pins must divide evenly between rows');
  }
  return problems;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The link's `asset` for a spec: `parametric-` and 16 hex digits of an FNV-1a
 * hash of the spec's canonical text (two seeds). It names the geometry, not a
 * stored file, so two records with the same spec share an id.
 */
export function parametricAssetId(spec: ParametricSpec): string {
  const text = canonical(spec);
  const hash = (seed: number): string => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return `parametric-${hash(0x811c9dc5)}${hash(0x01234567)}`;
}

export const isParametricAssetId = (asset: string): boolean => /^parametric-[0-9a-f]{16}$/.test(asset);
