/**
 * The record kinds the bulk CSV import reads, and their columns. A column has
 * a canonical key (the template's header), a label and aliases a person's own
 * spreadsheet might use; the mapping step pairs a file's headers with these.
 */

export type LibraryKind = 'connectors' | 'wires' | 'components' | 'mechanicals' | 'pcbas' | 'kits';

export const LIBRARY_KINDS: readonly LibraryKind[] = ['connectors', 'wires', 'components', 'mechanicals', 'pcbas', 'kits'];

export interface FieldSpec {
  key: string;
  label: string;
  required?: boolean;
  /** one line on what goes in the column */
  hint: string;
  /** other headers that mean the same */
  aliases?: readonly string[];
}

const COST_FIELDS: readonly FieldSpec[] = [
  { key: 'unit_cost', label: 'Unit price', hint: 'a number; per piece, or per metre for a wire stock', aliases: ['price', 'cost', 'unit_price'] },
  { key: 'currency', label: 'Currency', hint: 'ISO code such as USD; blank uses the hub currency', aliases: ['cur'] },
  { key: 'cost_per', label: 'Priced per', hint: 'each or m (wire stocks default to m)', aliases: ['per'] },
  { key: 'cost_breaks', label: 'Quantity breaks', hint: 'minimum quantity:price pairs, separated by semicolons: 10:0.80;100:0.60', aliases: ['breaks', 'price_breaks'] },
  { key: 'moq', label: 'Minimum order', hint: 'a number', aliases: ['min_order'] },
];

const ID: FieldSpec = { key: 'id', label: 'Id', hint: 'lowercase words joined by hyphens; blank derives it from the name', aliases: ['identifier', 'slug'] };
const LABEL: FieldSpec = { key: 'label', label: 'Name', required: true, hint: 'what people call the part', aliases: ['name', 'description', 'title'] };
const SRC: FieldSpec = { key: 'src', label: 'Reference', required: true, hint: 'where the values come from: a datasheet, a measurement, a catalog page. Required on every row (or give one batch source).', aliases: ['source', 'citation', 'reference'] };
const PN: FieldSpec = { key: 'part_number', label: 'Part number', hint: 'your own orderable number for the part', aliases: ['pn', 'sku', 'partno', 'part_no', 'part'] };

