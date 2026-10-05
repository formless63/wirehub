/**
 * The wire builder's state changes, as pure functions of a `WireRecipe`.
 * The panel (`panels/WireBuilder.tsx`) only wires
 * these to controls, so every rule — what a ring swap does, how an
 * arrangement change re-seats the cores, what "duplicate" keeps — is
 * testable without a DOM.
 */

import {
  LAY_ARRANGEMENT_RING_COUNT,
  compileWire,
  suggestBondedSets,
  type CompiledWire,
  type RecipeLay,
  type WireLayOrder,
  type WireLibrary,
  type WirePart,
  type WirePartKind,
  type WireRecipe,
  type StripPractice,
  type Vocab,
  type VocabEntry,
} from '@wirehub/model';

import type { Outcome } from './persistence.ts';

/** How the host keeps the parts library and the recipes. */
export interface WireLibraryAdapter {
  load(): Promise<Outcome<WireLibrary>>;
  addPart(part: WirePart): Promise<Outcome<WirePart>>;
  /** compile + validate + write the recipe and its stock; `create` for a new stock */
  saveStock(recipe: WireRecipe, create: boolean): Promise<Outcome<{ recipe: WireRecipe }>>;
  /** the bench's strip steps per construction — the 3D view's presets */
  practice?(): Promise<Outcome<StripPractice[]>>;
}

/** An in-memory adapter — tests and hosts with no server. */
export function memoryWireLibraryAdapter(initial: WireLibrary, practice: readonly StripPractice[] = []): WireLibraryAdapter & { current(): WireLibrary } {
  let library = structuredClone(initial);
  return {
    current: () => library,
    practice: async () => ({ ok: true, value: structuredClone([...practice]) }),
    load: async () => ({ ok: true, value: structuredClone(library) }),
    addPart: async (part) => {
      if (library.parts.some((p) => p.id === part.id)) return { ok: false, message: `'${part.id}' is already in the library.` };
      library = { ...library, parts: [...library.parts, part] };
      return { ok: true, value: part };
    },
    saveStock: async (recipe, create) => {
      const exists = library.recipes.some((r) => r.id === recipe.id);
      if (create && exists) return { ok: false, message: `'${recipe.id}' already exists.` };
      library = {
        ...library,
        recipes: exists ? library.recipes.map((r) => (r.id === recipe.id ? recipe : r)) : [...library.recipes, recipe],
      };
      return { ok: true, value: { recipe } };
    },
  };
}

export function partsOfKind<K extends WirePartKind>(parts: readonly WirePart[], kind: K): Extract<WirePart, { kind: K }>[] {
  return parts.filter((part): part is Extract<WirePart, { kind: K }> => part.kind === kind);
}

/** The words the signal picker offers: the vocabulary's signal labels, then whatever the recipe already says. */
export function signalChoices(recipe: WireRecipe, vocab?: Vocab): string[] {
  const words = ((vocab?.['signals']?.entries ?? []) as VocabEntry[])
    .filter((e) => e.pending !== true && e.deprecatedBy === undefined)
    .map((e) => e.label);
  for (const core of recipe.cores) if (core.signal !== undefined && !words.includes(core.signal)) words.push(core.signal);
  return words;
}

export function compileRecipe(recipe: WireRecipe, library: WireLibrary): CompiledWire {
  return compileWire(recipe, library.parts);
}

/* ------------------------------------------------------------------ *
 * New and duplicate
 * ------------------------------------------------------------------ */

/** The order new cores take colours in when none is chosen. */
const COLOUR_ORDER = ['red', 'green', 'blue', 'yellow', 'white', 'black', 'brown', 'purple', 'orange', 'grey'];

/** A stock with nothing in it yet — "new stock from parts". */
export function blankRecipe(id = 'new-stock'): WireRecipe {
  return { id, label: '', cores: [], src: '' };
}

