/**
 * Canonical domain model for WireHub.
 *
 * Everything here is plain JSON-serialisable data: no classes, no Maps, no
 * presentation concerns (SVG, coordinates, React Flow, database ids). Every
 * downstream artifact — schematic, build sheet, BOM, continuity spec — derives
 * from these types.
 */

import type { SignalRef, SignalTags, Vocab } from './vocab.ts';
import type { ConnectorBody, Interface } from './interfaces.ts';
import type { DbRules, DesignElectrical } from './electrical.ts';
import type { ValidationRule } from './rules.ts';
import type { BenchStepRule } from './bench-types.ts';
import type { KitDefinition } from './kits.ts';
import type { RecordMeta } from './provenance.ts';
import type { CavityAssignment, HousingSpec, TerminationSpec } from './crimp.ts';
import type { AssemblyLibrary } from './subassemblies.ts';
import type { ConditioningRecipe, DeviceProfile, HazardRule, ResolverPolicy } from './devices.ts';
import type { CableRecipe } from './cable-recipe.ts';
import type { PartRoute, PartSupplier, ProductFamily } from './products.ts';

/* ------------------------------------------------------------------ *
 * Wire structure — hierarchical elements
 * ------------------------------------------------------------------ */

/** A single solid/stranded conductor. Electrical: it has terminals. */
export interface ConductorElement {
  kind: 'conductor';
  id: string;
  label?: string;
  color?: string;
  material?: string;
  /** e.g. "OFC 7x0.12 mm" */
  formation?: string;
  areaMm2?: number;
  /** the stock's own rated current in amps (a datasheet figure); wins over the area table of the electrical rules */
  ratedCurrentA?: number;
  /** DC resistance of the conductor, ohm per km at 20 C (a datasheet figure); else derived from material and area */
  resistanceOhmPerKm?: number;
  /** outer diameter over the bare copper, mm */
  odMm?: number;
  /**
   * Outer diameter over this conductor's own insulation, mm — for conductors
   * whose insulation is deliberately not modelled as a separate element (the
   * mini-coax `core-brown`, whose terminal path must stay `core-brown`).
   */
  insulatedOdMm?: number;
  /** bare = true for drain wires */
  bare?: boolean;
  /**
   * The lane this conductor carries (vocab `lanes`), when it differs from
   * what the stock's `colourCode` says for its `color` (data model v2 §6.1
   * "lane override"). Usually absent.
   */
  lane?: string;
  src?: string;
}

/** A shield (braid/spiral/foil/tape). Electrical: it has terminals. */
export interface ShieldElement {
  kind: 'shield';
  id: string;
  label?: string;
  construction: 'braid' | 'spiral' | 'foil' | 'tape';
  material?: string;
  coveragePct?: string;
  /** outer diameter over the shield, mm */
  odMm?: number;
  src?: string;
}

/** Dielectric / sheath / jacket. Not electrical — no terminals. */
export interface InsulationElement {
  kind: 'insulation';
  id: string;
  label?: string;
  material?: string;
  odMm?: number;
  color?: string;
  src?: string;
}

/** A structural grouping (a coax, a shielded core, the whole cable). */
export interface GroupElement {
  kind: 'group';
  id: string;
  label?: string;
  role: 'coax' | 'shielded-core' | 'twisted-pair' | 'bundle' | 'cable';
  children: Element[];
  src?: string;
}

export type Element =
  | ConductorElement
  | ShieldElement
  | InsulationElement
  | GroupElement;

/** Elements that carry terminals. */
export type ElectricalElement = ConductorElement | ShieldElement;

/**
 * The order the cores are laid in, read off the cut face of the cable.
 *
 * This is a **physical fact of the stock**, not a drawing choice: KTL 0112 and
 * 0113 both print "Adhere to color order shown" next to their cross-section,
 * and a cable laid up in a different order is a different cable. Anything that
 * draws or inspects a cross-section reads it from here.
 *
 * Members are element paths (`core-red`), resolved against the wire's
 * `structure` exactly like a terminal path.
 */
export interface WireLayOrder {
  /**
   * the finished lay: `6-around-1` = six cores around one centre core,
   * `7-around-1` = seven around one, `6-around-2` = six around a centre pair
   * (see `inner`), `pair` = two cores side by side, ring of 2 — a small lead
   * with no centre/interstitial position at all.
   *
   * `pair` covers both a lead whose two cores are individually shielded (the
   * 2×RCA audio lead — each ring member is its own `shielded-core` group) and
   * one whose two bare conductors share a single overall shield (the TRS
   * audio leads — `viewedFrom`/`direction` describe the same two-up ring
   * either way). Whether a core carries its own shield is already a fact of
   * the element tree (does the ring member's group have a `shield` child?);
   * the lay order only records which two elements sit side by side and how
   * they read, so one arrangement value is enough for both constructions —
   * a second `pair-in-shield` value would duplicate information the
   * structure already carries.
   *
   * `figure-8` (siamese / zip cord) = two separately jacketed legs moulded
   * side by side, joined by a web (the 2×RCA lead). Ring of
   * 2, laid **left then right** looking into the `viewedFrom` face — the
   * cross-section is two joined circles, not one round jacket; its overall
   * width and height live in `WireDefinition.profile`.
   */
  arrangement: '6-around-1' | '7-around-1' | '6-around-2' | 'pair' | 'figure-8';
  /** the direction `ring` is read in, looking into the cut face */
  direction: 'ccw' | 'cw';
  /**
   * which end's cut face `direction` describes. The other end reads the same
   * ring in the opposite direction. Omitted = not established.
   */
  viewedFrom?: 'source' | 'destination';
  /** the cores on the pitch circle, in lay order */
  ring: string[];
  /** the core on the cable axis, when the lay has one */
  center?: string;
  /**
   * cores laid inside the ring that are not a single axial core — the
   * `6-around-2` centre pair, listed left to right looking into the cut face
   */
  inner?: string[];
  src: string;
}

