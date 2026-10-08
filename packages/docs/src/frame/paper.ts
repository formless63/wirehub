/**
 * Paper sizes, as data. Every sheet is cut to one of these, in either
 * orientation, and the frame, the `@page` rule and the PDF page all read the
 * same row, so a sheet is the same size wherever it is printed.
 *
 * Each size also names the title-block standard it is conventionally drawn
 * with (ISO 7200 for the A series, ANSI Y14.1 for the North American sizes):
 * the default when the organisation sets none (`titleBlock` in Settings ›
 * Documents).
 */

export const PAPER_IDS = ['A4', 'A3', 'A2', 'A1', 'A0', 'letter', 'legal', 'tabloid', 'ansi-c', 'ansi-d', 'ansi-e'] as const;
export type PaperId = (typeof PAPER_IDS)[number];

export const TITLE_BLOCK_STANDARDS = ['ansi', 'iso'] as const;
export type TitleBlockStandard = (typeof TITLE_BLOCK_STANDARDS)[number];

export type Orientation = 'portrait' | 'landscape';

export interface PaperInfo {
  id: PaperId;
  /** what a person calls it */
  label: string;
  /** portrait size, millimetres */
  widthMm: number;
  heightMm: number;
  /** the title-block standard drawn on it by default */
  standard: TitleBlockStandard;
}

export const PAPERS: Readonly<Record<PaperId, PaperInfo>> = {
  A4: { id: 'A4', label: 'A4', widthMm: 210, heightMm: 297, standard: 'iso' },
  A3: { id: 'A3', label: 'A3', widthMm: 297, heightMm: 420, standard: 'iso' },
  A2: { id: 'A2', label: 'A2', widthMm: 420, heightMm: 594, standard: 'iso' },
  A1: { id: 'A1', label: 'A1', widthMm: 594, heightMm: 841, standard: 'iso' },
  A0: { id: 'A0', label: 'A0', widthMm: 841, heightMm: 1189, standard: 'iso' },
  letter: { id: 'letter', label: 'Letter', widthMm: 215.9, heightMm: 279.4, standard: 'ansi' },
  legal: { id: 'legal', label: 'Legal', widthMm: 215.9, heightMm: 355.6, standard: 'ansi' },
  tabloid: { id: 'tabloid', label: 'Tabloid (ANSI B)', widthMm: 279.4, heightMm: 431.8, standard: 'ansi' },
  'ansi-c': { id: 'ansi-c', label: 'ANSI C', widthMm: 431.8, heightMm: 558.8, standard: 'ansi' },
  'ansi-d': { id: 'ansi-d', label: 'ANSI D', widthMm: 558.8, heightMm: 863.6, standard: 'ansi' },
  'ansi-e': { id: 'ansi-e', label: 'ANSI E', widthMm: 863.6, heightMm: 1117.6, standard: 'ansi' },
};

export function isPaperId(value: unknown): value is PaperId {
  return typeof value === 'string' && (PAPER_IDS as readonly string[]).includes(value);
}

export function isTitleBlockStandard(value: unknown): value is TitleBlockStandard {
  return typeof value === 'string' && (TITLE_BLOCK_STANDARDS as readonly string[]).includes(value);
}

/** The sheet's size in millimetres for an orientation. */
export function paperSize(paper: PaperId, orientation: Orientation = 'portrait'): { width: number; height: number } {
  const p = PAPERS[paper];
  return orientation === 'portrait' ? { width: p.widthMm, height: p.heightMm } : { width: p.heightMm, height: p.widthMm };
}

/** `Letter · landscape`, for a title block's paper cell. */
export function paperText(paper: PaperId, orientation?: Orientation): string {
  const label = PAPERS[paper].label;
  return orientation === undefined ? label : `${label} ${orientation === 'landscape' ? 'landscape' : 'portrait'}`;
}

/** The CSS `size` of an `@page` rule. */
export function pageSizeCss(paper: PaperId, orientation: Orientation): string {
  const { width, height } = paperSize(paper, orientation);
  return `${Math.round(width * 100) / 100}mm ${Math.round(height * 100) / 100}mm`;
}

/**
 * Read a paper out of free input: a paper id (case-insensitively), or the
 * old `A4` / `letter` spellings. `undefined` when it is none of them.
 */
export function parsePaper(value: unknown): PaperId | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return PAPER_IDS.find((id) => id.toLowerCase() === v);
}
