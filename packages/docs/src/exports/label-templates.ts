/**
 * Label templates as data (cs-gqbj): how a tape label is laid out, so a shop can set its own house
 * layout without code. A template is a list of text lines, each a pattern with `{tokens}`, a font
 * family / size / weight and an alignment, plus the label's length and the separator that joins
 * a label's detail lines.
 *
 * Templates layer like the rest of the drawing art: the built-ins here, then the hub's own
 * (`drawing-art.json` › `labelTemplates`, entered in Settings › Documents) and any data pack's
 * (`drawing-art.json` in the pack), the earliest registration to define an id winning. A shop's
 * private pack can therefore ship its own template with its own font names.
 *
 * Fonts: a line's `family` is a font family name. In the `.lbx` it is written as is (P-touch Editor
 * uses the fonts installed on the PC that opens it); in the SVG, PNG and PDF it leads the CSS
 * font stack, so it only shows if the renderer has it. Absent, the hub's branding typeface is used
 * (its family in the `.lbx`), else Arial for the `.lbx` and the bundled sans for the preview.
 *
 * Tokens: `{headline}` (the label's first line, `W1-A`), `{line2}` `{line3}`, `{details}` (the
 * other lines joined by `separator`), `{designation}`, `{end}` (`A` or `B`), `{pn}`, `{rev}`,
 * `{pnrev}` (`CBL-00001 rev 2`), `{design}` and `{label}` (the label's id).
 */

export const TEMPLATE_TOKENS = ['headline', 'line2', 'line3', 'details', 'designation', 'end', 'pn', 'rev', 'pnrev', 'design', 'label'] as const;
export type TemplateToken = (typeof TEMPLATE_TOKENS)[number];

export interface LabelTemplateLine {
  /** the text, with `{tokens}`; a line whose text comes out empty is left out */
  text: string;
  /** font family name; absent: the template's, else the hub's typeface */
  family?: string;
  /** point size; absent: as large as the line's share of the tape allows */
  size?: number;
  weight?: 'regular' | 'bold';
  align?: 'left' | 'center' | 'right';
  /** this line's share of the printable height among the lines shown (default 1) */
  share?: number;
  /** show the line only on tape at least / at most this wide (mm) */
  minTapeMm?: number;
  maxTapeMm?: number;
}

export interface LabelTemplate {
  label: string;
  /** where the layout comes from */
  src: string;
  lines: readonly LabelTemplateLine[];
  /** default font family of the lines */
  family?: string;
  /** default alignment of the lines (default `left`) */
  align?: 'left' | 'center' | 'right';
  /** joins the detail lines in `{details}` (default ` · `) */
  separator?: string;
  /** `auto` (as long as the text), or a fixed length in mm; absent: the tape stock's */
  length?: 'auto' | number;
  /** space at each end of the label, beyond the printer's own margin (mm; default 1) */
  padding?: number;
}

export const DEFAULT_TEMPLATE_ID = 'wire-id';

export const BUILTIN_LABEL_TEMPLATES: Readonly<Record<string, LabelTemplate>> = {
  'wire-id': {
    label: 'Wire ID: designation, ends, part number',
    src: 'WireHub built-in layout.',
    lines: [
      { text: '{headline}', weight: 'bold', share: 1.3 },
      { text: '{details}', share: 1, minTapeMm: 9 },
      { text: '{pnrev}', share: 0.9, minTapeMm: 12 },
    ],
  },
  'single-line': {
    label: 'One line: designation and ends',
    src: 'WireHub built-in layout.',
    lines: [{ text: '{headline} {details}', weight: 'bold' }],
    align: 'center',
  },
};