/** How many ring cores each arrangement requires. */
export const LAY_ARRANGEMENT_RING_COUNT: Readonly<
  Record<WireLayOrder['arrangement'], number>
> = { '6-around-1': 6, '7-around-1': 7, '6-around-2': 6, pair: 2, 'figure-8': 2 };

/**
 * The outline of a stock that is not one round jacket.
 * Today only `figure-8`: two legs of Ø `legOdMm` whose centres are `pitchMm`
 * apart, joined by a web `webMm` thick. `widthMm` = pitch + leg Ø, `heightMm`
 * = leg Ø. `WireDefinition.odMm` carries the **larger** dimension (the width),
 * so every reader of a single Ø (a shell or strain-relief fit, a drawing's
 * scale) errs on the safe side.
 */
export interface WireProfile {
  shape: 'figure-8';
  widthMm: number;
  heightMm: number;
  legOdMm: number;
  pitchMm: number;
  webMm: number;
  src: string;
}

/**
 * One of the manufacturer's own documents for a stock — a datasheet or
 * drawing held in the shared asset store (`data/assets/`, by sha256), so it
 * opens in-app. A citation, never our document number.
 */
export interface WireVendorDoc {
  /** the asset id (sha256 of the bytes) */
  asset: string;
  /** what it is, in words ("the vendor C146 technical datasheet") */
  label: string;
  src: string;
}

/**
 * A wire stock definition. Lengths live on design instances, never here.
 * `structure` is the root group (role `cable` for real stocks).
 */
export interface WireDefinition extends RecordMeta {
  id: string;
  label: string;
  partNumber?: string;
  /**
   * the document the stock's values were taken from (a citation only — our
   * own spec sheet is the WireHub Standard numbered by the part number)
   */
  specRef?: string;
  /** who makes it — an id in the `manufacturers` vocab list; absent = not known */
  manufacturer?: string;
  /** the manufacturer's own documents, held in the shared asset store */
  vendorDocs?: WireVendorDoc[];
  structure: GroupElement;
  /** Ø over the jacket; for a non-round stock the larger dimension (see `profile`) */
  odMm?: number;
  /** the outline when the stock is not one round jacket (`figure-8`) */
  profile?: WireProfile;
  layOrder?: WireLayOrder;
  /**
   * Screens that are **one copper mass** for the whole length of the stock —
   * a physical fact of how it is made, not of how a design lands it. Every
   * bonded multi-core spiral shield, its foil and its drain touch along the cable;
   * a mini-coax drain lies on the overall foil. A screen is in at most one set.
   */
  bonded?: WireBondedSet[];
  /**
   * The colour code its conductors follow (vocab `colour-codes`: `rca-audio`
   * white→audio-l, red→audio-r), which is where each core's lane comes from.
   */
  colourCode?: string;
  src: string;
}

/**
 * A set of screens (shields, and bare conductors such as a drain) that are in
 * contact for the whole length of the stock — one copper mass.
 */
export interface WireBondedSet {
  /** screen paths, resolved against the stock's `structure` */
  members: string[];
  src: string;
}

/* ------------------------------------------------------------------ *
 * Connectors
 * ------------------------------------------------------------------ */

export interface ConnectorPin {
  id: string;
  label: string;
  aliases?: string[];
  note?: string;
  /**
   * What the pin carries, as a vocab `signals` id (data model v2 §2.1) — or
   * `{ oneOf }` when the device decides (SCART 20 takes CVBS, CSync or luma).
   * Optional: when absent, `signalOf` falls back to the catalog's tag table
   * (`Db.tags`) and then to reading the label.
   */
  signal?: SignalRef;
  /** the current this pin carries in use, amps; wins over its signal's default (electrical rules) */
  currentA?: number;
}

/**
 * A connector's or body's gender: an id in the `genders` vocab list. Open
 * (list entries may be added in-app, not
 * only by editing code): `male` and `female` are the built-ins, and an entry
 * added to the list in the Library is just as valid.
 */
export type ConnectorGender = 'male' | 'female' | (string & {});

/**
 * A discrete component's kind: an id in the `component-kinds` vocab list.
 * Open like `ConnectorGender`: the built-in kinds keep
 * their terminal presets, a kind added in-app starts from a generic
 * two-terminal one.
 */
export type ComponentKind = 'resistor' | 'capacitor' | 'ic' | 'switch' | 'other' | (string & {});