export const FIELDS: Readonly<Record<LibraryKind, readonly FieldSpec[]>> = {
  connectors: [
    ID,
    LABEL,
    { key: 'family', label: 'Family', required: true, hint: 'D-Sub, RCA, XLR …', aliases: ['connector_family', 'series'] },
    { key: 'gender', label: 'Gender', hint: 'male or female (or a gender your vocabulary lists)', aliases: ['sex'] },
    PN,
    { key: 'pins', label: 'Pins', required: true, hint: 'a count (9) or the pin ids separated by semicolons (1;2;3;shell)', aliases: ['pin_count', 'pincount', 'positions', 'contacts'] },
    { key: 'pin_labels', label: 'Pin labels', hint: 'one per pin, separated by semicolons', aliases: ['pinlabels'] },
    { key: 'construction', label: 'Construction', hint: 'solder-cup, crimp, pcb-mount-th …', aliases: ['termination'] },
    { key: 'contact_rating_a', label: 'Contact rating (A)', hint: 'amps per contact', aliases: ['rating_a', 'current_a'] },
    { key: 'aliases', label: 'Aliases', hint: 'other names, separated by semicolons' },
    SRC,
    ...COST_FIELDS,
  ],
  wires: [
    ID,
    LABEL,
    PN,
    { key: 'manufacturer', label: 'Manufacturer', hint: 'who makes it', aliases: ['maker', 'brand'] },
    { key: 'spec_ref', label: 'Spec reference', hint: 'the maker\'s type or spec number', aliases: ['spec'] },
    { key: 'conductors', label: 'Conductors', hint: 'how many (blank: one per colour listed)', aliases: ['cores', 'core_count', 'wirecount'] },
    { key: 'colours', label: 'Colours', hint: 'one per conductor, separated by semicolons: black;red;white-blue', aliases: ['colors', 'colour', 'color'] },
    { key: 'area_mm2', label: 'Area (mm2)', hint: 'conductor cross-section, mm2', aliases: ['area', 'gauge_mm2', 'mm2'] },
    { key: 'material', label: 'Material', hint: 'tinned-copper, copper …', aliases: ['conductor_material'] },
    { key: 'od_mm', label: 'Outer diameter (mm)', hint: 'over the jacket, mm', aliases: ['od', 'diameter_mm', 'diameter'] },
    { key: 'shield', label: 'Shield', hint: 'none, foil, braid, spiral or tape', aliases: ['screen'] },
    SRC,
    ...COST_FIELDS,
  ],
  components: [
    ID,
    LABEL,
    { key: 'kind', label: 'Kind', required: true, hint: 'resistor, capacitor, ic, switch, other …', aliases: ['component_kind'] },
    { key: 'category', label: 'Category', hint: 'one step finer than the kind: diode, regulator, jack …' },
    { key: 'value', label: 'Value', hint: '10 kΩ, 220 µF …', aliases: ['values'] },
    PN,
    { key: 'mpn', label: 'Maker part number', hint: 'the manufacturer\'s number', aliases: ['manufacturer_part_number'] },
    { key: 'manufacturer', label: 'Manufacturer', hint: 'who makes it', aliases: ['maker', 'brand'] },
    { key: 'package', label: 'Package', hint: '0603, DO-35 …', aliases: ['footprint_name'] },
    { key: 'tolerance', label: 'Tolerance', hint: '1%, 5% …' },
    { key: 'terminals', label: 'Terminals', hint: 'a count (2) or ids separated by semicolons (a;b); blank is two', aliases: ['terminal_count'] },
    SRC,
    ...COST_FIELDS,
  ],
  mechanicals: [
    ID,
    LABEL,
    { key: 'kind', label: 'Kind', required: true, hint: 'shell, fastener or other', aliases: ['type_of_part'] },
    PN,
    { key: 'revision', label: 'Revision', hint: 'the released revision this tracks', aliases: ['rev'] },
    SRC,
    ...COST_FIELDS,
  ],
  pcbas: [
    ID,
    LABEL,
    { key: 'part_number', label: 'Part number', required: true, hint: 'the board\'s orderable number', aliases: ['pn', 'sku', 'partno', 'part_no', 'part'] },
    { key: 'revision', label: 'Revision', required: true, hint: 'the released revision this tracks', aliases: ['rev'] },
    { key: 'build', label: 'Build', hint: 'the assembly variant, such as a fab house\'s basic tier' },
    { key: 'kicad_project', label: 'KiCad project', hint: 'a reference string only', aliases: ['project'] },
    { key: 'status', label: 'Status', hint: 'active, development, legacy or retired; blank is active' },
    { key: 'terminals', label: 'Terminals', required: true, hint: 'the terminal ids separated by semicolons (vid;gnd;+5v), or a count (4 gives 1;2;3;4)', aliases: ['pads', 'pins'] },
    { key: 'terminal_labels', label: 'Terminal labels', hint: 'one per terminal, separated by semicolons', aliases: ['pad_labels'] },
    { key: 'links', label: 'Internal links', hint: 'declared continuity, separated by semicolons: from>to, or from>to:via for a part in the path (gnd1>gnd2;in>out:C1 220 uF)', aliases: ['internal_links', 'continuity'] },
    SRC,
    ...COST_FIELDS,
  ],
  kits: [
    ID,
    LABEL,
    { key: 'sku', label: 'SKU', required: true, hint: 'the kit\'s orderable number', aliases: ['part_number', 'pn', 'kit_number'] },
    { key: 'contents', label: 'Contents', required: true, hint: 'the parts, separated by semicolons: kind:id or kind:id:quantity (connector:de9-male:1;mechanical:de9-hood:1); kind is connector, pcba, mechanical, component or wire', aliases: ['parts', 'bill_of_parts', 'lines'] },
    SRC,
    ...COST_FIELDS,
  ],
};