const ALIGNS = ['left', 'center', 'right'] as const;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;
const TOKEN = /\{([a-z0-9]+)\}/g;
export const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What is wrong with a template (empty: usable). */
export function labelTemplateProblems(id: string, raw: unknown): string[] {
  const where = `label template '${id}'`;
  if (!TEMPLATE_ID.test(id)) return [`${where}: the id is lowercase letters, digits, dot, dash`];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [`${where} is not an object`];
  const t = raw as Partial<LabelTemplate>;
  const problems: string[] = [];
  if (typeof t.label !== 'string' || t.label.trim() === '') problems.push(`${where} needs a label`);
  if (typeof t.src !== 'string' || t.src.trim() === '') problems.push(`${where} needs a src`);
  if (!Array.isArray(t.lines) || t.lines.length === 0 || t.lines.length > 6) problems.push(`${where} needs 1 to 6 lines`);
  else {
    t.lines.forEach((line: LabelTemplateLine, i) => {
      const at = `${where} line ${i + 1}`;
      if (typeof line?.text !== 'string' || line.text.length > 120) return void problems.push(`${at} needs text (at most 120 characters)`);
      for (const m of line.text.matchAll(TOKEN)) if (!(TEMPLATE_TOKENS as readonly string[]).includes(m[1] as string)) problems.push(`${at}: '{${m[1]}}' is not a token (${TEMPLATE_TOKENS.join(', ')})`);
      if (line.family !== undefined && (typeof line.family !== 'string' || !FAMILY.test(line.family))) problems.push(`${at}: family is a font name`);
      if (line.size !== undefined && !(typeof line.size === 'number' && line.size >= 3 && line.size <= 72)) problems.push(`${at}: size is 3 to 72 pt`);
      if (line.weight !== undefined && line.weight !== 'regular' && line.weight !== 'bold') problems.push(`${at}: weight is regular or bold`);
      if (line.align !== undefined && !ALIGNS.includes(line.align)) problems.push(`${at}: align is left, center or right`);
      if (line.share !== undefined && !(typeof line.share === 'number' && line.share > 0 && line.share <= 10)) problems.push(`${at}: share is above 0 and at most 10`);
      for (const k of ['minTapeMm', 'maxTapeMm'] as const) if (line[k] !== undefined && typeof line[k] !== 'number') problems.push(`${at}: ${k} is a number`);
    });
  }
  if (t.family !== undefined && (typeof t.family !== 'string' || !FAMILY.test(t.family))) problems.push(`${where}: family is a font name`);
  if (t.align !== undefined && !ALIGNS.includes(t.align)) problems.push(`${where}: align is left, center or right`);
  if (t.separator !== undefined && (typeof t.separator !== 'string' || t.separator.length > 8)) problems.push(`${where}: separator is up to 8 characters`);
  if (t.length !== undefined && t.length !== 'auto' && !(typeof t.length === 'number' && t.length >= 10 && t.length <= 1000)) problems.push(`${where}: length is 'auto' or 10 to 1000 mm`);
  if (t.padding !== undefined && !(typeof t.padding === 'number' && t.padding >= 0 && t.padding <= 20)) problems.push(`${where}: padding is 0 to 20 mm`);
  return problems;
}

/** The facts a template's tokens stand for. */
export interface TemplateFacts {
  /** the label's text lines, `W1-A` first */
  lines: readonly string[];
  designation: string;
  end: 'a' | 'b';
  pn?: string;
  rev?: string;
  design?: string;
  label: string;
}

/** A template line's text for a label; empty when nothing is left of it. */
export function fillTemplate(text: string, facts: TemplateFacts, separator = ' · '): string {
  const pn = facts.pn ?? '';
  const rev = facts.rev === undefined || facts.rev === '—' ? '' : facts.rev;
  const values: Record<TemplateToken, string> = {
    headline: facts.lines[0] ?? '',
    line2: facts.lines[1] ?? '',
    line3: facts.lines[2] ?? '',
    details: facts.lines.slice(1).join(separator),
    designation: facts.designation,
    end: facts.end.toUpperCase(),
    pn,
    rev,
    pnrev: pn === '' ? '' : `${pn}${rev === '' ? '' : ` rev ${rev}`}`,
    design: facts.design ?? '',
    label: facts.label,
  };
  return text.replace(TOKEN, (_, key: string) => values[key as TemplateToken] ?? '').replace(/\s+/g, ' ').trim();
}
