/**
 * Board builds as data (data model v2 §3.2, §9 task 8).
 *
 * A board is designed once (the KiCad netlist); it is *built* several ways.
 * A build is what the importer needs to turn the netlist into a
 * `PcbaDefinition` — which parts are fitted as 0 Ω links (`bridged`), which
 * are left off (`omitted`), which pin pairs of an active part carry signal
 * (`passages`) — plus what the build *means*:
 *
 * - `settings`: the board's jumpers, switches and optional links named by
 *   the owner's function legend (CS, CV, Y, TTL, Luma) and mapped to the
 *   KiCad reference, with the per-order rules the owner gave (wirehub-
 *   8ou.26: "TTL open for SCART, closed for HD15/BNC");
 * - `capability`: what the build does to each signal on its way through —
 *   input, output, the conditioning recipes on the path — every path backed
 *   by an internal link of the generated definition;
 * - `expects`, `power`, `hazards`: the guards the resolver (task 12) checks.
 *
 * One file per board under `packages/catalog/data/builds/`. Adding a build is
 * a data edit. Pure types and checks; nothing here reads a file.
 */

import type { Issue, PcbaDefinition } from './model.ts';
import type { Interface } from './interfaces.ts';
import { signalIds, vocabEntry, type SignalRef, type Vocab } from './vocab.ts';

/* ------------------------------------------------------------------ *
 * Population (what the importer reads)
 * ------------------------------------------------------------------ */

/**
 * A curated, cited, one-way statement that a named pin pair of a named part
 * carries the signal on this build (an LM1881, a buffer, a switch position).
 * `nets` restates the nets the two pins sit on; the importer throws if the
 * netlist disagrees.
 */
export interface PartPassage {
  /** pin the signal enters on, as the netlist numbers it */
  from: string;
  /** pin it leaves on */
  to: string;
  /** the nets `from` and `to` must sit on, in that order */
  nets: readonly [string, string];
  /** `via` annotation, house style ("R203 180 Ω") */
  label: string;
}

/** Every passage declared for one part on one build. */
export interface DeclaredPassages {
  ref: string;
  passages: readonly PartPassage[];
  src: string;
}

/* ------------------------------------------------------------------ *
 * Settings — jumpers by the owner's name
 * ------------------------------------------------------------------ */

/** When a per-order setting takes a state: the destination and/or sync the cable is for. */
export interface SettingRule {
  when: {
    /** input requirement ids (data model v2 §2.2: `scart-rgb`, `hd15-rgbs`, `bnc-rgbs`, …) */
    destination?: string[];
    /** vocab `sync-types` */
    sync?: string[];
    /** other settings of the same build that must hold (the source device: TTL only together with CS) */
    settings?: Record<string, string>;
    /**
     * whether the destination build strips sync itself (an active LM1881 on
     * the sync path): an HD15 cable sends the standard build's
     * attenuated CSync into the stripper build, while a passive HD15 / BNC end needs TTL
     */
    destinationStrips?: boolean;
  };
  state: string;
  src?: string;
}

/**
 * One jumper, switch or optional link, keyed by the function the owner calls
 * it by. `kind`: a `jumper` is a solder jumper (closed = fitted as a 0 Ω
 * link); a `link` is a placed-or-not 0 Ω part; a `switch` is a user control
 * whose positions are declared as passages, not population.
 */
export interface BuildSetting {
  /** the owner's name / silkscreen legend: 'CS', 'CV', 'Y', 'TTL', 'Luma', … */
  function: string;
  /** the KiCad reference it is on this board: 'JP1', 'R3', 'SW1' */
  ref: string;
  kind: 'jumper' | 'link' | 'switch';
  /** 'open' | 'closed' for a jumper or link; the positions of a switch */
  states: string[];
  /** what it does, in a line */
  label?: string;
  /** per-order rules: which state a cable for a given destination / sync takes */
  rules?: SettingRule[];
  src: string;
}

/* ------------------------------------------------------------------ *
 * Capability — what the build does to each signal
 * ------------------------------------------------------------------ */

/** A signal with its level, as far as it is known. */
export interface SignalSpec {
  /** vocab `signals`, or `{ oneOf }` for "whichever of these arrives" */
  signal: SignalRef;
  /** vocab `levels`; absent = not stated */
  level?: string;
}