export interface ConnectorDefinition extends RecordMeta {
  id: string;
  label: string;
  /** 'SCART' | 'DIN' | 'D-Sub' | 'RCA' | ... */
  family: string;
  gender?: ConnectorGender;
  /**
   * Orderable identity of the connector *itself* — the plug or socket as a
   * stock item (`CMP-00101-00`, `CUI MD-100SM`). Optional, and deliberately so:
   * plenty of real interfaces have no part to buy (a board's own gold-finger
   * edge is not a purchasable connector), and a BOM that says "identity not
   * available" is more honest than one that invents a number.
   */
  partNumber?: string;
  /**
   * How it is terminated — a vocab `connector-constructions` id
   * (`solder-cup`, `pcb-mount-th`, `pcb-mount-smd`, `crimp`, `moulded` …).
   * Two connectors with the same body pinout but a
   * different construction are different parts (a DIN-8 270° PCB-mount plug
   * vs the in-line solder-cup one). Absent when
   * not known; `connectorConstruction` falls back to the body's.
   */
  construction?: string;
  /** each contact's rated current, amps (a datasheet figure); the electrical rules compare it with the pin's net */
  contactRatingA?: number;
  /**
   * Whether the bench terminates this connector at all — a vocab
   * `connector-sourcing` id (`pre-made-lead`;). Absent
   * means the bench solders/crimps it as its `construction` says; a
   * `pre-made-lead` connector is the factory-terminated end of a purchased
   * lead (its own wire-stock instance, e.g. `audio-lead-2rca`) — the BOM
   * lines it up as a purchased part and the build sheet prints no
   * termination step for it (RCA male/female and BNC male are
   * generally or only bought pre-made).
   */
  sourcing?: string;
  /**
   * Earlier display names, kept so a search for one still finds it.
   */
  aliases?: string[];
  /**
   * Composed at load (data model v2 §1.2): the pins of `interface` on `body`.
   * A stored connector that names both carries no `pins` of its own.
   */
  pins: ConnectorPin[];
  src: string;
  /** the physical body (`Db.bodies`) this connector is — shell, positions, gender */
  body?: string;
  /** the pinout (`Db.interfaces`) it carries on that body */
  interface?: string;
  /**
   * A crimp housing's cavities (`crimp.ts`): the contact systems they take,
   * whether each wire is sealed and whether unused cavities are plugged.
   * Absent = not a crimp housing as far as the catalog knows (a solder-cup or
   * PCB connector has none); falls back to the body's.
   */
  housing?: HousingSpec;
}

/* ------------------------------------------------------------------ *
 * Discrete components
 * ------------------------------------------------------------------ */

export interface ComponentTerminal {
  id: string;
  label?: string;
  polarity?: '+' | '-';
}

/**
 * What a component physically is, one step finer than `kind` (which stays an
 * id in the `component-kinds` vocab: a regulator is still an `ic`, a jack or
 * a solder jumper `other`). Set on every record the board import creates
 * and on the hand-soldered records merged into the same
 * scheme; `componentCategory()` falls back to `kind` where it is absent.
 */
export type ComponentCategory =
  | 'resistor'
  | 'capacitor'
  | 'ic'
  | 'regulator'
  | 'jack'
  | 'connector'
  | 'switch'
  | 'jumper'
  | 'diode'
  | 'inductor'
  | 'transistor'
  | 'other';

/** One supplier's order number for a component (`LCSC C25270`). */
export interface ComponentSupplierPart {
  /** `LCSC` (JLCPCB's assembly numbers are LCSC numbers), `Mouser` … */
  supplier: string;
  number: string;
  /** an alternate the board's files name, not the part the fab was told to fit */
  alternate?: boolean;
}

/** Where a component is placed: one board revision and its reference designators. */
export interface ComponentUse {
  /** the bare board's part number, `PCA-00101` */
  board: string;
  /** `Rev6` */
  revision: string;
  /** reference designators, natural order: `["C1", "C2", "C10"]` */
  refs: string[];
}

/**
 * A discrete part: one record per distinct physical part.
 *
 * The **field set** (what a generic Library table/detail shows, in order):
 * `label`, `category`, `value`, `tolerance`, `package`, `mpn`, `manufacturer`,
 * `suppliers`, `partNumber`, `kicadModel`, `usedOn`, `review`, `src`. Only
 * `id`, `label`, `kind`, `terminals` and `src` are required; the rest are
 * absent when no source says them — never guessed.
 *
 * `partNumber` is the part number under the deployment's scheme (`CMP-00102`)
 * and nothing else on records the board import creates (no invented
 * numbers). The five hand-soldered records predate that and keep the supplier
 * string there (`LCSC C25270`) because the cable BOM prints it; their
 * `suppliers` carry the same numbers structured.
 */
export interface ComponentDefinition extends RecordMeta {
  id: string;
  label: string;
  kind: ComponentKind;
  /** "330 Ω", "220 µF", "100 nF"; an IC's printed value (`LM1881M_NOPB`) */
  value?: string;
  /** the part number under the deployment's scheme (`CMP-00103`) */
  partNumber?: string;
  terminals: ComponentTerminal[];
  src: string;
  /** see `ComponentCategory` */
  category?: ComponentCategory;
  /** as the BOM prints it: `1%`, `5%`, `10%` */
  tolerance?: string;
  /** case / package: `0603`, `SOIC-8`, `EIA-3528-21 (Kemet B)`, `SOT-23-5` */
  package?: string;
  /** manufacturer part number: `T491C227K010AT` */
  mpn?: string;
  manufacturer?: string;
  /** supplier order numbers; the first non-alternate is the one the fab fits */
  suppliers?: ComponentSupplierPart[];
  /** the KiCad footprint (library id) the boards place it with */
  footprint?: string;
  /**
   * The 3D model the footprint references, exactly as the board file has it
   * (`${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step`,
   * `kicad-embed://PJ311D_WPos.STEP`). A reference only: `data/models.json`
   * (the model import) decides what the Library renders.
   */
  kicadModel?: string;
  /** every board revision that places it (the board import keeps this; `data/board-parts.json` has the per-ref detail) */
  usedOn?: ComponentUse[];
  /** set on a record the board import created — `imported from PCA-00101 Rev6 — review` — until a person has checked it */
  review?: string;
}

/* ------------------------------------------------------------------ *
 * PCBAs — black boxes with declared continuity
 * ------------------------------------------------------------------ */

