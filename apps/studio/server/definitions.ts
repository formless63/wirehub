/**
 * The definition endpoints — request in, response out, no IO.
 *
 * The same shape `api.ts` has, for the other half of the catalog: connectors,
 * components, wire stocks and curated PCBAs. `handleDefinitionRequest` is a
 * pure function of `(method, path parts, body, deps)`, the store is an
 * interface (`definition-store.ts`), and nothing in this file knows what a
 * socket or a file handle is.
 *
 * The rules, and why each one is here:
 *
 * 1. **Validate the whole library, not the record.** A design save only has to
 *    be a good design; a *definition* save can break records the user is not
 *    looking at — take pin `15` off a SCART connector and every PCBA that
 *    integrates it now declares continuity to a pin that does not exist, and
 *    every design that solders to it is unbuildable. So the candidate library
 *    goes through `validateDb`, and every design goes through `validateDesign`
 *    against it, before anything is written.
 * 2. **Only what the edit broke.** Those checks are reported as a *diff*
 *    against the library as it stands. A catalog that already has a problem
 *    somewhere else must not make every definition uneditable — that is a
 *    dead-end, and the spec forbids dead-ends.
 * 3. **A delete names its referrers.** This is rule 4 of the spec, the half
 *    `deleteDesign` could not implement because nothing references a design.
 *    Everything references a definition, so a delete scans the designs and the
 *    other definitions, refuses with 409, and says who is using it.
 * 4. **`src` is required.** Provenance is an input, not an afterthought.
 *
 * Every message is written for the person who has to act on it: `error` is a
 * sentence, `hint` is the next step, `issues` is the validator's own list which
 * the GUI renders in plain language.
 */

import {
  KIT_PART_KINDS,
  composeConnector,
  connectorMountingUsage,
  decomposeConnector,
  definitionUsage,
  errors,
  kitsContaining,
  recordMetaIssues,
  validateDb,
  validateDesign,
  type CableDesign,
  type ComponentDefinition,
  type ConnectorBody,
  type ConnectorDefinition,
  type Db,
  type Interface,
  type InterfaceLibrary,
  type Issue,
  type KitDefinition,
  type KitPartKind,
  type MechanicalDefinition,
  type PartNumberScheme,
  type PcbaDefinition,
  type WireDefinition,
} from '@wirehub/model';
import type { ModuleRegistry } from '@wirehub/modules';

import type { InstalledPacks } from '@wirehub/catalog';
import { refuseChangedNumber } from './part-number-guard.ts';
import { partNumberSchemeOf } from './part-number-scheme.ts';

import type { ApiError, ApiResponse } from './api.ts';
import {
  DEFINITION_KINDS,
  isDefinitionKind,
  type DefinitionKind,
  type DefinitionRecord,
  type DefinitionStore,
} from './definition-store.ts';
import { readAllDesigns, type DesignStore } from './designs.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import type { Awaitable } from './storage/change-set.ts';

/* ------------------------------------------------------------------ *
 * Deps
 * ------------------------------------------------------------------ */

/**
 * What the definition handlers need. A superset of the design API's deps:
 * the referential check reads designs, and the whole-library validation needs
 * the definition library the candidate is being folded into.
 *
 * `definitions` is optional because a host may serve designs without offering
 * definition editing (a read-only deployment, a test that only exercises the
 * design routes). Absent, these endpoints say so in words rather than 404ing
 * into silence.
 */
export interface DefinitionDeps {
  definitions?: DefinitionStore;
  designs: DesignStore;
  loadDb: () => Awaitable<Db>;
  /**
   * The installed catalog packs (`packs.json`): which records came from a pack.
   * Those are read-only here (edit and delete answer 409) and can be forked
   * to a local copy. Absent: no record is a pack's.
   */
  installedPacks?: () => Awaitable<InstalledPacks>;
  /** where the numbering scheme comes from (`part-number-scheme.ts`); absent: the default scheme */
  loadPartNumberFiles?: () => Awaitable<{ scheme?: unknown }>;
  modules?: Pick<ModuleRegistry, 'partNumberScheme'>;
}

/* ------------------------------------------------------------------ *
 * Small shared shapes
 * ------------------------------------------------------------------ */

function fail(status: number, error: string, hint?: string, issues?: Issue[]): ApiResponse {
  const body: ApiError = { error, ...(hint === undefined ? {} : { hint }) };
  if (issues !== undefined) body.issues = issues;
  return { status, body };
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): ApiResponse {
  return { status, body, ...(headers === undefined ? {} : { headers }) };
}

const ID_RULE =
  'Ids are lowercase words joined by hyphens, like `de9-male` or `cap-220uf-tant` — no spaces, capitals or slashes; a dot only inside a number (`hw-nut-m2.5`).';

/** The record id rule. Kebab-case: a definition id is quoted in files and URLs. */
export function isDefinitionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+|(?<=\d)\.\d[a-z0-9]*)*$/.test(value);
}

/** What each kind is called when a sentence has to name one. */
const KIND_NOUN: Record<DefinitionKind, string> = {
  connectors: 'connector',
  components: 'component',
  wires: 'wire stock',
  pcbas: 'board',
  bodies: 'connector body',
  interfaces: 'pinout',
  mechanicals: 'shell or fastener',
  kits: 'kit',
};

/** The plural, for lists and counts. */
const KIND_PLURAL: Record<DefinitionKind, string> = {
  connectors: 'connectors',
  components: 'components',
  wires: 'wire stocks',
  pcbas: 'boards',
  bodies: 'connector bodies',
  interfaces: 'pinouts',
  mechanicals: 'shells and fasteners',
  kits: 'kits',
};

/** Every route this module answers, for the `/api` index and the 404's hint. */
export const DEFINITION_ROUTES = [
  'GET    /api/definitions',
  'GET    /api/definitions/:kind',
  'GET    /api/definitions/:kind/:id',
  'GET    /api/definitions/:kind/:id/usage',
  'PUT    /api/definitions/:kind/:id',
  'POST   /api/definitions',
  'POST   /api/definitions/:kind/:id/fork',
  'DELETE /api/definitions/:kind/:id',
] as const;

/* ------------------------------------------------------------------ *
 * The structural gate
 * ------------------------------------------------------------------ */

type Gate<T> = { ok: true; record: T } | { ok: false; response: ApiResponse };