/** A worked example row per kind, for the template (synthetic values). */
export const EXAMPLE: Readonly<Record<LibraryKind, Readonly<Record<string, string>>>> = {
  connectors: { id: 'de9-example', label: 'DE-9 example socket', family: 'D-Sub', gender: 'female', pins: '9', construction: 'solder-cup', src: 'synthetic example', unit_cost: '0.45', currency: 'USD', cost_breaks: '100:0.35' },
  wires: { id: 'example-2core', label: 'Example 2-core, 0.25 mm2', conductors: '2', colours: 'red;black', area_mm2: '0.25', material: 'tinned-copper', od_mm: '3.2', shield: 'none', src: 'synthetic example', unit_cost: '0.62', cost_per: 'm', cost_breaks: '100:0.5' },
  components: { id: 'resistor-10k-example', label: '10 kΩ resistor, 1%, 0603', kind: 'resistor', value: '10 kΩ', package: '0603', tolerance: '1%', terminals: '2', src: 'synthetic example', unit_cost: '0.002', currency: 'USD' },
  mechanicals: { id: 'de9-hood-example', label: 'DE-9 hood example', kind: 'shell', revision: 'A', src: 'synthetic example', unit_cost: '0.8' },
  pcbas: { id: 'breakout-example', label: 'Breakout board example', part_number: 'EX-PCBA-1', revision: 'A', terminals: 'in;out;gnd', terminal_labels: 'Input;Output;Ground', links: 'in>out:C1 100 nF', src: 'synthetic example', unit_cost: '4.2', currency: 'USD' },
  kits: { id: 'kit-de9-example', label: 'DE-9 example kit', sku: 'KIT-EXAMPLE-1', contents: 'connector:de9-male:1;mechanical:de9-backshell:1', src: 'synthetic example' },
};

export const TYPE_COLUMN = 'type';

const norm = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** The field a header names (its canonical key, an alias or its label), if any. */
export function fieldFor(kind: LibraryKind, header: string): FieldSpec | undefined {
  const h = norm(header);
  if (h === '') return undefined;
  return FIELDS[kind].find((f) => f.key === h || norm(f.label) === h || (f.aliases ?? []).some((a) => norm(a) === h));
}

/** The kind a `type` cell names. */
export function kindOfType(text: string): LibraryKind | undefined {
  const t = norm(text);
  if (/^connectors?$/.test(t)) return 'connectors';
  if (/^(wires?|wire_stocks?|stocks?|cables?)$/.test(t)) return 'wires';
  if (/^components?$/.test(t)) return 'components';
  if (/^(mechanicals?|mechanical_parts?|hardware)$/.test(t)) return 'mechanicals';
  if (/^(pcbas?|pcbs?|boards?)$/.test(t)) return 'pcbas';
  if (/^kits?$/.test(t)) return 'kits';
  return undefined;
}

/** Headers specific to one kind, to tell the kinds apart when a file has no `type` column. */
const SIGNATURE: Readonly<Record<LibraryKind, readonly string[]>> = {
  connectors: ['family', 'pin_labels', 'contact_rating_a', 'construction'],
  wires: ['conductors', 'colours', 'area_mm2', 'od_mm', 'shield'],
  components: ['value', 'terminals', 'package', 'tolerance', 'mpn'],
  mechanicals: ['revision'],
  pcbas: ['terminal_labels', 'links', 'kicad_project', 'build'],
  kits: ['sku', 'contents'],
};

/** The one kind the headers point to, or `undefined` when none or several do. */
export function detectKind(headers: readonly string[]): LibraryKind | undefined {
  const scores = LIBRARY_KINDS.map((kind) => ({ kind, score: SIGNATURE[kind].filter((key) => headers.some((h) => fieldFor(kind, h)?.key === key)).length }));
  const best = Math.max(...scores.map((s) => s.score));
  if (best === 0) return undefined;
  const top = scores.filter((s) => s.score === best);
  return top.length === 1 ? top[0]!.kind : undefined;
}

/** The mapping a file's headers suggest: for each field of the kind, the index of the header that names it. */
export function suggestMapping(kind: LibraryKind, headers: readonly string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  headers.forEach((h, index) => {
    const field = fieldFor(kind, h);
    if (field !== undefined && mapping[field.key] === undefined) mapping[field.key] = index;
  });
  return mapping;
}