export interface PcbaTerminal {
  id: string;
  label?: string;
  note?: string;
  /**
   * The physical pads behind this terminal, when known. One logical `GND`
   * terminal is often several copper pads (GND1 top, GND2 bottom, GND4 shell
   * landing) on one net; a landing may name the pad it goes to
   * (`TerminalRef.pad`) without changing any net.
   */
  pads?: PcbaPad[];
  /** Which pad this is for the cable (vocab `pad-roles`: `video-r`, `sync`, `power`, `gnd` …). */
  role?: string;
  /** What the pad carries, as a vocab `signals` id, where the board says more than its role. */
  signal?: SignalRef;
}

/** One physical copper pad behind a PCBA terminal. */
export interface PcbaPad {
  /** footprint reference, as silkscreened: `GND2`, `H9` */
  ref: string;
  /** board face the pad is on; `both` = a plated through-hole landing */
  side?: 'top' | 'bottom' | 'both';
  /** `shell` = the connector-shell landing, not a wire landing */
  role?: 'shell';
  /**
   * Where the pad sits, in millimetres in its board depiction's anchor frame
   * (both faces share it). Used to pick, of several pads on one face, the one
   * nearest a group of signal pads.
   */
  x?: number;
  y?: number;
  note?: string;
}

/**
 * A PCBA sold pre-soldered to its connector exposes that connector's mating
 * pins as terminals with ids '<prefix>.<pin>' (e.g. 'scart.15').
 */
export interface IntegratedConnector {
  connectorDefId: string;
  terminalPrefix: string;
}

/** What kind of part sits in a board link's path. */
export type PcbaLinkElementKind = 'resistor' | 'capacitor' | 'inductor' | 'ic' | 'jumper' | 'switch' | 'other';

/**
 * One part in a board link's path: `C201`, a capacitor,
 * `0.1 µF`. `text` is its verbatim slice of the link's `via`, so the prose is
 * rebuilt exactly (`viaText`).
 */
export interface PcbaLinkElement {
  text: string;
  kind: PcbaLinkElementKind;
  /** reference designator: `C201`, `JP1`, `U201` */
  designator?: string;
  /** printed value: `0.1 µF`, `470 Ω` */
  value?: string;
  /** resistance, when the value is one (a bridged jumper is 0) */
  ohms?: number;
  /** a jumper's or switch's state on this build: `bridged`, `CS position`, `build option` */
  state?: string;
}

/**
 * Declared internal continuity. `via` is a human-readable annotation of what
 * sits in the path ("C1 220 µF"); a link with no `via` is plain copper.
 * `elements` is the same path as structure (`linkElements` reads it, falling
 * back to parsing `via` when a definition has none).
 */
export interface PcbaInternalLink {
  from: string;
  to: string;
  via?: string;
  elements?: PcbaLinkElement[];
  note?: string;
}

export interface PcbaDefinition extends RecordMeta {
  id: string;
  label: string;
  partNumber: string;
  revision: string;
  /** 'CPL Basic' etc. */
  build?: string;
  /** reference string only — no parsing in Phase 1 */
  kicadProject?: string;
  terminals: PcbaTerminal[];
  integratedConnectors?: IntegratedConnector[];
  internalLinks: PcbaInternalLink[];
  src: string;
  /**
   * Production status; absent = active. `legacy`: an older revision than the
   * the board files README's released one; `retired`: archived under `_Obsolete`
   * (legacy revisions are imported for reference and hidden unless
   * filtered). Same vocabulary as `DesignStatus`.
   */
  status?: DesignStatus;
}

/* ------------------------------------------------------------------ *
 * Mechanical parts — shells and hardware, no terminals
 * ------------------------------------------------------------------ */

/**
 * A non-electrical physical part: a printed shell/housing, a fastener
 * (screw/nut), or something else mechanical (a strain-relief clip, a
 * thread-forming screw). No terminals — these never appear in a `TerminalRef`,
 * a joint, or a net; they exist purely so the BOM can carry them
 * (the cable BOM covers shells and hardware
 * alongside PCBs/PCBAs and connectors).
 */
/**
 * What a mechanical part is. `shell`, `fastener` and `other` are housings and
 * hardware; `contact` (a crimp terminal), `seal` (a wire or cavity seal) and
 * `plug` (a cavity plug or blind) go into a crimp housing's cavities, and
 * `tool` is the crimp tool or applicator a contact needs — a tool is never a
 * BOM line.
 */
export type MechanicalKind = 'shell' | 'fastener' | 'boot' | 'other' | 'contact' | 'seal' | 'plug' | 'tool';

export const MECHANICAL_KINDS: readonly MechanicalKind[] = ['shell', 'fastener', 'boot', 'other', 'contact', 'seal', 'plug', 'tool'];

export interface MechanicalDefinition extends RecordMeta {
  id: string;
  label: string;
  /** e.g. `SHL-00102-00`, `HW-00101` */
  partNumber?: string;
  /** the released revision this definition tracks, when the source has one */
  revision?: string;
  kind: MechanicalKind;
  /**
   * For a crimp termination part (`kind` `contact`, `seal`, `plug` or
   * `tool`): what it fits and the wire it takes (`crimp.ts`). Absent on
   * shells and hardware.
   */
  termination?: TerminationSpec;
  /**
   * A pre-terminated sub-assembly the contract manufacturer supplies — the
   * "stripped to X" stock: the end it arrives terminated
   * at, and whether the trunk comes with it (cut, the other end stripped). A
   * design that uses one builds only the other end in house.
   */
  supplies?: { end: 'source' | 'destination'; trunk: boolean };
  src: string;
}

/* ------------------------------------------------------------------ *
 * The definition bundle
 * ------------------------------------------------------------------ */