function reject<T>(error: string, hint: string): Gate<T> {
  return { ok: false, response: fail(400, error, hint) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The checks every definition shares: it is an object, it has a usable id, it
 * has a name, and it says where its information came from.
 *
 * `validateDb` reports a missing `src` as a *warning*, because the library has
 * to stay loadable when an old record predates the rule. A new or edited
 * record coming through the GUI has no such excuse: the spec makes provenance
 * a required input, and this is where that is enforced.
 */
function gateCommon(kind: DefinitionKind, value: unknown): Gate<Record<string, unknown>> {
  if (!isObject(value)) {
    return reject(
      `That is not a ${KIND_NOUN[kind]}.`,
      `The body of this request has to be a single ${KIND_NOUN[kind]} record.`,
    );
  }
  if (!isDefinitionId(value['id'])) {
    return reject(
      `${JSON.stringify(String(value['id']))} cannot be used as a ${KIND_NOUN[kind]} id.`,
      ID_RULE,
    );
  }
  if (!isFilledString(value['label'])) {
    return reject(
      `This ${KIND_NOUN[kind]} has no name.`,
      'Give it a label — the words a builder will see on the schematic and the build sheet.',
    );
  }
  if (!isFilledString(value['src'])) {
    return reject(
      `This ${KIND_NOUN[kind]} does not say where its information comes from.`,
      'Fill in "Where does this information come from?" — a spec sheet, a measurement, or a note that the values were inferred.',
    );
  }
  const meta = recordMetaIssues(value, String(value['id']))[0];
  if (meta !== undefined) {
    return reject(
      `This ${KIND_NOUN[kind]}'s ${meta.code === 'record-license' ? 'licence' : meta.code === 'record-derived-from' ? 'fork origin' : 'provenance'} is not in the right form.`,
      meta.message,
    );
  }
  return { ok: true, record: value };
}

function gateConnector(value: unknown): Gate<ConnectorDefinition> {
  const common = gateCommon('connectors', value);
  if (!common.ok) return common;
  const record = common.record;
  if (!isFilledString(record['family'])) {
    return reject(
      'This connector does not say what family it belongs to.',
      'Name the connector family — D-Sub, DIN, RJ45, XLR, RCA …',
    );
  }
  const gender = record['gender'];
  if (gender !== undefined && gender !== 'male' && gender !== 'female') {
    return reject(
      `${JSON.stringify(String(gender))} is not a gender this studio understands.`,
      'A connector is male, female, or left unsaid.',
    );
  }
  if (!isOptionalString(record['construction'])) {
    return reject("The connector's construction is not text.", 'Pick one from the list — solder cup, PCB mount, crimp, moulded …');
  }
  const housing = gateHousing(record['housing']);
  if (housing !== undefined) return reject(housing.error, housing.hint);
  if (!isOptionalNumber(record['contactRatingA'])) {
    return reject("The connector's contact rating is not a number.", 'Write the rated current of one contact in amps — 3, 7.5.');
  }
  if (!isOptionalString(record['sourcing'])) {
    return reject("The connector's sourcing is not text.", 'Pick one from the list — pre-made lead, or leave it unset for one the bench terminates.');
  }
  const names = record['aliases'];
  if (names !== undefined && (!Array.isArray(names) || names.some((a) => typeof a !== 'string'))) {
    return reject("The connector's other names are not a list of words.", 'Aliases are earlier names it went by, one per entry.');
  }
  const pins = record['pins'];
  if (!Array.isArray(pins)) {
    return reject(
      'This connector has no pin list.',
      'A connector needs a pins list, even while it is still empty.',
    );
  }
  for (const [index, pin] of pins.entries()) {
    const at = `Pin ${index + 1}`;
    if (!isObject(pin) || !isFilledString(pin['id'])) {
      return reject(
        `${at} has no number or name of its own.`,
        'Every pin needs an id — the number or letter printed on the connector, like `1`, `15` or `shell`.',
      );
    }
    if (!isOptionalString(pin['label'])) {
      return reject(`${at}'s label is not text.`, 'A pin label is the signal it carries, in words.');
    }
    const aliases = pin['aliases'];
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string'))) {
      return reject(
        `${at}'s other names are not a list of words.`,
        'Aliases are the other names this pin goes by, one per entry.',
      );
    }
    if (!isOptionalNumber(pin['currentA'])) {
      return reject(`${at}'s current is not a number.`, 'Write the current this pin carries in amps — 0.5, 3.');
    }
    if (!isOptionalString(pin['note'])) {
      return reject(`${at}'s note is not text.`, 'A note is a sentence about this pin.');
    }
  }
  return { ok: true, record: value as ConnectorDefinition };
}

const COMPONENT_KINDS = ['resistor', 'capacitor', 'ic', 'switch', 'other'] as const;

function gateComponent(value: unknown): Gate<ComponentDefinition> {
  const common = gateCommon('components', value);
  if (!common.ok) return common;
  const record = common.record;
  if (!(COMPONENT_KINDS as readonly unknown[]).includes(record['kind'])) {
    return reject(
      `${JSON.stringify(String(record['kind']))} is not a kind of component this studio knows.`,
      `Pick one of: ${COMPONENT_KINDS.join(', ')}.`,
    );
  }
  if (!isOptionalString(record['value']) || !isOptionalString(record['partNumber'])) {
    return reject(
      'The value and part number have to be text.',
      'Write the value the way it is spoken — "330 Ω", "220 µF".',
    );
  }
  const terminals = record['terminals'];
  if (!Array.isArray(terminals)) {
    return reject(
      'This component has no terminals.',
      'A component needs a terminals list — two for a resistor or capacitor.',
    );
  }
  for (const [index, terminal] of terminals.entries()) {
    const at = `Terminal ${index + 1}`;
    if (!isObject(terminal) || !isFilledString(terminal['id'])) {
      return reject(
        `${at} has no name of its own.`,
        'Every terminal needs an id — `a` and `b` for a two-legged part.',
      );
    }
    if (!isOptionalString(terminal['label'])) {
      return reject(`${at}'s label is not text.`, 'A terminal label is what that leg is called.');
    }
    const polarity = terminal['polarity'];
    if (polarity !== undefined && polarity !== '+' && polarity !== '-') {
      return reject(
        `${at} has a polarity of ${JSON.stringify(String(polarity))}.`,
        'A polarised part marks its legs + and -; everything else leaves polarity unsaid.',
      );
    }
  }
  return { ok: true, record: value as ComponentDefinition };
}

/** The element tree, checked for shape only — `validateDb` judges the content. */
function gateElement(value: unknown, where: string): { error: string; hint: string } | undefined {
  if (!isObject(value)) {
    return { error: `${where} is not a part of the cable.`, hint: 'Every element is one object.' };
  }
  const kind = value['kind'];
  if (kind !== 'conductor' && kind !== 'insulation' && kind !== 'shield' && kind !== 'group') {
    return {
      error: `${where} is a '${String(kind)}', which is not something a cable is made of.`,
      hint: 'A cable is built from conductors, insulation, shields and groups.',
    };
  }
  if (!isFilledString(value['id'])) {
    return {
      error: `${where} has no name of its own.`,
      hint: 'Every element needs an id — `center`, `shield`, `jacket`, `core-red`.',
    };
  }
  const at = `${where} '${String(value['id'])}'`;
  if (kind === 'group') {
    const children = value['children'];
    if (!Array.isArray(children)) {
      return { error: `${at} has nothing inside it.`, hint: 'A group needs a children list.' };
    }
    for (const child of children) {
      const bad = gateElement(child, `inside ${at},`);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  if (kind === 'shield' && !isFilledString(value['construction'])) {
    return {
      error: `${at} does not say how it is made.`,
      hint: 'A shield is a braid, a spiral serve, a foil or a tape.',
    };
  }
  for (const field of ['odMm', 'insulatedOdMm', 'areaMm2', 'ratedCurrentA', 'resistanceOhmPerKm']) {
    if (!isOptionalNumber(value[field])) {
      const what = field === 'areaMm2' ? 'cross-section area' : field === 'ratedCurrentA' ? 'rated current' : field === 'resistanceOhmPerKm' ? 'resistance' : 'diameter';
      return {
        error: `${at} has a ${what} that is not a number.`,
        hint: 'Diameters are millimetres, written as numbers — 1.4, not "1.4 mm".',
      };
    }
  }
  return undefined;
}

function gateWire(value: unknown): Gate<WireDefinition> {
  const common = gateCommon('wires', value);
  if (!common.ok) return common;
  const record = common.record;
  const structure = record['structure'];
  if (!isObject(structure) || structure['kind'] !== 'group') {
    return reject(
      'This wire stock has no structure.',
      'A stock is a group — the whole cable — with its cores, shield, drain and jacket inside it.',
    );
  }
  const bad = gateElement(structure, 'The cable');
  if (bad !== undefined) return reject(bad.error, bad.hint);
  if (!isOptionalNumber(record['odMm'])) {
    return reject(
      'The overall diameter is not a number.',
      'Diameters are millimetres, written as numbers — 9, not "9 mm".',
    );
  }
  const lay = record['layOrder'];
  if (lay !== undefined) {
    if (!isObject(lay)) {
      return reject('The lay order is not readable.', 'Lay order is one object, or left out entirely.');
    }
    if (lay['arrangement'] !== '6-around-1') {
      return reject(
        `'${String(lay['arrangement'])}' is not a lay this studio can draw.`,
        'The only arrangement it knows is 6-around-1: six cores around one centre core.',
      );
    }
    if (lay['direction'] !== 'cw' && lay['direction'] !== 'ccw') {
      return reject(
        'The lay order does not say which way round it reads.',
        'Looking into the cut face, the colours run either clockwise (cw) or counter-clockwise (ccw).',
      );
    }
    const ring = lay['ring'];
    if (!Array.isArray(ring) || ring.some((member) => !isFilledString(member))) {
      return reject(
        'The lay order does not name its cores.',
        'The ring is the list of cores on the outside, in the order they are laid.',
      );
    }
    if (!isFilledString(lay['src'])) {
      return reject(
        'The lay order does not say where it comes from.',
        'The lay order is a fact of the stock — cite the spec sheet that prints the colour order.',
      );
    }
  }
  return { ok: true, record: value as WireDefinition };
}

function gatePcba(value: unknown): Gate<PcbaDefinition> {
  const common = gateCommon('pcbas', value);
  if (!common.ok) return common;
  const record = common.record;
  if (!isFilledString(record['partNumber'])) {
    return reject(
      'This board has no part number.',
      'Use the number printed on the board — PCA-00001.',
    );
  }
  if (!isFilledString(record['revision'])) {
    return reject(
      'This board does not say which revision it is.',
      'Boards change; the revision is what tells two of them apart — Rev6.',
    );
  }
  if (!isOptionalString(record['build']) || !isOptionalString(record['kicadProject'])) {
    return reject(
      'The build and project name have to be text.',
      'The build is the populated variant, like "Standard" or "Terminated".',
    );
  }
  const terminals = record['terminals'];
  if (!Array.isArray(terminals)) {
    return reject(
      'This board has no pads.',
      'A board needs a terminals list — the pads a conductor lands on.',
    );
  }
  for (const [index, terminal] of terminals.entries()) {
    if (!isObject(terminal) || !isFilledString(terminal['id'])) {
      return reject(
        `Pad ${index + 1} has no name of its own.`,
        'Every pad needs an id — the silkscreen text beside it, like `R`, `GND` or `5V`.',
      );
    }
    if (!isOptionalString(terminal['label']) || !isOptionalString(terminal['note'])) {
      return reject(`Pad '${String(terminal['id'])}' has a label or note that is not text.`, 'Both are sentences.');
    }
  }
  const integrated = record['integratedConnectors'];
  if (integrated !== undefined) {
    if (!Array.isArray(integrated)) {
      return reject(
        'The connectors soldered to this board are not a list.',
        'Each entry names a connector definition and the prefix its pins get.',
      );
    }
    for (const entry of integrated) {
      if (!isObject(entry) || !isFilledString(entry['connectorDefId']) || !isFilledString(entry['terminalPrefix'])) {
        return reject(
          'A connector soldered to this board is missing its definition or its prefix.',
          'Say which connector it is and what its pins are called here — `j1` makes pin 15 into `j1.15`.',
        );
      }
    }
  }
  const links = record['internalLinks'];
  if (!Array.isArray(links)) {
    return reject(
      'This board does not declare what is connected inside it.',
      'A board needs an internal links list, even when it is still empty.',
    );
  }
  for (const [index, link] of links.entries()) {
    if (!isObject(link) || !isFilledString(link['from']) || !isFilledString(link['to'])) {
      return reject(
        `Internal link ${index + 1} does not say what it joins.`,
        'Every link runs from one pad or pin to another.',
      );
    }
    if (!isOptionalString(link['via']) || !isOptionalString(link['note'])) {
      return reject(
        `Internal link ${index + 1} has a "through" or note that is not text.`,
        'The "through" text is what sits in the path — "C1 220 µF".',
      );
    }
  }
  return { ok: true, record: value as PcbaDefinition };
}

const POSITION_KINDS = ['pin', 'shell', 'key'] as const;

function gateBody(value: unknown): Gate<ConnectorBody> {
  const common = gateCommon('bodies', value);
  if (!common.ok) return common;
  const record = common.record;
  if (!isFilledString(record['family'])) {
    return reject('This body does not say what family it belongs to.', 'Pick the connector family — DIN, Mini-DIN, D-Sub, RJ45 …');
  }
  if (record['gender'] !== 'male' && record['gender'] !== 'female') {
    return reject('A connector body is a plug (male) or a socket (female).', 'Pick the gender.');
  }
  const housing = gateHousing(record['housing']);
  if (housing !== undefined) return reject(housing.error, housing.hint);
  const positions = record['positions'];
  if (!Array.isArray(positions) || positions.length === 0) {
    return reject('This body has no positions.', 'Pick a layout — it lays out the numbered contacts, and the shell when it is one.');
  }
  for (const [index, position] of positions.entries()) {
    if (!isObject(position) || !isFilledString(position['id'])) {
      return reject(`Position ${index + 1} has no number or name.`, 'Every position needs an id — `1`, `15`, `tip`, `shell`.');
    }
    const kind = position['kind'];
    if (kind !== undefined && !(POSITION_KINDS as readonly unknown[]).includes(kind)) {
      return reject(`Position '${String(position['id'])}' is a '${String(kind)}'.`, 'A position is a pin, the shell or a key.');
    }
  }
  for (const field of ['mates', 'partNumber', 'drawing', 'construction']) {
    if (!isOptionalString(record[field])) return reject(`The body's ${field} is not text.`, 'Leave it out, or write it as words.');
  }
  return { ok: true, record: value as ConnectorBody };
}

const PIN_DIRS = ['out', 'in', 'bidir', 'passive'] as const;
const CONFIDENCES = ['net-verified', 'documented', 'inferred', 'unknown'] as const;

function gatePinMap(pins: unknown, where: string): { error: string; hint: string } | undefined {
  if (!isObject(pins)) return { error: `${where} has no pin map.`, hint: 'A pinout says, per body position, what signal it carries.' };
  for (const [position, fn] of Object.entries(pins)) {
    const at = `${where} position '${position}'`;
    if (!isObject(fn)) return { error: `${at} is not a pin.`, hint: 'Every assigned position names a signal.' };
    const signal = fn['signal'];
    const oneOf = isObject(signal) ? signal['oneOf'] : undefined;
    if (!isFilledString(signal) && !(Array.isArray(oneOf) && oneOf.length > 0 && oneOf.every(isFilledString))) {
      return { error: `${at} does not name a signal.`, hint: 'Pick the signal it carries from the list.' };
    }
    if (fn['dir'] !== undefined && !(PIN_DIRS as readonly unknown[]).includes(fn['dir'])) {
      return { error: `${at} has direction '${String(fn['dir'])}'.`, hint: `A direction is one of ${PIN_DIRS.join(', ')}.` };
    }
    if (fn['confidence'] !== undefined && !(CONFIDENCES as readonly unknown[]).includes(fn['confidence'])) {
      return { error: `${at} has confidence '${String(fn['confidence'])}'.`, hint: `Confidence is one of ${CONFIDENCES.join(', ')}.` };
    }
    for (const field of ['label', 'note', 'src']) {
      if (!isOptionalString(fn[field])) return { error: `${at}'s ${field} is not text.`, hint: 'Write it as words.' };
    }
  }
  return undefined;
}

function gateInterface(value: unknown): Gate<Interface> {
  const common = gateCommon('interfaces', value);
  if (!common.ok) return common;
  const record = common.record;
  const bodies = record['bodies'];
  if (!Array.isArray(bodies) || bodies.length === 0 || !bodies.every(isFilledString)) {
    return reject('This pinout is not on any body.', 'A pinout names the connector body (or bodies) whose positions it assigns.');
  }
  const bad = gatePinMap(record['pins'], 'This pinout');
  if (bad !== undefined) return reject(bad.error, bad.hint);
  if (record['confidence'] !== undefined && !(CONFIDENCES as readonly unknown[]).includes(record['confidence'])) {
    return reject(`Confidence '${String(record['confidence'])}' is not one this studio knows.`, `Pick one of ${CONFIDENCES.join(', ')}.`);
  }
  return { ok: true, record: value as Interface };
}

const MECHANICAL_KINDS = ['shell', 'fastener', 'boot', 'other', 'contact', 'seal', 'plug', 'tool'] as const;

const isOptionalWords = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every(isFilledString));

/** The shape of a contact's, seal's, plug's or tool's `termination` block (`crimp.ts`); the ranges are `validateDb`'s. */
function gateTermination(value: unknown): { error: string; hint: string } | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return { error: 'What this part fits is not in the right form.', hint: 'It is an object: systems, wire and insulation ranges, plating, strip length, crimp heights, tool.' };
  if (!isOptionalWords(value['systems']) || !isOptionalWords(value['housings'])) return { error: 'The systems or housings it fits are not a list of ids.', hint: 'List contact system ids (sealed-1-5) and connector or body ids.' };
  for (const key of ['wireMinMm2', 'wireMaxMm2', 'insulationMinMm', 'insulationMaxMm', 'stripMm', 'ratedCurrentA']) {
    if (!isOptionalNumber(value[key])) return { error: `${key} is not a number.`, hint: 'Write sizes as plain numbers: mm² for wire, mm for insulation and strip length.' };
  }
  for (const key of ['gender', 'plating', 'tool', 'src']) {
    if (!isOptionalString(value[key])) return { error: `${key} is not text.`, hint: 'Write it as words or an id.' };
  }
  const heights = value['crimpHeights'];
  if (heights !== undefined && (!Array.isArray(heights) || !heights.every((h) => isObject(h) && typeof h['wireMm2'] === 'number' && typeof h['heightMm'] === 'number' && isOptionalNumber(h['widthMm'])))) {
    return { error: 'The crimp heights are not in the right form.', hint: 'One entry per wire size: wireMm2, heightMm and optionally widthMm.' };
  }
  const tools = value['tools'];
  if (tools !== undefined) {
    const heightsOk = (h: unknown): boolean => h === undefined || (Array.isArray(h) && h.every((e) => isObject(e) && typeof e['wireMm2'] === 'number' && typeof e['heightMm'] === 'number' && isOptionalNumber(e['widthMm'])));
    if (!Array.isArray(tools) || !tools.every((t) => isObject(t) && isFilledString(t['tool']) && heightsOk(t['crimpHeights']) && isOptionalNumber(t['stripMm']) && isOptionalString(t['note']))) {
      return { error: 'The other crimp tools are not in the right form.', hint: 'One entry per tool: the tool id, and optionally its crimpHeights (wireMm2, heightMm, widthMm), stripMm and note.' };
    }
  }
  return undefined;
}

/** The shape of a connector's or body's crimp `housing` (`crimp.ts`). */
export function gateHousing(value: unknown): { error: string; hint: string } | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return { error: 'The crimp housing is not in the right form.', hint: 'It is an object: systems, sealing, plugUnused, cavities.' };
  if (!isOptionalWords(value['systems']) || !isOptionalWords(value['cavities'])) return { error: 'The housing systems or cavities are not a list of ids.', hint: 'List contact system ids and pin ids.' };
  if (value['sealing'] !== undefined && !['none', 'per-wire', 'mat'].includes(String(value['sealing']))) return { error: `Sealing '${String(value['sealing'])}' is not one this studio knows.`, hint: 'Pick none, per-wire or mat.' };
  if (value['plugUnused'] !== undefined && typeof value['plugUnused'] !== 'boolean') return { error: '"Plug unused cavities" is not yes or no.', hint: 'Tick it for a sealed housing whose unused cavities take a plug.' };
  if (!isOptionalString(value['src'])) return { error: "The housing's source is not text.", hint: 'Write it as words.' };
  return undefined;
}