export interface CapabilityPath {
  /** board terminal the signal enters on (`j.5`, `S`, `mo.3`) */
  from: string;
  /** board terminal it leaves on */
  to: string;
  in: SignalSpec;
  /** absent: leaves as it came */
  out?: SignalSpec;
  /** vocab `conditioning`, in path order */
  conditioning: string[];
  /** the settings that select this path (a switch position): `{ SW1: 'CS' }` */
  when?: Record<string, string>;
  /**
   * `false` for a path through an active part the definition declares no
   * passage for (an H+V sync combiner) — stated, but not traceable.
   */
  linked?: boolean;
  note?: string;
}

export interface BoardCapability {
  paths: CapabilityPath[];
  src: string;
}

export interface BuildHazard {
  /** the resolver's code (§3.3): 'ttl-into-strict', 'stripper-on-12v', 'power-into-signal', … */
  code: string;
  text: string;
  src: string;
}

/* ------------------------------------------------------------------ *
 * The build and the board file
 * ------------------------------------------------------------------ */

export interface BoardBuild {
  /** short key, used for the id suffix unless `idSuffix` overrides it */
  key: string;
  /** appended to `<pn>-<rev>` to make the definition id; '' keeps the bare id */
  idSuffix?: string;
  /** `PcbaDefinition.build` */
  build: string;
  /** human suffix for the definition label */
  labelSuffix?: string;
  /** refs fitted as 0 Ω links */
  bridged?: readonly string[];
  /** refs left unpopulated */
  omitted?: readonly string[];
  /**
   * refs fitted with a value other than the board file's, KiCad style
   * (`{ R203: '470R' }`: the 12 V blanking build of PCA-00101) — carried
   * into the definition's link annotations and the depiction's part labels
   */
  values?: Readonly<Record<string, string>>;
  /**
   * the value this build's network feeds each input-requirement position with
   * (`{ '16': '470 Ω' }`), where it is not the board's `power` rail default —
   * the resolver checks it against the device's rail / exception
   */
  feedValues?: Readonly<Record<string, string>>;
  /** active parts whose signal path this build declares */
  passages?: readonly DeclaredPassages[];
  /** carried onto the definition's `src` */
  src: string;
  note?: string;
  /** the board's settings on this build, by function: `{ CS: 'closed', TTL: 'open' }` */
  settings?: Record<string, string>;
  capability?: BoardCapability;
  hazards?: BuildHazard[];
  /**
   * The input requirements this build is offered for (resolver); absent =
   * every requirement its footprint carries. `[]` = a special-purpose build
   * the resolver never offers on its own (PCA-00111 "dac": the Analogue-DAC
   * output end of an add-on adapter, not a display input); a recipe may still
   * name it.
   */
  serves?: string[];
}

/** Where a board's connector sits on it (data model v2 §3.2). */
export interface BoardFootprint {
  /** terminal prefix: `j` for `j.5` */
  prefix: string;
  /** the interface the footprint carries */
  interface: string;
  /** the board carries the connector itself (`mo.*`, `scart.*`) */
  integrated: boolean;
  /** footprint pads that are not numbered like the interface: pad → position (`GND` → `shell`) */
  pads?: Record<string, string>;
  /** the evidence for the pad → position reading (nets, footprint geometry, the owner's traced face) */
  src?: string;
  /**
   * A carrier board between the plug and this footprint (the DIN-8 perfboard
   * PCA-00109): the plug's pins solder
   * into the carrier, and the carrier's pads T-join this footprint's pads.
   * A pin the carrier does not route lands on this footprint directly.
   */
  carrier?: BoardCarrier;
}

/** A board the plug is soldered into before it meets a footprint (`BoardFootprint.carrier`). */
export interface BoardCarrier {
  /** the carrier's definition id (`PCA-00109-rev3`) */
  pcba: string;
  /** the carrier's footprint prefix the plug's pins solder into (`j1` of `j1.3`) */
  prefix: string;
  /** the prefix of the carrier's pads that meet this footprint's pads (`jp` of `jp.CV`) */
  pads: string;
  /** plug positions the carrier's netlist leaves unnamed → the carrier pad each lands on */
  pins?: Record<string, string>;
  /**
   * Plug positions whose carrier hole IS the joint to this footprint's pad
   * → that hole's carrier terminal: the pin passes
   * through the hole and one solder point takes the pin, the hole and the
   * board pad beneath (the DIN-8 perfboard's J1-4 "+V" and J1-5 "G", which
   * have no trace of their own: the through-hole is also
   * the pad). The design joins the pin to the footprint pad `through` the
   * hole; no carrier → board link is drawn.
   */
  through?: Record<string, string>;
  src: string;
}