/**
 * A copy to change (§6.2 "duplicate a recipe and swap parts"): every part and
 * the lay kept; the identity, the part number and the revision history
 * dropped — the copy is a different stock until someone says
 * otherwise.
 */
export function duplicateRecipe(recipe: WireRecipe, id: string, label: string): WireRecipe {
  const copy = structuredClone(recipe);
  delete copy.partNumber;
  delete copy.revisions;
  delete copy.overrides;
  return {
    ...copy,
    id,
    label,
    rootLabel: `${label} cable`,
    src: `Duplicated from ${recipe.id} (${recipe.label}); every part as that stock until changed. ${recipe.src}`,
  };
}

/** The next free core id for a colour: `core-red`, then `core-red-2`. */
function freeCoreId(recipe: WireRecipe, colour: string): string {
  const taken = new Set(recipe.cores.map((core) => core.id));
  let id = `core-${colour}`;
  for (let n = 2; taken.has(id); n += 1) id = `core-${colour}-${n}`;
  return id;
}

/** The first colour the stock does not use yet. */
export function nextColour(recipe: WireRecipe): string {
  const used = new Set(recipe.cores.map((core) => core.colour));
  return COLOUR_ORDER.find((colour) => !used.has(colour)) ?? 'red';
}

export function addCore(recipe: WireRecipe, part: string, colour = nextColour(recipe)): WireRecipe {
  const id = freeCoreId(recipe, colour);
  const next: WireRecipe = { ...recipe, cores: [...recipe.cores, { id, colour, part }] };
  if (next.lay !== undefined) {
    const size = LAY_ARRANGEMENT_RING_COUNT[next.lay.arrangement];
    if (next.lay.ring.length < size) next.lay = { ...next.lay, ring: [...next.lay.ring, id] };
  }
  return next;
}

export function removeCore(recipe: WireRecipe, id: string): WireRecipe {
  const next: WireRecipe = { ...recipe, cores: recipe.cores.filter((core) => core.id !== id) };
  if (next.lay !== undefined) {
    const lay: RecipeLay = { ...next.lay, ring: next.lay.ring.filter((m) => m !== id) };
    if (lay.center === id) delete lay.center;
    if (lay.inner !== undefined) lay.inner = lay.inner.filter((m) => m !== id);
    next.lay = lay;
  }
  if (next.bonded !== undefined) {
    next.bonded = next.bonded
      .map((set) => ({ ...set, members: set.members.filter((m) => m !== id && !m.startsWith(`${id}.`)) }))
      .filter((set) => set.members.length > 1);
  }
  return next;
}

/** Change a core's colour, and its id with it when the id was the colour's. */
export function recolourCore(recipe: WireRecipe, id: string, colour: string): WireRecipe {
  const core = recipe.cores.find((c) => c.id === id);
  if (core === undefined) return recipe;
  const renamed = id === `core-${core.colour}` ? freeCoreId({ ...recipe, cores: recipe.cores.filter((c) => c.id !== id) }, colour) : id;
  return renameCore({ ...recipe, cores: recipe.cores.map((c) => (c.id === id ? { ...c, colour } : c)) }, id, renamed);
}

function renameCore(recipe: WireRecipe, from: string, to: string): WireRecipe {
  if (from === to) return recipe;
  const swap = (m: string): string => (m === from ? to : m.startsWith(`${from}.`) ? `${to}${m.slice(from.length)}` : m);
  const next: WireRecipe = { ...recipe, cores: recipe.cores.map((c) => (c.id === from ? { ...c, id: to } : c)) };
  if (next.lay !== undefined) {
    next.lay = {
      ...next.lay,
      ring: next.lay.ring.map(swap),
      ...(next.lay.center === undefined ? {} : { center: swap(next.lay.center) }),
      ...(next.lay.inner === undefined ? {} : { inner: next.lay.inner.map(swap) }),
    };
  }
  if (next.bonded !== undefined) next.bonded = next.bonded.map((set) => ({ ...set, members: set.members.map(swap) }));
  return next;
}