function gateMechanical(value: unknown): Gate<MechanicalDefinition> {
  const common = gateCommon('mechanicals', value);
  if (!common.ok) return common;
  const record = common.record;
  if (!(MECHANICAL_KINDS as readonly unknown[]).includes(record['kind'])) {
    return reject(`'${String(record['kind'])}' is not a kind of mechanical part.`, 'A mechanical part is a shell, a fastener, a strain-relief boot, a crimp contact, a seal, a cavity plug, a crimp tool, or other.');
  }
  const termination = gateTermination(record['termination']);
  if (termination !== undefined) return reject(termination.error, termination.hint);
  if (!isOptionalString(record['partNumber']) || !isOptionalString(record['revision'])) {
    return reject('The part number and revision have to be text.', 'Write them as printed — SHL-00102-00, Rev 3.');
  }
  return { ok: true, record: value as MechanicalDefinition };
}

function gateKit(value: unknown): Gate<KitDefinition> {
  const common = gateCommon('kits', value);
  if (!common.ok) return common;
  const record = common.record;
  if (!isFilledString(record['sku'])) {
    return reject('This kit has no SKU.', 'A kit is an orderable item — give it its SKU, like KIT-00101-00.');
  }
  const contents = record['contents'];
  if (!Array.isArray(contents)) return reject('This kit has no parts list.', 'A kit lists the parts it ships.');
  for (const [index, line] of contents.entries()) {
    const at = `Line ${index + 1}`;
    const part = isObject(line) ? line['part'] : undefined;
    if (!isObject(line) || !isObject(part) || !(KIT_PART_KINDS as readonly unknown[]).includes(part['kind']) || !isFilledString(part['def'])) {
      return reject(`${at} does not name a part.`, 'Pick the part from the library — a connector, board, shell, fastener, component or wire.');
    }
    if (typeof line['qty'] !== 'number') return reject(`${at} has no quantity.`, 'How many of this part the kit ships — 1, or 4 screws.');
    const when = line['when'];
    if (when !== undefined && (!isObject(when) || (when['stockFamily'] !== undefined && when['stockFamily'] !== 'coax' && when['stockFamily'] !== 'bonded'))) {
      return reject(`${at} is scoped to a stock this studio does not know.`, 'A line is for every stock, coax only, or bonded multi-core only.');
    }
    if (line['inferred'] !== undefined && typeof line['inferred'] !== 'boolean') {
      return reject(`${at}'s "inferred" flag is not yes or no.`, 'Tick it when the line is an inference rather than a stated fact.');
    }
    if (!isOptionalString(line['note']) || !isOptionalString(line['src'])) return reject(`${at}'s note or source is not text.`, 'Write them as words.');
  }
  return { ok: true, record: value as KitDefinition };
}