/**
 * Where plug position `position` goes on `carrier`: the carrier terminal the
 * pin solders into and the carrier pad that meets the next board — or
 * `undefined` when the carrier does not route it (the pin then lands on the
 * next board directly). `through`: the pin's carrier hole is itself the
 * joint to the next board's pad (`pin === pad`, `BoardCarrier.through`).
 */
export function carrierRoute(carrier: BoardCarrier, def: PcbaDefinition, position: string): { pin: string; pad: string; through?: true } | undefined {
  const has = new Set(def.terminals.map((t) => t.id));
  const hole = carrier.through?.[position];
  if (hole !== undefined) return has.has(hole) ? { pin: hole, pad: hole, through: true } : undefined;
  const own = carrier.pins?.[position];
  if (own !== undefined) return has.has(own) ? { pin: own, pad: own } : undefined;
  const pin = `${carrier.prefix}.${position}`;
  if (!has.has(pin)) return undefined;
  const padPrefix = `${carrier.pads}.`;
  for (const l of def.internalLinks) {
    if (l.via !== undefined) continue;
    const other = l.from === pin ? l.to : l.to === pin ? l.from : undefined;
    if (other !== undefined && other.startsWith(padPrefix) && has.has(other)) return { pin, pad: other };
  }
  return undefined;
}

/** A board another board is assembled or used with. */
export interface BoardPair {
  /** its part number (`PCA-00109`) */
  board: string;
  /** how the two go together, in a sentence */
  relation: string;
  src: string;
}

/** One file under `data/builds/`: every build of one board. */
export interface BoardBuilds {
  /** board part number, as the netlist and the definitions spell it */
  board: string;
  /** a revision whose population differs gets its own file and wins over the part-number one */
  revision?: string;
  label: string;
  /** the end's short display name, where the board *is* the end ('SCART Reverse', 'DB-25 (Sony PVM)') — the cable list and lineup show it, `label` in the tooltip */
  short?: string;
  end: 'source' | 'destination' | 'inline';
  footprints?: BoardFootprint[];
  settings?: BuildSetting[];
  /** groups of settings of which exactly one is closed on a build (the source device: CV / Y / CS) */
  exclusive?: string[][];
  /** hazard guard: the signal the board assumes on a terminal (PCA-00110 `mo.3` = csync) */
  expects?: Record<string, string>;
  /** the rail the board is sized for and the terminals it feeds */
  power?: { rail: string; feeds: string[]; note?: string };
  hazards?: BuildHazard[];
  /**
   * Other boards this one is built or used with — a relation, not a
   * connection (PCA-00112-30 interfaces with the DIN 8 perfboard PCA-00109).
   */
  pairs?: BoardPair[];
  /** in the order the definitions are emitted */
  builds: BoardBuild[];
  src?: string;
}

/** The lookup key the importer uses: `PCA-00111`, or `PCA-00108 Rev5`. */
export function boardBuildsKey(file: Pick<BoardBuilds, 'board' | 'revision'>): string {
  return file.revision === undefined ? file.board : `${file.board} ${file.revision}`;
}

/**
 * A build's population with its settings folded in: a jumper or link the
 * settings close is bridged (jumper) or kept (link), one they open is
 * omitted. Refs already listed keep their place; the settings only add what
 * is missing, so a new build can be written as settings alone.
 */