export interface Db {
  connectors: ConnectorDefinition[];
  wires: WireDefinition[];
  components: ComponentDefinition[];
  pcbas: PcbaDefinition[];
  /** shells and hardware; absent/omitted means none */
  mechanicals?: MechanicalDefinition[];
  /** the controlled vocabularies (data model v2 §2.1), keyed by list id */
  vocab?: Vocab;
  /**
   * Signal tags kept beside the definitions (data model v2 task 2): pin
   * signals, pad roles, stock colour codes. A tag written on the record itself
   * (`ConnectorPin.signal`, `PcbaTerminal.role`, `WireDefinition.colourCode`)
   * wins over this table.
   */
  tags?: SignalTags;
  /** connector bodies (data model v2 §1.2); absent means none */
  bodies?: ConnectorBody[];
  /** named pinouts on those bodies (data model v2 §1.2); absent means none */
  interfaces?: Interface[];
  /**
   * Orderable kits — a SKU and its bill of parts (data model v2 §7.1). A part
   * may be in any number of kits; `kitsContaining` answers which. Replaces
   * `ConnectorDefinition.kitNumber`. Absent means none.
   */
  kits?: KitDefinition[];
  /**
   * The parts placed on each released board revision, linked to their
   * component records, each
   * board's builds' population laid over it at load. Absent means none. The
   * PCBA stays a black box everywhere else: this feeds only the "Components
   * on this board" lists, never the cable BOM.
   */
  boardParts?: BoardPartsEntry[];
  /** the organisation's rule thresholds (hub settings); absent means the defaults */
  rules?: DbRules;
  /**
   * The other designs a design places as sub-assemblies (`subassemblies.ts`):
   * their working copies and the saved versions a reference may pin, filled
   * in by the host for the design at hand (transitively). Absent: sub-assembly
   * references are not checked or flattened — their ports resolve unverified.
   */
  assemblies?: AssemblyLibrary;
  /**
   * The declarative validation rules (`rules.ts`, the catalog's
   * `validation-rules.json`): run by `validateDb` (library subjects) and
   * `validateDesign` (design subjects). Absent means none.
   */
  validationRules?: ValidationRule[];
  /**
   * The shop's work instructions as data (`bench-types.ts`, the catalog's
   * `bench-rules.json`; a data pack may ship them): the build sheet prints
   * their steps in place of the generic ones, after any module's own provider.
   * Absent means none.
   */
  benchRules?: BenchStepRule[];
  /**
   * Drawing art supplied as data (the catalog's `drawing-art.json`; a data pack may ship it): traced
   * connector faces and plugs and wire cutaways, by definition id. Presentation data the model carries
   * and never reads: `@wirehub/docs` draws with it (`DrawingArt`), and the studio checks it on the way in.
   */
  drawingArt?: DrawingArtData;
  /** device profiles (`devices.ts`, the catalog's `devices.json`): what cables plug into; absent means none */
  devices?: DeviceProfile[];
  /** conditioning recipes (`conditioning-recipes.json`): the parts a level change or a termination takes */
  conditioningRecipes?: ConditioningRecipe[];
  /** hazards (`hazards.json`) over the built-in ones: connections the resolver refuses or warns about */
  hazards?: HazardRule[];
  /** how the resolver ranks options (`resolver-policy.json`); absent = the default */
  resolverPolicy?: ResolverPolicy;
  /** product families (`products.ts`, the catalog's `products.json`): the designs a shop sells, grouped, with their variants */
  products?: ProductFamily[];
}