/** The structural gate for one kind. Exported so the tests can hold it directly. */
export function readDefinitionBody(kind: DefinitionKind, value: unknown): Gate<DefinitionRecord> {
  switch (kind) {
    case 'connectors':
      return gateConnector(value);
    case 'components':
      return gateComponent(value);
    case 'wires':
      return gateWire(value);
    case 'pcbas':
      return gatePcba(value);
    case 'bodies':
      return gateBody(value);
    case 'interfaces':
      return gateInterface(value);
    case 'mechanicals':
      return gateMechanical(value);
    case 'kits':
      return gateKit(value);
  }
}

/* ------------------------------------------------------------------ *
 * The candidate library
 * ------------------------------------------------------------------ */

/**
 * The library as it would stand with `records` in place of the stored file.
 *
 * PCBAs need the extra step: `loadDb().pcbas` is the curated file *plus* every
 * generated board the curated file does not claim, and only the curated half is
 * editable. Folding a curated edit back in has to preserve that precedence, or
 * saving a curated board would silently drop the generated ones.
 */
export function candidateDb(
  db: Db,
  kind: DefinitionKind,
  records: DefinitionRecord[],
  stored: DefinitionRecord[],
): Db {
  if (kind === 'connectors') return { ...db, connectors: records as ConnectorDefinition[] };
  if (kind === 'components') return { ...db, components: records as ComponentDefinition[] };
  if (kind === 'wires') return { ...db, wires: records as WireDefinition[] };
  if (kind === 'mechanicals') return { ...db, mechanicals: records as MechanicalDefinition[] };
  if (kind === 'kits') return { ...db, kits: records as KitDefinition[] };
  if (kind === 'bodies' || kind === 'interfaces') {
    // a body or pinout edit re-composes every connector built on it — that is
    // how a design soldering to a position the edit removed gets caught
    const before: InterfaceLibrary = {
      bodies: db.bodies ?? [],
      interfaces: db.interfaces ?? [],
      ...(db.vocab === undefined ? {} : { vocab: db.vocab }),
    };
    const after: InterfaceLibrary =
      kind === 'bodies'
        ? { ...before, bodies: records as ConnectorBody[] }
        : { ...before, interfaces: records as Interface[] };
    return {
      ...db,
      bodies: [...after.bodies],
      interfaces: [...after.interfaces],
      connectors: db.connectors.map((connector) => composeConnector(decomposeConnector(connector, before), after)),
    };
  }
  const curatedIds = new Set(stored.map((record) => record.id));
  const generated = db.pcbas.filter((pcba) => !curatedIds.has(pcba.id));
  const claimed = new Set(records.map((record) => record.id));
  return {
    ...db,
    pcbas: [...(records as PcbaDefinition[]), ...generated.filter((pcba) => !claimed.has(pcba.id))],
  };
}