export function buildPopulation(file: BoardBuilds, build: BoardBuild): { bridged?: string[]; omitted?: string[] } {
  let bridged = build.bridged === undefined ? undefined : [...build.bridged];
  let omitted = build.omitted === undefined ? undefined : [...build.omitted];
  for (const [fn, state] of Object.entries(build.settings ?? {})) {
    const setting = file.settings?.find((s) => s.function === fn);
    if (setting === undefined || setting.kind === 'switch') continue;
    const ref = setting.ref;
    if (state === 'closed' && setting.kind === 'jumper' && !(bridged ?? []).includes(ref)) bridged = [...(bridged ?? []), ref];
    if (state === 'open' && !(omitted ?? []).includes(ref)) omitted = [...(omitted ?? []), ref];
  }
  return { ...(bridged === undefined ? {} : { bridged }), ...(omitted === undefined ? {} : { omitted }) };
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

function issue(code: string, message: string, where: string, severity: Issue['severity'] = 'error'): Issue {
  return { code, severity, message, where };
}

export interface BuildCheckLibrary {
  /** every board definition (curated + generated), to find each build's definitions */
  pcbas: readonly PcbaDefinition[];
  interfaces?: readonly Interface[];
  vocab?: Vocab;
}

/** The definitions a build produced: same part number (and revision, if the file names one), same `build` string. */
export function definitionsOfBuild(file: BoardBuilds, build: BoardBuild, pcbas: readonly PcbaDefinition[]): PcbaDefinition[] {
  return pcbas.filter(
    (p) => p.status !== 'retired' && p.partNumber === file.board && (file.revision === undefined || p.revision === file.revision) && p.build === build.build,
  );
}

/**
 * Everything wrong with the build files against the definitions they produce:
 *
 * - `build-duplicate`: two files for one key, two builds with one key;
 * - `build-setting-unknown`, `build-setting-state`: a build names a setting
 *   the board lacks, or a state the setting has not got;
 * - `build-setting-population`: a setting's state disagrees with `bridged` /
 *   `omitted` (a closed jumper that is omitted, an open one that is bridged);
 * - `build-exclusive`: not exactly one of an exclusive group closed;
 * - `capability-path-unlinked`: a capability path no internal link of the
 *   build's definitions backs (unless it says `linked: false`);
 * - `footprint-position-unknown`: a `<prefix>.<n>` terminal whose `n` the
 *   footprint's interface does not assign; `footprint-interface-unknown`;
 * - `vocab-unknown`: a conditioning, level or signal id the lists lack.
 */
export function validateBoardBuilds(files: readonly BoardBuilds[], library: BuildCheckLibrary): Issue[] {
  const issues: Issue[] = [];
  const keys = new Set<string>();
  const vocabRef = (list: string, id: string, where: string): void => {
    if (library.vocab?.[list] === undefined) return;
    if (vocabEntry(library.vocab, list, id, { includePending: true }) === undefined) {
      issues.push(issue('vocab-unknown', `'${id}' is not in the '${list}' list`, where));
    }
  };
  const spec = (s: SignalSpec | undefined, where: string): void => {
    if (s === undefined) return;
    for (const id of signalIds(s.signal)) vocabRef('signals', id, where);
    if (s.level !== undefined) vocabRef('levels', s.level, where);
  };

  for (const file of files) {
    const key = boardBuildsKey(file);
    const at = `builds/${key}`;
    if (keys.has(key)) issues.push(issue('build-duplicate', `two build files for '${key}'`, at));
    keys.add(key);
    const settings = new Map((file.settings ?? []).map((s) => [s.function, s]));
    const buildKeys = new Set<string>();

    for (const fp of file.footprints ?? []) {
      if (fp.carrier !== undefined) {
        const carrier = library.pcbas.find((p) => p.id === fp.carrier!.pcba);
        if (!fp.carrier.src) issues.push(issue('missing-src', `footprint '${fp.prefix}' carrier has no src`, at, 'warning'));
        if (carrier === undefined) issues.push(issue('carrier-unknown', `footprint '${fp.prefix}' names unknown carrier board '${fp.carrier.pcba}'`, at));
        else {
          for (const [pos, t] of Object.entries(fp.carrier.pins ?? {})) {
            if (!carrier.terminals.some((x) => x.id === t)) issues.push(issue('carrier-pad-unknown', `carrier ${carrier.id} has no terminal '${t}' for position ${pos}`, at));
          }
          // a through hole is a carrier terminal with no copper of its own to another pad
          for (const [pos, t] of Object.entries(fp.carrier.through ?? {})) {
            if (!carrier.terminals.some((x) => x.id === t)) issues.push(issue('carrier-pad-unknown', `carrier ${carrier.id} has no terminal '${t}' for through position ${pos}`, at));
            else if (carrier.internalLinks.some((l) => l.from === t || l.to === t)) {
              issues.push(issue('carrier-through-linked', `carrier ${carrier.id} terminal '${t}' (through position ${pos}) has copper to another pad — it is not a plain through hole`, at));
            }
            if (fp.carrier.pins?.[pos] !== undefined) issues.push(issue('carrier-through-routed', `position ${pos} is both routed (pins) and through on carrier ${carrier.id}`, at));
          }
        }
      }
      if (library.interfaces === undefined) continue;
      const iface = library.interfaces.find((i) => i.id === fp.interface);
      if (iface === undefined) {
        issues.push(issue('footprint-interface-unknown', `footprint '${fp.prefix}' names unknown interface '${fp.interface}'`, at));
        continue;
      }
      const defs = library.pcbas.filter((p) => p.status !== 'retired' && p.partNumber === file.board && (file.revision === undefined || p.revision === file.revision));
      for (const def of defs) {
        const terminals = [
          ...def.terminals.map((t) => t.id),
          ...def.internalLinks.flatMap((l) => [l.from, l.to]),
        ];
        for (const t of new Set(terminals)) {
          if (!t.startsWith(`${fp.prefix}.`)) continue;
          const pad = t.slice(fp.prefix.length + 1);
          const position = fp.pads?.[pad] ?? pad;
          if (iface.pins[position] === undefined) {
            issues.push(issue('footprint-position-unknown', `${def.id} terminal '${t}' is not a position ${fp.interface} assigns`, at));
          }
        }
      }
    }
    for (const h of file.hazards ?? []) if (!h.src) issues.push(issue('missing-src', `hazard '${h.code}' has no src`, at, 'warning'));
    for (const pair of file.pairs ?? []) {
      if (!pair.src) issues.push(issue('missing-src', `pair '${pair.board}' has no src`, at, 'warning'));
      if (!library.pcbas.some((p) => p.partNumber === pair.board || p.partNumber?.startsWith(`${pair.board}-`))) {
        issues.push(issue('pair-board-unknown', `pairs with '${pair.board}', which no board definition carries`, at, 'warning'));
      }
    }

    for (const build of file.builds) {
      const where = `${at}/${build.key}`;
      if (buildKeys.has(build.key)) issues.push(issue('build-duplicate', `two builds keyed '${build.key}'`, where));
      buildKeys.add(build.key);
      if (!build.src) issues.push(issue('missing-src', `build '${build.key}' has no src`, where, 'warning'));

      const population = buildPopulation(file, build);
      for (const [fn, state] of Object.entries(build.settings ?? {})) {
        const setting = settings.get(fn);
        if (setting === undefined) {
          issues.push(issue('build-setting-unknown', `build '${build.key}' sets '${fn}', which ${key} does not have`, where));
          continue;
        }
        if (!setting.states.includes(state)) {
          issues.push(issue('build-setting-state', `'${fn}' has no state '${state}' (${setting.states.join(' / ')})`, where));
          continue;
        }
        if (setting.kind === 'switch') continue;
        const bridged = (population.bridged ?? []).includes(setting.ref);
        const omitted = (population.omitted ?? []).includes(setting.ref);
        const agrees =
          setting.kind === 'jumper'
            ? state === 'closed' ? bridged && !omitted : omitted && !bridged
            : state === 'closed' ? !omitted : omitted;
        if (!agrees) {
          issues.push(issue('build-setting-population', `'${fn}' (${setting.ref}) is ${state}, but the population says otherwise`, where));
        }
      }
      for (const group of file.exclusive ?? []) {
        const closed = group.filter((fn) => build.settings?.[fn] === 'closed');
        if (build.settings !== undefined && closed.length !== 1) {
          issues.push(issue('build-exclusive', `exactly one of ${group.join(' / ')} must be closed; ${closed.length} are`, where));
        }
      }

      const defs = definitionsOfBuild(file, build, library.pcbas);
      for (const [n, path] of (build.capability?.paths ?? []).entries()) {
        const pw = `${where}/capability/${n}`;
        spec(path.in, pw);
        spec(path.out, pw);
        for (const c of path.conditioning) vocabRef('conditioning', c, pw);
        for (const [ref, state] of Object.entries(path.when ?? {})) {
          const setting = [...settings.values()].find((s) => s.ref === ref || s.function === ref);
          if (setting === undefined || !setting.states.includes(state)) {
            issues.push(issue('build-setting-unknown', `path selects '${ref}' = '${state}', which ${key} does not have`, pw));
          }
        }
        if (path.linked === false) continue;
        for (const def of defs) {
          const linked = def.internalLinks.some(
            (l) => (l.from === path.from && l.to === path.to) || (l.from === path.to && l.to === path.from),
          );
          if (!linked) {
            issues.push(issue('capability-path-unlinked', `${def.id} has no internal link ${path.from} ↔ ${path.to}`, pw));
          }
        }
      }
      for (const h of build.hazards ?? []) if (!h.src) issues.push(issue('missing-src', `hazard '${h.code}' has no src`, where, 'warning'));
    }
  }
  return issues;
}