/** The shape of `drawing-art.json`; the values are `DrawingArt`'s (`@wirehub/docs`), which the model does not know. */
export interface DrawingArtData {
  src?: string;
  faces?: Record<string, unknown>;
  plugs?: Record<string, unknown>;
  cutaways?: Record<string, unknown>;
  /** tape label templates by id (`@wirehub/docs` `LabelTemplate`): the shop's own layouts for P-touch tape labels */
  labelTemplates?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Board parts — what is placed on a PCBA
 * ------------------------------------------------------------------ */

/** One placed part on a board: a reference designator linked to its component record. */
export interface PlacedPart {
  /** `R203` */
  ref: string;
  /** the component record's id */
  component: string;
  /** the value as the board (or BOM) prints it: `180R`, `0.1µF` */
  value?: string;
  /** the footprint's library id, or the BOM's footprint text for a board with no KiCad file */
  footprint?: string;
  side?: 'top' | 'bottom';
  /** KiCad marks it Do Not Populate on the design itself (every build) */
  dnp?: boolean;
  /** KiCad leaves it out of the fab BOM (a hand-fitted jack, a solder jumper) */
  excludeFromBom?: boolean;
  /** the Fabrication placement files (CPLs) that place it, by file name */
  cpl?: string[];
  /** file and line it was read from */
  src: string;
}

/** One build's population of a board, laid over `BoardPartsEntry` at load from `data/builds/*.json`. */
export interface BoardPartsBuild {
  /** the build's key in its build file (`basic`), or `as-designed` */
  key: string;
  /** `CPL Basic` */
  build: string;
  /** the definitions this build produced */
  defIds: string[];
  /** refs not fitted on this build */
  omitted: string[];
  /** refs fitted as a 0 Ω link / closed jumper */
  bridged: string[];
}

/** The placed parts of one released board revision. */
export interface BoardPartsEntry {
  /** `PCA-00101` */
  board: string;
  /** `Rev6` */
  revision: string;
  /** the files read, the board files-relative, with their sha256 */
  sources: { path: string; sha256: string; role: 'kicad' | 'bom' | 'cpl' }[];
  parts: PlacedPart[];
  /** filled at load, never stored */
  builds?: BoardPartsBuild[];
  src: string;
}

export function findConnector(db: Db, id: string): ConnectorDefinition | undefined {
  return db.connectors.find((c) => c.id === id);
}

export function findWire(db: Db, id: string): WireDefinition | undefined {
  return db.wires.find((w) => w.id === id);
}

export function findComponent(db: Db, id: string): ComponentDefinition | undefined {
  return db.components.find((c) => c.id === id);
}

export function findPcba(db: Db, id: string): PcbaDefinition | undefined {
  return db.pcbas.find((p) => p.id === id);
}

export function findMechanical(db: Db, id: string): MechanicalDefinition | undefined {
  return (db.mechanicals ?? []).find((m) => m.id === id);
}

/* ------------------------------------------------------------------ *
 * The design document
 * ------------------------------------------------------------------ */

export interface ConnectorInstance {
  id: string;
  def: string;
  role?: string;
  note?: string;
  /**
   * How *this design* uses the connector — a vocab `connector-mountings` id
   * (`direct-solder`, `board-straddle`;), separate from
   * the connector's own `construction` (what the part physically is). Almost
   * always derived from the design's joints instead
   * (`connectorMountingOfInstance`: pins landing on a PCBA's terminals are
   * board-straddle, on wire-stock conductors are direct-solder) — stored only
   * when derivation can't tell (an instance with no joints yet).
   */
  mounting?: string;
  /**
   * The crimp contact, seal or plug in each cavity of a crimp housing
   * (`crimp.ts`), by pin id. Absent = none recorded (always so on a
   * solder-cup or PCB connector).
   */
  cavities?: CavityAssignment[];
  /** the text the wire labels use for this connector ("at J1") instead of its id in capitals */
  label?: string;
}

export interface SegmentInstance {
  id: string;
  def: string;
  lengthMm?: number;
  role?: string;
  /** the run's label designation (`FEED-1`) instead of the generated `W<n>` */
  label?: string;
  /** the exact text lines of the marker at an end, replacing the generated lines (at most 3, 40 characters each) */
  endLabels?: { a?: string[]; b?: string[] };
  /** a label per core, by conductor path: printed at both ends of the run, beside the run's own labels */
  coreLabels?: Record<string, string>;
  /**
   * How this instance's screens are prepared at each end: braids/spirals and
   * drains twisted together into a pigtail that lands once. A pigtail is a
   * terminal of the segment, `pigtail:<id>` at its end; its landing is an
   * ordinary joint.
   */
  pigtails?: Pigtail[];
  /**
   * The elements of the stock this run carries, when it is not all of them:
   * a breakout leg that is part of its trunk continuing out of the mould (the
   * red mini-coax line to its BNC — `["core-red"]`). Element paths (a group
   * covers its children); terminals outside it do not exist on this segment.
   * Absent = the whole stock.
   */
  scope?: string[];
}

/**
 * Screens of one segment, at one end, twisted together and landed as one —
 * "twist the red, green and blue braids, land them on GND2".
 */
export interface Pigtail {
  /** kebab id, unique per (segment, end): `rgb`, `sla`, `gnd`, `aud-gnd` */
  id: string;
  end: 'a' | 'b';
  /**
   * Screen paths twisted into this pigtail. Omitted = the stock's whole bonded
   * mass (a stock whose screens are one `bonded` set, like bonded multi-core).
   */
  members?: string[];
  /** prep: "braids trimmed ~80 %, twisted with the drain" */
  note?: string;
}

/** The terminal id prefix of a pigtail: `pigtail:rgb`. */
export const PIGTAIL_PREFIX = 'pigtail:';

/** The segment terminal id of pigtail `id`. */
export function pigtailTerminal(id: string): string {
  return `${PIGTAIL_PREFIX}${id}`;
}

/** The pigtail id a segment terminal id names, or `undefined` for an element path. */
export function pigtailIdOf(terminal: string): string | undefined {
  return terminal.startsWith(PIGTAIL_PREFIX) ? terminal.slice(PIGTAIL_PREFIX.length) : undefined;
}

export interface ComponentInstance {
  id: string;
  def: string;
  /** 'source-hood' | 'scart-head' | 'inline' | ... */
  location?: string;
  note?: string;
}

export interface PcbaInstance {
  id: string;
  def: string;
  note?: string;
}

/**
 * A shell or a handful of fasteners on the design. Deliberately **not** one
 * of the four electrical instance categories: a `MechanicalDefinition` has no
 * terminals, so a mechanical instance never appears in a `TerminalRef`, a
 * joint, `designInstances()`, or `InstanceKind` — it has nothing to say to
 * the net/trace graph. `qty` carries the count for this one entry (`4` for
 * "4 screws"), rather than each screw being its own instance, because a
 * fastener set is bought and counted as a set, not soldered one at a time
 * like an electrical part.
 */
export interface MechanicalInstance {
  id: string;
  def: string;
  qty: number;
  /** instance id (usually a connector) this part is physically attached to/around */
  attachedTo?: string;
  note?: string;
}

/**
 * What becomes of one conductor (or screen) of a segment where it enters a
 * breakout:
 *
 * - `through` — it passes through the mould **uncut** and continues on the
 *   leg `leg` as the same physical conductor (same element path, same stock):
 *   continuous copper, no joint;
 * - `terminated` — it ends in the mould, soldered there (a joint at this end:
 *   to a jack housed in the mould, or spliced onto a leg's conductor);
 * - `nc` — cut back in the mould and connected to nothing, for `reason`.
 */
export type BreakoutFate = 'through' | 'terminated' | 'nc';

export interface BreakoutConductor {
  /** the segment the element belongs to: the breakout's trunk or one of its legs */
  segment: string;
  /**
   * element path of a conductor or screen — or of a group, standing for every
   * conductor and screen inside it (`core-red` = centre and braid)
   */
  path: string;
  fate: BreakoutFate;
  /** `through`: the leg segment the same conductor continues on */
  leg?: string;
  /** `nc`: why it is left unconnected ("foil trimmed back", "drain at the source only") */
  reason?: string;
}

/**
 * A breakout: a point along the cable — a mould or overmould — where one
 * segment end (the trunk) meets the ends of one or more legs. Each conductor of
 * every participating end is accounted for (`conductors`): passed through
 * uncut, terminated in the mould, or NC with a reason. No terminals of its own
 * (like a mechanical part): the solder facts stay joints, and a pass-through is
 * continuous copper the nets and traces follow.
 */
export interface BreakoutInstance {
  id: string;
  /** the mould part: a `mechanical` instance id (on the BOM once, like any shell) */
  mould?: string;
  /** the segment end entering the breakout */
  trunk: { segment: string; end: 'a' | 'b' };
  /** segment ends leaving it */
  legs: { segment: string; end: 'a' | 'b' }[];
  /** instances housed inside the mould (a jack inset in it) */
  housed?: string[];
  conductors: BreakoutConductor[];
  role?: string;
  note?: string;
}

/**
 * Another design placed in this one as a sub-assembly (`subassemblies.ts`):
 * a reusable lead inside a harness, two leads making a Y. Its unconnected
 * ends — every connector pin, and the conductors of a wire end nothing is
 * soldered to (a flying lead) — are its **ports**, terminals of this
 * instance named by `subassemblyPortId` (`j1:3`, `w1@b:red`); the parent's
 * joints land on them. Trace, nets and the continuity spec flatten through
 * it; the BOM lists it as one line by its part number. Schema v5.
 */
export interface SubassemblyInstance {
  id: string;
  /** the placed design's id */
  def: string;
  /**
   * The saved version it is pinned to. Absent: it follows the placed
   * design's working copy, and saving a version of this design pins it to
   * the placed design's released revision then.
   */
  rev?: number;
  role?: string;
  note?: string;
  /** the text the documents use for it instead of its id */
  label?: string;
}

export interface DesignInstances {
  connectors: ConnectorInstance[];
  segments: SegmentInstance[];
  components: ComponentInstance[];
  pcbas: PcbaInstance[];
  /** shells and hardware; absent means none on this design */
  mechanical?: MechanicalInstance[];
  /** breakout points; absent means none */
  breakouts?: BreakoutInstance[];
  /** other designs placed as sub-assemblies (schema v5); absent means none */
  subassemblies?: SubassemblyInstance[];
}

/**
 * A reference to one terminal in a design.
 * `end` is REQUIRED for segment instances and FORBIDDEN otherwise.
 * Convention: end `a` = source (console) side, end `b` = destination side.
 */
export interface TerminalRef {
  /** instance id from `instances` */
  instance: string;
  /** pin id | element path | component terminal | pad id */
  terminal: string;
  end?: 'a' | 'b';
  /**
   * The physical pad of a multi-pad PCBA terminal this landing goes to
   * (`GND2`). A qualifier only: NOT part of `terminalKey`, nets unchanged.
   */
  pad?: string;
}

/** A physical solder/crimp fact. Nets are derived, never authored. */
export interface Joint {
  a: TerminalRef;
  b: TerminalRef;
  /**
   * The hole this one solder point is made through, when that hole is part of
   * it: a plug pin passed through a carrier board's hole
   * and soldered onto the pad of the board beneath — plug pin, carrier hole and
   * board pad are ONE joint (the through-hole is also the
   * pad). It is on the net with `a` and `b`; the drawings draw nothing extra
   * for it. `jointKey` stays the `a`–`b` pair.
   */
  through?: TerminalRef;
  note?: string;
}

/**
 * Where a design stands in production. `active` (the default when absent) is a
 * current production build; `development` is a design on a board not yet released
 * to production; `legacy` is a still-approved older variant built while its inventory
 * lasts; `retired` is a design no longer
 * built, kept for reference (an older hand-solder build, say).
 */
export type DesignStatus = 'active' | 'development' | 'legacy' | 'retired';

export const DESIGN_STATUSES: readonly DesignStatus[] = [
  'active',
  'development',
  'legacy',
  'retired',
];

/** A design's status, with an absent `status` read as `active`. */
export function designStatus(design: { status?: DesignStatus }): DesignStatus {
  return design.status ?? 'active';
}

/**
 * Design schema versions. v2 added segment pigtails, bonded stocks and pad
 * qualifiers (shield bonding); v3 the optional `recipe`
 * (data model v2 §4.1); v4 breakouts; v5 sub-assemblies.
 * Each version only *added* optional structure, so every older document is a
 * valid v4 document with a smaller number.
 *
 * **One version on disk** (storage seams): every stored
 * design is at `CURRENT_SCHEMA_VERSION`, or — placing sub-assemblies — at
 * `SUBASSEMBLY_SCHEMA_VERSION` (`schemaVersionFor`). Documents at 1–3 exist only as input
 * to `upgradeDesignSchema` (`migrate-schema.ts`) — the one-shot catalog
 * migration and the API's body reader — which is the only code that knows
 * the older numbers.
 */
export type SchemaVersion = 1 | 2 | 3 | 4 | 5;

/**
 * The schema version a design carrying breakouts (`instances.breakouts`,
 * segment `scope`) is written at. Older versions load
 * unchanged: they have no breakouts, so nothing migrates.
 */
export const BREAKOUT_SCHEMA_VERSION = 4 as const;

/**
 * The schema version a design placing sub-assemblies
 * (`instances.subassemblies`) is written at, so an older reader refuses it
 * rather than dropping the parts it cannot see. A design without any stays
 * at `CURRENT_SCHEMA_VERSION`; `schemaVersionFor` picks.
 */
export const SUBASSEMBLY_SCHEMA_VERSION = 5 as const;

/** The highest design schema version this code reads. */
export const MAX_SCHEMA_VERSION = 5 as const;

/**
 * The version every written design without sub-assemblies carries (one with
 * them is at `SUBASSEMBLY_SCHEMA_VERSION`).
 */
export const CURRENT_SCHEMA_VERSION = 4 as const;

export interface CableDesign {
  schemaVersion: SchemaVersion;
  id: string;
  label: string;
  /** store slug / SKU this documents */
  productRef?: string;
  /** production status; absent = 'active' */
  status?: DesignStatus;
  /** free tags (`mil-spec`, `export`) the declarative validation rules can select designs by; absent = none */
  tags?: string[];
  instances: DesignInstances;
  joints: Joint[];
  /** build-level annotations (drain policy etc.) */
  notes?: string[];
  /** hand labour to build one cable, in minutes (the cost roll-up prices it at the organisation's rate); absent = not recorded */
  labourMinutes?: number;
  /** this design's electrical data: the current a pin carries here and rule thresholds over the organisation's (`electrical.ts`) */
  electrical?: DesignElectrical;
  /**
   * The devices this cable connects and the resolver's choices it was derived
   * from (`cable-recipe.ts`): re-derivable, and checked for drift against the
   * body. Absent: a hand design.
   */
  recipe?: CableRecipe;
  /** how the cable is sourced (`products.ts`): made in house, by a contract manufacturer, or bought in finished */
  route?: PartRoute;
  /** who sells it, for a bought-in cable */
  suppliers?: PartSupplier[];
  /** who builds it, for a contract-manufactured cable */
  maker?: string;
  src: string;
  /**
   * Data owned by modules, keyed by module id (`docs/modules.md`). The base
   * never reads inside an entry; it only carries it through load, edit and
   * save unchanged. A module that derives a design from higher-level choices
   * keeps those choices here.
   */
  extensions?: Record<string, unknown>;
}

export type InstanceKind = 'connector' | 'segment' | 'component' | 'pcba' | 'subassembly';

/* ------------------------------------------------------------------ *
 * Issues
 * ------------------------------------------------------------------ */

export type Severity = 'error' | 'warning';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  where?: string;
  /** `where` in a person's words (`J1 pin 2 · RXD`), when it is a terminal of the design */
  whereLabel?: string;
}