/** "Apply to all cores": every core built from one assembly. */
export function applyPartToAll(recipe: WireRecipe, part: string): WireRecipe {
  return { ...recipe, cores: recipe.cores.map((core) => ({ ...core, part })) };
}

/* ------------------------------------------------------------------ *
 * The lay
 * ------------------------------------------------------------------ */

/** A lay for the current cores: the first `n` on the ring, the rest inside. */
export function layFor(recipe: WireRecipe, arrangement: WireLayOrder['arrangement']): RecipeLay {
  const previous = recipe.lay;
  const size = LAY_ARRANGEMENT_RING_COUNT[arrangement];
  const order = [
    ...(previous?.ring ?? []),
    ...(previous?.center === undefined ? [] : [previous.center]),
    ...(previous?.inner ?? []),
    ...recipe.cores.map((core) => core.id),
  ].filter((id, index, all) => all.indexOf(id) === index && recipe.cores.some((core) => core.id === id));
  const ring = order.slice(0, size);
  const rest = order.slice(size);
  const lay: RecipeLay = {
    arrangement,
    direction: previous?.direction ?? 'ccw',
    ring,
    src: previous?.src ?? '',
    ...(previous?.viewedFrom === undefined ? {} : { viewedFrom: previous.viewedFrom }),
    ...(previous?.layLengthMm === undefined ? {} : { layLengthMm: previous.layLengthMm }),
    ...(previous?.layLengthTolMm === undefined ? {} : { layLengthTolMm: previous.layLengthTolMm }),
    ...(previous?.hand === undefined ? {} : { hand: previous.hand }),
  };
  if (arrangement === '6-around-2') lay.inner = rest.slice(0, 2);
  else if (arrangement !== 'pair' && arrangement !== 'figure-8' && rest[0] !== undefined) lay.center = rest[0];
  return lay;
}

/**
 * Change the arrangement, and what goes with it: a figure-8 (two jacketed
 * legs moulded together) has a web and no overall
 * jacket; leaving figure-8 drops the web.
 */