/** A stable identity for one finding, so two runs can be compared. */
function issueKey(issue: Issue): string {
  return `${issue.code}\u0000${issue.where ?? ''}\u0000${issue.message}`;
}

/**
 * Everything wrong with a whole library: the definitions among themselves, and
 * every design read against them. Design findings carry the design in `where`,
 * because "this connector no longer has a pin 15" is only actionable once you
 * know which cable was soldering to it.
 */
export function libraryIssues(db: Db, designs: CableDesign[], scheme?: PartNumberScheme): Issue[] {
  return [
    ...validateDb(db, scheme === undefined ? {} : { scheme }),
    ...designs.flatMap((design) =>
      validateDesign(design, db).map((issue) => ({
        ...issue,
        where: issue.where === undefined ? `designs/${design.id}` : `designs/${design.id} · ${issue.where}`,
      })),
    ),
  ];
}

async function everyDesign(deps: DefinitionDeps): Promise<CableDesign[]> {
  return readAllDesigns(deps.designs);
}

/**
 * Rule 1 and rule 2 together: run the candidate library past every validator,
 * and refuse it with whatever the edit *introduced*.
 *
 * The diff is what keeps the surface honest. Reporting the absolute list would
 * mean one bad record somewhere in the catalog froze every editor in the
 * studio, and the user could not even fix the bad record — which is the exact
 * dead-end the workbench exists to remove.
 */