export function errors(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.severity === 'error');
}

export function warnings(issues: Issue[]): Issue[] {
  return issues.filter((i) => i.severity === 'warning');
}

/* ------------------------------------------------------------------ *
 * Pad tables
 * ------------------------------------------------------------------ */

/** The shape of the catalog's `pcba-pads.json`: pads per board, per terminal. */
export interface PcbaPadTable {
  boards: Record<string, { src: string; terminals: Record<string, PcbaPad[]> }>;
}

/**
 * Board definitions with the pads of a pad table filled in: each terminal the
 * table names (and that does not already declare its own `pads`) gains them.
 * Pure — returns new objects, never mutates `pcbas`.
 */
export function withPcbaPads(pcbas: PcbaDefinition[], table: PcbaPadTable): PcbaDefinition[] {
  return pcbas.map((pcba) => {
    const board = table.boards[pcba.id];
    if (board === undefined) return pcba;
    return {
      ...pcba,
      terminals: pcba.terminals.map((terminal) => {
        const pads = board.terminals[terminal.id];
        return pads === undefined || terminal.pads !== undefined
          ? terminal
          : { ...terminal, pads: pads.map((pad) => ({ ...pad })) };
      }),
    };
  });
}

/* ------------------------------------------------------------------ *
 * The board list from the catalog files
 * ------------------------------------------------------------------ */