export function withArrangement(recipe: WireRecipe, arrangement: WireLayOrder['arrangement'] | undefined): WireRecipe {
  const next: WireRecipe = { ...recipe };
  if (arrangement === undefined) delete next.lay;
  else next.lay = layFor(recipe, arrangement);
  if (arrangement === 'figure-8') {
    next.web = recipe.web ?? { material: 'PVC', color: 'black', src: '' };
    delete next.jacket;
  } else {
    delete next.web;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * The manufacturer's own documents
 * ------------------------------------------------------------------ */

/** A file in the host's shared asset store, as the vendor-documents picker lists it. */
export interface VendorDocument {
  /** sha256 of the bytes */
  id: string;
  mime: string;
  originalName: string;
  src: string;
  bytes: number;
}

/** How the host lists the shared asset store's files and opens one in-app. */
export interface VendorDocumentsAdapter {
  list(): Promise<Outcome<VendorDocument[]>>;
  /** where the file opens (a URL the browser can show) */
  href(id: string): string;
}

/** Link a stored file as one of the manufacturer's documents (once). */
export function addVendorDoc(recipe: WireRecipe, doc: VendorDocument): WireRecipe {
  const docs = recipe.vendorDocs ?? [];
  if (docs.some((d) => d.asset === doc.id)) return recipe;
  const label = doc.originalName.replace(/\.[a-z0-9]+$/i, '');
  return { ...recipe, vendorDocs: [...docs, { asset: doc.id, label, src: doc.src }] };
}

export function removeVendorDoc(recipe: WireRecipe, asset: string): WireRecipe {
  const docs = (recipe.vendorDocs ?? []).filter((d) => d.asset !== asset);
  const next: WireRecipe = { ...recipe, vendorDocs: docs };
  if (docs.length === 0) delete next.vendorDocs;
  return next;
}

/** Where a core sits in the lay: `ring:3`, `center`, `inner:0`, or nowhere. */
export type LaySlot = { at: 'ring'; index: number } | { at: 'center' } | { at: 'inner'; index: number };

export function slotOf(lay: RecipeLay, id: string): LaySlot | undefined {
  const ring = lay.ring.indexOf(id);
  if (ring >= 0) return { at: 'ring', index: ring };
  if (lay.center === id) return { at: 'center' };
  const inner = lay.inner?.indexOf(id) ?? -1;
  return inner >= 0 ? { at: 'inner', index: inner } : undefined;
}

function put(lay: RecipeLay, slot: LaySlot, id: string): RecipeLay {
  if (slot.at === 'ring') return { ...lay, ring: lay.ring.map((m, i) => (i === slot.index ? id : m)) };
  if (slot.at === 'center') return { ...lay, center: id };
  return { ...lay, inner: (lay.inner ?? []).map((m, i) => (i === slot.index ? id : m)) };
}

/** Drag one core onto another: they trade places (ring, centre or centre pair). */
export function swapInLay(lay: RecipeLay, a: string, b: string): RecipeLay {
  if (a === b) return lay;
  const sa = slotOf(lay, a);
  const sb = slotOf(lay, b);
  if (sa === undefined || sb === undefined) return lay;
  return put(put(lay, sa, b), sb, a);
}

/** Keyboard: step a ring core one position along the ring (wrapping). */
export function stepInRing(lay: RecipeLay, id: string, by: 1 | -1): RecipeLay {
  const at = lay.ring.indexOf(id);
  if (at < 0) return lay;
  const to = (at + by + lay.ring.length) % lay.ring.length;
  return swapInLay(lay, id, lay.ring[to]!);
}

/** The ring as read from the other end: the same cores, the other way round. */
export function otherEndReading(lay: RecipeLay): { end: 'source' | 'destination' | undefined; direction: 'cw' | 'ccw' } {
  return {
    end: lay.viewedFrom === undefined ? undefined : lay.viewedFrom === 'source' ? 'destination' : 'source',
    direction: lay.direction === 'cw' ? 'ccw' : 'cw',
  };
}

/** Re-read the stated ring from the other end (same cable, other end's words). */
export function flipViewedFrom(lay: RecipeLay): RecipeLay {
  const other = otherEndReading(lay);
  return { ...lay, direction: other.direction, ...(other.end === undefined ? {} : { viewedFrom: other.end }) };
}

/* ------------------------------------------------------------------ *
 * Bonding
 * ------------------------------------------------------------------ */

/** What the construction suggests is one copper mass, not yet recorded. */
export function bondingSuggestions(recipe: WireRecipe, compiled: CompiledWire): string[][] {
  const recorded = (recipe.bonded ?? []).map((set) => [...set.members].sort().join('|'));
  return suggestBondedSets(compiled.wire).filter((set) => !recorded.includes([...set].sort().join('|')));
}

/** The recipe with problems a save would refuse, as sentences — the save button's gate. */
export function recipeProblems(recipe: WireRecipe, compiled: CompiledWire, create: boolean, takenIds: readonly string[]): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipe.id)) problems.push('The id has to be lowercase words joined by hyphens.');
  if (create && takenIds.includes(recipe.id)) problems.push(`Something in the library is already called '${recipe.id}'.`);
  if (recipe.label.trim() === '') problems.push('Give the stock a name.');
  if (recipe.src.trim() === '') problems.push('Say where the stock comes from (the vendor sheet, or “inferred”).');
  if (recipe.cores.length === 0) problems.push('Add at least one core.');
  if (recipe.lay !== undefined && recipe.lay.src.trim() === '') problems.push('Cite where the lay order comes from.');
  if (recipe.lay?.arrangement === 'figure-8' && (recipe.web === undefined || recipe.web.src.trim() === '')) {
    problems.push('Cite where the figure-8 web comes from (the sheet, a measurement, or “inferred”).');
  }
  for (const issue of compiled.issues) if (issue.severity === 'error') problems.push(issue.message);
  return problems;
}