async function validatedLibrary(
  candidate: Db,
  baseline: Db,
  designs: CableDesign[],
  what: string,
  scheme?: PartNumberScheme,
  /** a save (not a delete) refuses a part number newly taken by two parts, though validation only warns */
  refuseDuplicateNumbers = false,
): Promise<ApiResponse | undefined> {
  const blockers = (issues: Issue[]): Issue[] => issues.filter((i) => i.severity === 'error' || (refuseDuplicateNumbers && i.code === 'pn-duplicate'));
  const introduced = blockers(libraryIssues(candidate, designs, scheme));
  if (introduced.length === 0) return undefined;
  const before = new Set(blockers(libraryIssues(baseline, designs, scheme)).map(issueKey));
  const blocking = introduced.filter((issue) => !before.has(issueKey(issue)));
  if (blocking.length === 0) return undefined;
  return fail(
    422,
    blocking.length === 1
      ? `Saving ${what} would break something.`
      : `Saving ${what} would break ${blocking.length} things.`,
    'Nothing was written — the catalog is untouched. The list below is what this change would have broken (a part number already on another part counts); fix it and save again.',
    blocking,
  );
}

/* ------------------------------------------------------------------ *
 * The referential check — rule 4
 * ------------------------------------------------------------------ */

export interface DefinitionUsage {
  kind: DefinitionKind;
  id: string;
  /** the designs that name this definition, with their labels */
  designs: { id: string; label: string }[];
  /** other definitions that name it, as `pcbas/PCA-00110-rev4` */
  definitions: string[];
  /** designs + definitions, the number the GUI's caution line shows */
  count: number;
  /**
   * `kind === 'connectors'` only: how many designs
   * mount it board-straddle (a PCB forced between the solder-cup rows) vs
   * direct-solder (wires on the cups) — `connectorMountingUsage`. Absent for
   * every other kind.
   */
  mounting?: { straddle: number; direct: number };
}

/**
 * Who is using this definition.
 *
 * Every design is read, because a design references a definition by id and
 * there is no index — the catalog is files, and the honest way to answer "who
 * uses this?" is to look. The edges themselves are `definitionUsage`
 * (`@wirehub/model`), the same function the Library tables' "Used" column
 * counts with, so the two never disagree.
 */
export async function usageOf(deps: DefinitionDeps, kind: DefinitionKind, id: string): Promise<DefinitionUsage> {
  const db = await deps.loadDb();
  const designs = await everyDesign(deps);
  const use = definitionUsage(db, designs, kind, id);
  const mounting = kind !== 'connectors' ? undefined : connectorMountingUsage(db, designs, id);
  return {
    kind,
    id,
    designs: use.designs,
    definitions: use.definitions,
    count: use.designs.length + use.definitions.length,
    ...(mounting === undefined ? {} : { mounting: { straddle: mounting.straddle.length, direct: mounting.direct.length } }),
  };
}

