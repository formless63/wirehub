/**
 * The structured parts of a PCBA internal link.
 *
 * A link's `via` is prose: "C201 0.1 µF → U201 LM1881 sync stripper → R202
 * 470 Ω". What sits in the path — designator, kind, value, state — is what
 * the documents (does a meter read it?), the trace and the schematic (which
 * board parts does the link run through?) need, so it is structure:
 * `PcbaInternalLink.elements`, written by the importer, which knows each
 * part's reference, value and kind from the netlist.
 *
 * `linkElements(link)` is the one reader: the declared `elements` when the
 * link has them, else the elements parsed from `via` — the fallback for
 * hand-authored definitions and for data imported before elements existed.
 * Each element keeps its verbatim slice of the `via` (`text`), so the prose
 * renders exactly as before: `viaText(elements)` rebuilds it.
 */

import type { PcbaInternalLink, PcbaLinkElement, PcbaLinkElementKind } from './model.ts';

/** Separator between the parts of a multi-part `via`. */
export const VIA_SEPARATOR = ' → ';

const DESIGNATOR = /^((?:JP|SW|IC|RN)\d+|[RCLUQDSTFYJ]\d+)\b/;
const OHMS = /(\d+(?:\.\d+)?)\s*([kKM])?\s*(?:Ω|ohms?\b)/;
const FARADS = /(\d+(?:\.\d+)?)\s*([µunpm])\s*F\b/;
const HENRIES = /(\d+(?:\.\d+)?)\s*([µunpm])?\s*H\b/;

/** Anything that names silicon. Active parts do not conduct, they *drive*. */
const SILICON =
  /\b(LM\d{3,}|SN74[A-Z0-9]+|74[A-Z]{1,4}\d+[A-Z0-9]*|TMUX\d+|AP\d{4}[A-Z]?|LDO|monostable|NAND|XOR|buffer|combiner|stripper|mux|op-?amp|regulator|transistor)\b/i;

/** Ohms named in a value text (`470 Ω`, `4.7 kΩ`), or `undefined`. */
export function ohmsOfText(text: string): number | undefined {
  const match = OHMS.exec(text);
  if (match === null) return undefined;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) return undefined;
  const suffix = match[2];
  if (suffix === 'k' || suffix === 'K') return magnitude * 1_000;
  if (suffix === 'M') return magnitude * 1_000_000;
  return magnitude;
}

/** The printed value named in a text (`220 µF`, `470 Ω`), or `undefined`. */
export function valueOfText(text: string): string | undefined {
  const ohms = OHMS.exec(text);
  if (ohms !== null) return `${ohms[1]}${ohms[2] ?? ''} Ω`;
  const farads = FARADS.exec(text);
  if (farads !== null) return `${farads[1]} ${farads[2]}F`;
  const henries = HENRIES.exec(text);
  if (henries !== null) return `${henries[1]} ${henries[2] ?? ''}H`;
  return undefined;
}

function kindOfDesignator(designator: string): PcbaLinkElementKind | undefined {
  if (designator.startsWith('JP')) return 'jumper';
  if (designator.startsWith('SW')) return 'switch';
  if (designator.startsWith('IC') || designator.startsWith('U')) return 'ic';
  if (designator.startsWith('Q')) return 'ic';
  if (designator.startsWith('R') || designator.startsWith('RN')) return 'resistor';
  if (designator.startsWith('C')) return 'capacitor';
  if (designator.startsWith('L')) return 'inductor';
  if (designator.startsWith('S')) return 'switch';
  return undefined;
}

/** A board jack (`J1`) is in a path only through its switch contact; otherwise it names no kind. */
function kindOfJack(text: string): PcbaLinkElementKind | undefined {
  return /\bswitch contact\b/i.test(text) ? 'switch' : undefined;
}

/** The state a jumper or switch slice names: `bridged`, `CS position`, `build option`. */
function stateOfText(kind: PcbaLinkElementKind, text: string): string | undefined {
  if (kind !== 'jumper' && kind !== 'switch') return undefined;
  if (/\bbridged\b/i.test(text)) return 'bridged';
  const position = /[—-]\s*([^()—]*?\bposition)\s*\)?\s*$/i.exec(text);
  if (position?.[1] !== undefined) return position[1].trim();
  if (/\bbuild option\b/i.test(text)) return 'build option';
  // a jack's switch contact: `J1 PJ-311D switch contact (no plug inserted)`
  const contact = /\bswitch contact\s*\(([^()]*)\)\s*$/i.exec(text);
  return contact?.[1]?.trim() || undefined;
}

/** Parse one `→`-separated slice of a `via` into an element. */
export function parseLinkElement(rawText: string): PcbaLinkElement {
  const text = rawText.trim();
  const designator = DESIGNATOR.exec(text)?.[1];
  let kind: PcbaLinkElementKind =
    (designator === undefined
      ? undefined
      : designator.startsWith('J') && !designator.startsWith('JP')
        ? kindOfJack(text)
        : kindOfDesignator(designator)) ?? 'other';
  // silicon named in the prose claims an element nothing else did
  if (kind === 'other' && SILICON.test(text)) kind = 'ic';
  const value = valueOfText(text);
  const ohms = ohmsOfText(text);
  const state = stateOfText(kind, text);
  return {
    text,
    kind,
    ...(designator === undefined ? {} : { designator }),
    ...(value === undefined ? {} : { value }),
    ...(ohms === undefined ? {} : { ohms }),
    ...(state === undefined ? {} : { state }),
  };
}

/** The elements a `via` names, in path order. */
export function parseVia(via: string): PcbaLinkElement[] {
  return via
    .split('→')
    .map((slice) => slice.trim())
    .filter((slice) => slice !== '')
    .map(parseLinkElement);
}

/**
 * What sits in a link's path: its declared `elements`, else the elements
 * parsed from its `via`. Empty for plain copper.
 */
export function linkElements(link: Pick<PcbaInternalLink, 'via' | 'elements'>): PcbaLinkElement[] {
  if (link.elements !== undefined && link.elements.length > 0) return link.elements;
  return link.via === undefined ? [] : parseVia(link.via);
}

/** The `via` prose of a list of elements — their verbatim slices, joined. */
export function viaText(elements: readonly PcbaLinkElement[]): string {
  return elements.map((element) => element.text).join(VIA_SEPARATOR);
}

/** A link's printable `via`: its own prose, else the one its elements spell. */
export function linkVia(link: Pick<PcbaInternalLink, 'via' | 'elements'>): string | undefined {
  if (link.via !== undefined) return link.via;
  return link.elements === undefined || link.elements.length === 0 ? undefined : viaText(link.elements);
}

/** The reference designators a link runs through, in path order, each once. */
export function linkDesignators(link: Pick<PcbaInternalLink, 'via' | 'elements'>): string[] {
  const out: string[] = [];
  for (const element of linkElements(link)) {
    if (element.designator !== undefined && !out.includes(element.designator)) out.push(element.designator);
  }
  return out;
}