/** One board status record (`data/pcba-status.json`). */
export interface PcbaStatusEntry {
  id: string;
  status: NonNullable<PcbaDefinition['status']>;
  src: string;
}

/**
 * The catalog's board list from its files, in precedence order: curated,
 * then KiCad-direct over pinmaps, then KiCad-only, then the legacy
 * revisions (never over a catalog id); `status` laid over by id.
 */
export function composePcbas(files: {
  curated: readonly PcbaDefinition[];
  generated: readonly PcbaDefinition[];
  kicad: readonly PcbaDefinition[];
  legacy?: readonly PcbaDefinition[];
  status?: readonly PcbaStatusEntry[];
}): PcbaDefinition[] {
  const kicad = new Map(files.kicad.map((p) => [p.id, p]));
  const claimed = new Set(files.curated.map((p) => p.id));
  const out = [...files.curated];
  // a KiCad-direct twin takes the pinmaps-derived definition's place in the list…
  for (const p of files.generated) {
    if (claimed.has(p.id)) continue;
    claimed.add(p.id);
    out.push(kicad.get(p.id) ?? p);
  }
  // …and the definitions only the KiCad-direct builder has (new revisions) follow
  for (const p of kicad.values()) {
    if (claimed.has(p.id)) continue;
    claimed.add(p.id);
    out.push(p);
  }
  for (const p of files.legacy ?? []) {
    if (claimed.has(p.id)) continue;
    claimed.add(p.id);
    out.push(p);
  }
  const status = new Map((files.status ?? []).map((s) => [s.id, s.status]));
  return status.size === 0 ? out : out.map((p) => (status.has(p.id) && p.status === undefined ? { ...p, status: status.get(p.id)! } : p));
}
