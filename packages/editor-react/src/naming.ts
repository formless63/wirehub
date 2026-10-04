/**
 * The Library's naming rule for connectors.
 *
 *   <Family>[ <pins>-pin][ <angle>] <gender>[, <construction>] (<use>)
 *
 * - Family as the trade calls it, with the pin count folded in where the name
 *   already carries one (`DIN-8`, `Mini-DIN 9`, `DB-25`, `HD15`), else
 *   `<pins>-pin` after it (`SCART 21-pin`, `Mini-DIN 9-pin`).
 * - Angle only where the family has several (`DIN-8 270°` / `262°`).
 * - Gender as `male` / `female` — never plug / jack.
 * - Construction, short, once known: `solder cup`, `PCB mount`, `PCB edge
 *   mount`, `card edge`, `moulded` … — the thing that tells two otherwise
 *   identical connectors apart (two DIN-8 270° plugs, say).
 * - Use in parentheses: the devices or the job, never the part number.
 *
 * Labels are display names only; ids never change, and a connector keeps its
 * earlier labels as `aliases` so a search for one still finds it.
 */

import type { ConnectorBody, Interface, Vocab } from '@wirehub/model';

export const CONNECTOR_NAMING_RULE = '<Family>[ <pins>-pin][ <angle>] <gender>[, <construction>] (<use>)';

/** The short form a construction takes inside a name. */
export const CONSTRUCTION_SHORT: Readonly<Record<string, string>> = {
  'solder-cup': 'solder cup',
  'pcb-mount-th': 'PCB mount',
  'pcb-mount-smd': 'PCB mount SMD',
  'pcb-edge-mount': 'PCB edge mount',
  'card-edge': 'card edge',
  crimp: 'crimp',
  moulded: 'moulded',
};

/** The id suffix a construction variant takes (`din8-270` → `din8-270-pcb`). */
export const CONSTRUCTION_ID_SUFFIX: Readonly<Record<string, string>> = {
  'solder-cup': 'cup',
  'pcb-mount-th': 'pcb',
  'pcb-mount-smd': 'smd',
  'pcb-edge-mount': 'edge',
  'card-edge': 'edge',
  crimp: 'crimp',
  moulded: 'moulded',
};

/** A construction's label: the vocab's, else the short form, else the id. */
export function constructionLabel(vocab: Vocab | undefined, id: string | undefined): string {
  if (id === undefined || id === '') return '';
  return vocab?.['connector-constructions']?.entries.find((e) => e.id === id)?.label ?? CONSTRUCTION_SHORT[id] ?? id;
}

/**
 * "solder cup · used straddle-mounted in 12, direct in 3"
 * — a construction's label plus how the designs that use it are mounted.
 * `straddle`/`direct` are design counts (`connectorMountingUsage`); neither
 * being > 0 (a construction that has no mounting story, or no designs yet)
 * leaves the construction label bare.
 */
export function mountingSummaryText(construction: string, straddle: number, direct: number): string {
  const parts: string[] = [];
  if (straddle > 0) parts.push(`straddle-mounted in ${straddle}`);
  if (direct > 0) parts.push(`direct in ${direct}`);
  return parts.length === 0 ? construction : `${construction} · used ${parts.join(', ')}`;
}

const SHORTS = Object.values(CONSTRUCTION_SHORT).sort((a, b) => b.length - a.length);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CONSTRUCTION_SEGMENT = new RegExp(`,\\s*(?:${SHORTS.map(escape).join('|')})(?=\\s*\\(|\\s*$)`, 'i');

/**
 * `label` with its construction segment set to `construction` (added before
 * the use, replaced, or removed for `''`): "DIN-8 270° male, solder cup
 * (the source device / the source device)" + `pcb-mount-th` → "DIN-8 270° male, PCB mount
 * (the source device / the source device)".
 */
export function withConstructionInLabel(label: string, construction: string | undefined): string {
  const bare = label.replace(CONSTRUCTION_SEGMENT, '');
  const short = construction === undefined || construction === '' ? undefined : (CONSTRUCTION_SHORT[construction] ?? construction);
  if (short === undefined) return bare;
  const open = bare.indexOf(' (');
  return open < 0 ? `${bare}, ${short}` : `${bare.slice(0, open)}, ${short}${bare.slice(open)}`;
}

/** An interface's use, for the parenthesis: its label without a trailing `(…)` or `— …` note. */
export function useOfInterface(iface: Pick<Interface, 'label'> | undefined): string {
  if (iface === undefined) return '';
  return iface.label.replace(/\s+—.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** A new connector's name by the rule, from its body, pinout and construction. */
export function connectorNameOf(body: Pick<ConnectorBody, 'label'> | undefined, iface: Pick<Interface, 'label'> | undefined, construction?: string): string {
  if (body === undefined) return '';
  const base = withConstructionInLabel(body.label, construction);
  const use = useOfInterface(iface);
  return use === '' ? base : `${base} (${use})`;
}

/** A variant's id: the source id without a construction suffix, plus the new one — free of `taken`. */
export function variantIdOf(sourceId: string, construction: string, taken: readonly string[]): string {
  const suffixes = [...new Set(Object.values(CONSTRUCTION_ID_SUFFIX))];
  const stem = sourceId.replace(new RegExp(`-(?:${suffixes.join('|')})$`), '');
  const suffix = CONSTRUCTION_ID_SUFFIX[construction] ?? construction;
  const base = `${stem}-${suffix}`;
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}