/** "12 designs and 1 board", or "3 designs" — the sentence a refusal opens with. */
function describeUsage(usage: DefinitionUsage): string {
  const parts: string[] = [];
  if (usage.designs.length > 0) {
    parts.push(`${usage.designs.length} design${usage.designs.length === 1 ? '' : 's'}`);
  }
  if (usage.definitions.length > 0) {
    parts.push(`${usage.definitions.length} other definition${usage.definitions.length === 1 ? '' : 's'}`);
  }
  return parts.join(' and ');
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

function noStore(): ApiResponse {
  return fail(
    501,
    'This studio is not set up to edit the parts library.',
    'Designs can still be opened and saved. Definition editing needs a host that stores the catalog files — the studio dev server does.',
  );
}

function notFound(kind: DefinitionKind, id: string): ApiResponse {
  return fail(
    404,
    `There is no ${KIND_NOUN[kind]} called '${id}'.`,
    `Pick one from the ${KIND_PLURAL[kind]} list, or add a new one.`,
  );
}

function badKind(value: string): ApiResponse {
  return fail(
    404,
    `'${value}' is not a part of the library this studio edits.`,
    `The editable parts are: ${DEFINITION_KINDS.join(', ')}. Generated boards (pcbas.generated.json) come from the importer and are rewritten by it.`,
  );
}

/** The pack a record came from, when it came from one: `packs.json` lists what each pack added. */
export async function packOriginOf(deps: DefinitionDeps, kind: DefinitionKind, id: string): Promise<{ pack: string; version: string } | undefined> {
  const installed = await deps.installedPacks?.();
  const pack = installed?.packs.find((p) => p.added[`${kind}.json`]?.includes(id) === true);
  return pack === undefined ? undefined : { pack: pack.id, version: pack.version };
}

function readOnlyRecord(kind: DefinitionKind, id: string, origin: { pack: string; version: string }, deleting: boolean): ApiResponse {
  return fail(
    409,
    `'${id}' comes from the ${origin.pack} pack (${origin.version}) and is read-only here.`,
    deleting
      ? `Nothing was deleted. A pack's records go with the pack (Library, Packs, Disable); to keep a changed copy, fork '${id}' first.`
      : `Nothing was changed. Fork it to edit: POST /api/definitions/${kind}/${id}/fork copies it under a new id of your own, and designs move to the copy when you choose.`,
  );
}

async function getIndex(deps: DefinitionDeps, store: DefinitionStore): Promise<ApiResponse> {
  return ok({
    definitions: await Promise.all(
      DEFINITION_KINDS.map(async (kind) => ({
        kind,
        label: KIND_PLURAL[kind],
        count: (await store.list(kind)).length,
      })),
    ),
    generatedPcbas: (await generatedPcbas(deps, store)).length,
  });
}

/** The boards the importer wrote: in the library, not in the editable file. */
async function generatedPcbas(deps: DefinitionDeps, store: DefinitionStore): Promise<PcbaDefinition[]> {
  const curated = new Set((await store.list('pcbas')).map((record) => record.id));
  return (await deps.loadDb()).pcbas.filter((pcba) => !curated.has(pcba.id));
}

async function packOrigins(deps: DefinitionDeps, kind: DefinitionKind, records: readonly DefinitionRecord[]): Promise<Record<string, { pack: string; version: string }>> {
  const out: Record<string, { pack: string; version: string }> = {};
  const installed = await deps.installedPacks?.();
  for (const pack of installed?.packs ?? []) {
    const ids = pack.added[`${kind}.json`];
    if (ids === undefined) continue;
    for (const record of records) if (ids.includes(record.id)) out[record.id] = { pack: pack.id, version: pack.version };
  }
  return out;
}

async function getKind(deps: DefinitionDeps, store: DefinitionStore, kind: DefinitionKind): Promise<ApiResponse> {
  return ok({
    kind,
    records: await store.list(kind),
    // each record's version, so an editor opened from this list can quote it
    // as If-Match on save (the guard is required — etag.ts)
    etags: Object.fromEntries((await store.list(kind)).map((record) => [record.id, contentETag(record)])),
    // records that came from an installed pack are read-only: id → { pack, version } (fork to edit)
    packs: await packOrigins(deps, kind, await store.list(kind)),
    // read-only company for the curated boards: the GUI lists them, greyed,
    // rather than pretending the library only holds what it can edit
    ...(kind === 'pcbas' ? { generated: await generatedPcbas(deps, store) } : {}),
  });
}

async function getDefinition(deps: DefinitionDeps, store: DefinitionStore, kind: DefinitionKind, id: string): Promise<ApiResponse> {
  const record = (await store.list(kind)).find((candidate) => candidate.id === id);
  if (record === undefined) return notFound(kind, id);
  const origin = await packOriginOf(deps, kind, id);
  return ok(record, 200, { ETag: contentETag(record), ...(origin === undefined ? {} : { 'X-WireHub-Pack': `${origin.pack}@${origin.version}` }) });
}

async function getUsage(deps: DefinitionDeps, kind: DefinitionKind, id: string): Promise<ApiResponse> {
  return ok(await usageOf(deps, kind, id));
}

/**
 * Validate-then-write. The id in the path is the one that counts.
 *
 * Stale-write guard ( absorbing): a
 * caller that sends `If-Match` is asking "is this still the version I loaded?"
 * — checked against the record as it stands on disk right now, before the
 * (expensive) whole-library validation runs. A caller that sends nothing is
 * refused with 428.
 */
async function putDefinition(
  deps: DefinitionDeps,
  store: DefinitionStore,
  kind: DefinitionKind,
  id: string,
  body: unknown,
  ifMatch: string | undefined,
): Promise<ApiResponse> {
  const parsed = readDefinitionBody(kind, body);
  if (!parsed.ok) return parsed.response;
  if (parsed.record.id !== id) {
    return fail(
      400,
      `This save is for '${id}', but the record says its id is '${parsed.record.id}'.`,
      `A ${KIND_NOUN[kind]}'s id is what every design refers to it by, so saving cannot change it. Add a new ${KIND_NOUN[kind]} instead.`,
    );
  }
  const stored = await store.list(kind);
  const index = stored.findIndex((record) => record.id === id);
  if (index === -1) return notFound(kind, id);
  const origin = await packOriginOf(deps, kind, id);
  if (origin !== undefined) return readOnlyRecord(kind, id, origin, false);
  const current = stored[index];
  if (current !== undefined) {
    const guard = checkIfMatch(ifMatch, contentETag(current), KIND_NOUN[kind], id);
    if (guard !== undefined) return guard;
  }

  // file order is preserved: the edited record stays exactly where it was
  const next = stored.map((record, at) => (at === index ? parsed.record : record));
  const designs = await everyDesign(deps);
  const db = await deps.loadDb();
  const scheme = await partNumberSchemeOf(deps);
  // a scheme that never changes an existing number: the number on the record stays what it was
  const numberField = kind === 'kits' ? 'sku' : 'partNumber';
  const pnOf = (r: unknown): string | undefined => {
    const v = (r as Record<string, unknown> | undefined)?.[numberField];
    return typeof v === 'string' ? v : undefined;
  };
  const changed = refuseChangedNumber(scheme, `This ${KIND_NOUN[kind]}`, pnOf(parsed.record), pnOf(current));
  if (changed !== undefined) return changed;
  const rejection = await validatedLibrary(
    candidateDb(db, kind, next, stored),
    db,
    designs,
    `this ${KIND_NOUN[kind]}`,
    scheme,
    true,
  );
  if (rejection !== undefined) return rejection;

  await store.write(kind, next);
  return ok(parsed.record, 200, { ETag: contentETag(parsed.record) });
}

/** The kinds a design instantiates by id — one id space between them (`validateDb` duplicate-id). */
const PART_KINDS: readonly DefinitionKind[] = ['connectors', 'components', 'wires', 'pcbas', 'mechanicals'];

/** The records a new id must not collide with: the parts share one space; bodies, pinouts and kits each have their own. */
function namespaceOf(db: Db, kind: DefinitionKind): { id: string }[] {
  if (PART_KINDS.includes(kind)) return [...db.connectors, ...db.components, ...db.wires, ...db.pcbas, ...(db.mechanicals ?? [])];
  if (kind === 'bodies') return db.bodies ?? [];
  if (kind === 'interfaces') return db.interfaces ?? [];
  return db.kits ?? [];
}

async function postDefinition(
  deps: DefinitionDeps,
  store: DefinitionStore,
  kind: DefinitionKind,
  body: unknown,
): Promise<ApiResponse> {
  const parsed = readDefinitionBody(kind, body);
  if (!parsed.ok) return parsed.response;
  const id = parsed.record.id;

  const db = await deps.loadDb();
  const taken =
    (await store.list(kind)).some((record) => record.id === id) ||
    namespaceOf(db, kind).some((record) => record.id === id);
  if (taken) {
    return fail(
      409,
      `Something in the library is already called '${id}'.`,
      PART_KINDS.includes(kind)
        ? 'Ids are shared across the whole library, so a connector and a wire stock cannot both use one. Choose a different id.'
        : `Every ${KIND_NOUN[kind]} needs its own id. Choose a different one.`,
    );
  }

  const stored = await store.list(kind);
  // new records land at the end: the file's order is the order the library grew
  const next = [...stored, parsed.record];
  const rejection = await validatedLibrary(
    candidateDb(db, kind, next, stored),
    db,
    await everyDesign(deps),
    `this ${KIND_NOUN[kind]}`,
    await partNumberSchemeOf(deps),
    true,
  );
  if (rejection !== undefined) return rejection;

  await store.write(kind, next);
  return ok(parsed.record, 201, { ETag: contentETag(parsed.record) });
}

/**
 * Fork a pack record to edit: a copy under a new id, remembering where it came
 * from (`derivedFrom`). Only a pack's records are forked; a record of the
 * deployment's own is edited in place. Designs keep the pack record until
 * someone moves them to the copy.
 */
async function forkDefinition(
  deps: DefinitionDeps,
  store: DefinitionStore,
  kind: DefinitionKind,
  id: string,
  body: unknown,
): Promise<ApiResponse> {
  const source = (await store.list(kind)).find((record) => record.id === id);
  if (source === undefined) return notFound(kind, id);
  const origin = await packOriginOf(deps, kind, id);
  if (origin === undefined) {
    return fail(409, `'${id}' is not from a pack, so there is nothing to fork.`, `Edit this ${KIND_NOUN[kind]} directly.`);
  }
  const asked = isObject(body) ? body : {};
  const newId = asked['id'] === undefined ? `${id}-local` : asked['id'];
  if (!isDefinitionId(newId)) {
    return fail(400, `${JSON.stringify(String(newId))} cannot be used as a ${KIND_NOUN[kind]} id.`, ID_RULE);
  }
  if (asked['label'] !== undefined && !isFilledString(asked['label'])) {
    return fail(400, 'The copy needs a name.', 'Give it a label, or leave the label out to keep the original name with "(copy)" after it.');
  }
  const label = asked['label'] ?? `${source.label} (copy)`;
  const copy = { ...source, id: newId, label, derivedFrom: { pack: origin.pack, id, version: origin.version } };
  return postDefinition(deps, store, kind, copy);
}

/**
 * Rule 3 and rule 4 together.
 *
 * The confirm token stops a stray or replayed call; the referential check stops
 * a deliberate one that would leave designs pointing at nothing. `bd
 *` is this handler: the refusal names the referrers so the
 * user can go and change them, rather than being told "no" and left there.
 */
async function deleteDefinition(
  deps: DefinitionDeps,
  store: DefinitionStore,
  kind: DefinitionKind,
  id: string,
  body: unknown,
): Promise<ApiResponse> {
  const stored = await store.list(kind);
  if (!stored.some((record) => record.id === id)) return notFound(kind, id);
  const origin = await packOriginOf(deps, kind, id);
  if (origin !== undefined) return readOnlyRecord(kind, id, origin, true);

  const confirm = isObject(body) ? body['confirm'] : undefined;
  if (confirm !== id) {
    return fail(
      400,
      `Deleting '${id}' has to be confirmed.`,
      `Nothing was deleted. Confirm by sending the ${KIND_NOUN[kind]}'s own id ('${id}') back as the confirmation.`,
    );
  }

  const usage = await usageOf(deps, kind, id);
  if (usage.count > 0) {
    const named = [
      ...usage.designs.map((design) => `${design.id} (${design.label})`),
      ...usage.definitions,
    ];
    const shown = named.slice(0, 10);
    const rest = named.length - shown.length;
    return fail(
      409,
      `'${id}' is still used by ${describeUsage(usage)}, so it was not deleted.`,
      `Change ${usage.count === 1 ? 'it' : 'them'} to use something else first, then delete this ${KIND_NOUN[kind]}: ${shown.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`,
    );
  }

  const next = stored.filter((record) => record.id !== id);
  const db = await deps.loadDb();
  const rejection = await validatedLibrary(
    candidateDb(db, kind, next, stored),
    db,
    await everyDesign(deps),
    `this ${KIND_NOUN[kind]}`,
  );
  if (rejection !== undefined) return rejection;

  await store.write(kind, next);
  return ok({ deleted: id, kind });
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

function methodNotAllowed(method: string, allowed: string[]): ApiResponse {
  return fail(
    405,
    `${method} is not something this address accepts.`,
    `It answers ${allowed.join(' and ')}.`,
  );
}

/**
 * Everything under `/api/definitions`. `parts` is the path split on `/` with
 * the empties dropped and each segment decoded — `['api', 'definitions',
 * 'connectors', 'scart-male']`.
 *
 * Answers `undefined` for a path that is not this module's, so `api.ts` can
 * offer it every request and carry on with its own routing when it is not.
 */
export async function handleDefinitionRequest(
  method: string,
  parts: string[],
  body: unknown,
  deps: DefinitionDeps,
  ifMatch?: string,
): Promise<ApiResponse | undefined> {
  if (parts[0] !== 'api' || parts[1] !== 'definitions') return undefined;
  const [, , kind, id, action, ...rest] = parts;
  if (rest.length > 0) return undefined;

  const store = deps.definitions;
  if (store === undefined) return noStore();

  if (kind === undefined) {
    return method === 'GET' ? await getIndex(deps, store) : methodNotAllowed(method, ['GET']);
  }
  if (!isDefinitionKind(kind)) return badKind(kind);

  if (id === undefined) {
    if (method === 'GET') return await getKind(deps, store, kind);
    if (method === 'POST') return await postDefinition(deps, store, kind, body);
    return methodNotAllowed(method, ['GET', 'POST']);
  }
  // the id is checked before anything looks it up, exactly as a design id is
  if (!isDefinitionId(id)) {
    return fail(400, `${JSON.stringify(id)} cannot be used as a ${KIND_NOUN[kind]} id.`, ID_RULE);
  }

  if (action === undefined) {
    if (method === 'GET') return await getDefinition(deps, store, kind, id);
    if (method === 'PUT') return await putDefinition(deps, store, kind, id, body, ifMatch);
    if (method === 'DELETE') return await deleteDefinition(deps, store, kind, id, body);
    return methodNotAllowed(method, ['GET', 'PUT', 'DELETE']);
  }
  if (action === 'usage') {
    return method === 'GET' ? await getUsage(deps, kind, id) : methodNotAllowed(method, ['GET']);
  }
  if (action === 'fork') {
    return method === 'POST' ? await forkDefinition(deps, store, kind, id, body) : methodNotAllowed(method, ['POST']);
  }
  return undefined;
}
