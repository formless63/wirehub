/**
 * A design's recipe: the devices it connects and the resolver choices it was
 * derived from (`docs/resolver.md`).
 *
 * - `derivedBody` re-derives the body a recipe stands for (the design's own
 *   instance ids laid over the derived ones through `ids`);
 * - `recipeDrift` compares it, with the recipe's recorded `overrides`
 *   applied, against the design as it is — a difference nobody recorded is
 *   **drift**, and `recipeIssues` reports it as validation issues
 *   (`validateDesign` runs it for every design that carries a recipe);
 * - `inferCableRecipe` looks at a hand design and finds the device pair and
 *   option that reproduce it best, with the differences as overrides;
 * - `rederive` rebuilds the body from the recipe (after a library change);
 * - `recipeJointProposals` lists the joints the recipe derives that the
 *   design lacks (the "Connect known pins" dialog offers them).
 *
 * The override language is `body.ts`'s: hand differences recorded with a reason.
 * Pure: design and library in, findings out.
 */

import { assemblySides } from './assembly.ts';
import { applyOverrides, designBody, diffBodies, jointKey, materialiseBody, schemaVersionFor, type CableOverride, type DesignBody, type OverrideMiss, type UnreasonedOverride } from './body.ts';
import { plugsInto, deriveCable } from './derive-cable.ts';
import { resolveDevice, type ResolverLibrary } from './devices.ts';
import type { CableDesign, Issue, Joint } from './model.ts';
import { resolve, type ResolveQuery } from './resolve.ts';

export interface CableRecipe {
  source: { device: string; port?: string };
  destination: { device: string; port?: string };
  /** the resolver option chosen (`CableOption.id`); absent = the top-ranked */
  option?: string;
  /** the trunk stock */
  stock?: string;
  lengthMm?: number;
  /** derived instance id → this design's id, where they differ */
  ids?: Record<string, string>;
  /** the hand differences from the derived body, each with a reason */
  overrides?: CableOverride[];
}

const LISTS = ['connectors', 'segments', 'components', 'pcbas'] as const;

/** A body with its instance ids renamed through `ids`. */
export function renameBody(body: DesignBody, ids: Readonly<Record<string, string>> | undefined): DesignBody {
  if (ids === undefined || Object.keys(ids).length === 0) return body;
  const map = (id: string): string => ids[id] ?? id;
  const ref = <T extends { instance: string }>(r: T): T => ({ ...r, instance: map(r.instance) });
  const instances = { ...body.instances };
  for (const list of LISTS) (instances as Record<string, unknown>)[list] = (body.instances[list] as { id: string }[]).map((i) => ({ ...i, id: map(i.id) }));
  return {
    instances,
    joints: body.joints.map((j) => ({ ...j, a: ref(j.a), b: ref(j.b), ...(j.through === undefined ? {} : { through: ref(j.through) }) })),
  };
}

const queryOf = (recipe: CableRecipe): ResolveQuery => ({ source: recipe.source, destination: recipe.destination });

/** The body `recipe` stands for (ids laid over), before its overrides. */
export function derivedBody(lib: ResolverLibrary, recipe: CableRecipe): { ok: true; body: DesignBody; option: string } | { ok: false; reason: string } {
  const derived = deriveCable(lib, queryOf(recipe), recipe.option, { ...(recipe.stock === undefined ? {} : { stock: recipe.stock }), ...(recipe.lengthMm === undefined ? {} : { lengthMm: recipe.lengthMm }) });
  if (!derived.ok) return { ok: false, reason: derived.reason };
  return { ok: true, body: renameBody(designBody(derived.design), recipe.ids), option: derived.option.id };
}

export interface RecipeDrift {
  state: 'in-step' | 'drift' | 'unresolved';
  /** what turns the derived body (overrides applied) into the design: the unrecorded differences */
  differences: UnreasonedOverride[];
  /** recorded overrides that no longer apply */
  misses: OverrideMiss[];
  reason?: string;
}

/** The design against its recipe. */
export function recipeDrift(design: CableDesign, lib: ResolverLibrary): RecipeDrift {
  const recipe = design.recipe;
  if (recipe === undefined) return { state: 'in-step', differences: [], misses: [] };
  const derived = derivedBody(lib, recipe);
  if (!derived.ok) return { state: 'unresolved', differences: [], misses: [], reason: derived.reason };
  const { body, misses } = applyOverrides(derived.body, recipe.overrides ?? []);
  const differences = diffBodies(body, designBody(design));
  return { state: differences.length === 0 && misses.length === 0 ? 'in-step' : 'drift', differences, misses };
}

/** One override in a few words. */
export function describeOverride(o: UnreasonedOverride | CableOverride): string {
  switch (o.op) {
    case 'add-joint':
      return `joint ${jointKey(o.joint)} added`;
    case 'remove-joint':
      return `joint ${o.key} removed`;
    case 'move-joint':
      return `joint ${o.key} moved from ${o.from}`;
    case 'put-instance':
      return `${o.list} ${o.instance.id} changed`;
    case 'remove-instance':
      return `${o.list} ${o.id} removed`;
    case 'put-pigtail':
      return `pigtail ${o.pigtail.id} on ${o.segment}`;
    case 'remove-pigtail':
      return `pigtail ${o.id} removed from ${o.segment}`;
    case 'note':
      return o.text;
  }
}

/**
 * Validation issues for a design's recipe (none for a hand design): an
 * unknown device or port, an option the resolver no longer offers, the
 * option's hazards, drift (differences nobody recorded) and overrides that no
 * longer apply. All warnings: a recipe is advice, the body is the truth.
 */
export function recipeIssues(design: CableDesign, lib: ResolverLibrary): Issue[] {
  const recipe = design.recipe;
  if (recipe === undefined) return [];
  const issues: Issue[] = [];
  const warn = (code: string, message: string): void => void issues.push({ code, severity: 'warning', message, where: 'recipe' });
  for (const end of ['source', 'destination'] as const) {
    if (resolveDevice(lib.devices, recipe[end].device) === undefined) warn('recipe-device-unknown', `the recipe's ${end} device '${recipe[end].device}' is not in the library`);
  }
  if (issues.length > 0) return issues;
  const resolution = resolve(lib, queryOf(recipe));
  if (resolution.problems.length > 0 && resolution.options.length === 0 && resolution.rejected.length === 0) {
    warn('recipe-unresolved', `the recipe does not resolve: ${resolution.problems[0]!.message}`);
    return issues;
  }
  const rejected = recipe.option === undefined ? undefined : resolution.rejected.find((r) => r.option.id === recipe.option);
  if (rejected !== undefined) for (const why of rejected.why) warn('recipe-hazard', `the recipe's option is refused: ${why.message}`);
  else if (recipe.option !== undefined && !resolution.options.some((o) => o.id === recipe.option)) {
    warn('recipe-option-gone', `the resolver no longer offers option '${recipe.option}' for these devices`);
    return issues;
  }
  const drift = recipeDrift(design, lib);
  if (drift.state === 'unresolved') warn('recipe-unresolved', `the recipe cannot be derived: ${drift.reason ?? ''}`);
  if (drift.differences.length > 0) {
    const shown = drift.differences.slice(0, 3).map(describeOverride).join('; ');
    warn('recipe-drift', `the design differs from its recipe in ${drift.differences.length} place${drift.differences.length === 1 ? '' : 's'} nobody recorded (${shown}${drift.differences.length > 3 ? '; …' : ''}) — record them as overrides, re-derive, or detach the recipe`);
  }
  for (const miss of drift.misses) warn('recipe-override-stale', `override ${miss.index + 1} no longer applies: ${miss.message}`);
  return issues;
}

/** Each derived instance id → the design's id for the same part (same list, same definition, in order). */
export function alignIds(derived: DesignBody, actual: DesignBody): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const list of LISTS) {
    const theirs = actual.instances[list] as { id: string; def: string }[];
    const mine = derived.instances[list] as { id: string; def: string }[];
    const used = new Set<string>();
    for (const m of mine) {
      const match = theirs.find((t) => t.def === m.def && !used.has(t.id));
      if (match === undefined) continue;
      used.add(match.id);
      if (match.id !== m.id) ids[m.id] = match.id;
    }
  }
  return ids;
}

export type RecipeInference =
  | { ok: true; recipe: CableRecipe; state: 'identical' | 'with-overrides'; differences: number; tried: number }
  | { ok: false; reason: string; tried: number };

/** The device ports a connector definition plugs into, from the library's devices (adapters left out). */
function portsTaking(lib: ResolverLibrary, connectorDef: string): { device: string; port: string }[] {
  const def = lib.connectors.find((c) => c.id === connectorDef);
  if (def === undefined) return [];
  const out: { device: string; port: string }[] = [];
  for (const raw of lib.devices ?? []) {
    const device = resolveDevice(lib.devices, raw.id);
    if (device === undefined || device.board !== undefined) continue;
    for (const port of device.ports) if (plugsInto(lib, def, port)) out.push({ device: device.id, port: port.id });
  }
  return out;
}

/**
 * The recipe that reproduces a hand design best: every device port its
 * source-side and destination-side plugs fit, every option the resolver
 * gives for each pair, derived on the design's own stock and length, ids
 * aligned, and the one with the fewest differences kept (they become its
 * overrides). `ok: false` when no device in the library takes its plugs.
 */
export function inferCableRecipe(design: CableDesign, lib: ResolverLibrary, maxPairs = 24): RecipeInference {
  const sides = assemblySides(design);
  const plugsOn = (side: 'a' | 'b'): string[] => {
    const defs: string[] = [];
    for (const c of design.instances.connectors) {
      const s = sides.get(c.id) ?? 'unassigned';
      if (s === side || s === 'unassigned' || s === 'both') defs.push(c.def);
    }
    for (const p of design.instances.pcbas) {
      const s = sides.get(p.id) ?? 'unassigned';
      if (s !== side && s !== 'unassigned' && s !== 'both') continue;
      for (const ic of lib.pcbas.find((x) => x.id === p.def)?.integratedConnectors ?? []) defs.push(ic.connectorDefId);
    }
    return [...new Set(defs)];
  };
  const sourcePorts = plugsOn('a').flatMap((d) => portsTaking(lib, d));
  const destPorts = plugsOn('b').flatMap((d) => portsTaking(lib, d));
  if (sourcePorts.length === 0 || destPorts.length === 0) {
    return { ok: false, reason: `no device in the library takes the ${sourcePorts.length === 0 ? 'source' : 'destination'}-side plug of this design`, tried: 0 };
  }
  const trunk = design.instances.segments[0];
  const actual = designBody(design);
  let best: { recipe: CableRecipe; differences: UnreasonedOverride[]; rank: number } | undefined;
  let tried = 0;
  for (const s of sourcePorts) {
    for (const d of destPorts) {
      if (tried >= maxPairs) break;
      if (s.device === d.device && s.port === d.port) continue;
      tried += 1;
      const query: ResolveQuery = { source: { device: s.device, port: s.port }, destination: { device: d.device, port: d.port } };
      const resolution = resolve(lib, query);
      for (const option of resolution.options) {
        const derived = deriveCable(lib, query, option.id, { ...(trunk === undefined ? {} : { stock: trunk.def }), ...(trunk?.lengthMm === undefined ? {} : { lengthMm: trunk.lengthMm }) });
        if (!derived.ok) continue;
        const raw = designBody(derived.design);
        const ids = alignIds(raw, actual);
        const differences = diffBodies(renameBody(raw, ids), actual);
        if (best === undefined || differences.length < best.differences.length || (differences.length === best.differences.length && option.rank < best.rank)) {
          best = {
            recipe: { ...derived.design.recipe!, ...(Object.keys(ids).length === 0 ? {} : { ids }) },
            differences,
            rank: option.rank,
          };
        }
      }
    }
  }
  if (best === undefined) return { ok: false, reason: 'the devices that take its plugs give no option this library can derive', tried };
  const overrides = best.differences.map((d) => ({ ...d, reason: 'hand-edit' }) as CableOverride);
  return {
    ok: true,
    recipe: { ...best.recipe, ...(overrides.length === 0 ? {} : { overrides }) },
    state: overrides.length === 0 ? 'identical' : 'with-overrides',
    differences: overrides.length,
    tried,
  };
}

/** The design rebuilt from its recipe, overrides applied, prose kept where the parts survive. */
export function rederive(design: CableDesign, lib: ResolverLibrary): { ok: true; design: CableDesign; misses: OverrideMiss[] } | { ok: false; reason: string } {
  const recipe = design.recipe;
  if (recipe === undefined) return { ok: false, reason: 'this design has no recipe' };
  const derived = derivedBody(lib, recipe);
  if (!derived.ok) return { ok: false, reason: derived.reason };
  const { body, misses } = applyOverrides(derived.body, recipe.overrides ?? []);
  const next = materialiseBody(body, designBody(design));
  return { ok: true, design: { ...design, schemaVersion: schemaVersionFor(next), instances: next.instances, joints: next.joints }, misses };
}

/** The joints the recipe derives that the design lacks, where every terminal they name is in the design. */
export function recipeJointProposals(design: CableDesign, lib: ResolverLibrary): { joint: Joint; why: string }[] {
  const recipe = design.recipe;
  if (recipe === undefined) return [];
  const derived = derivedBody(lib, recipe);
  if (!derived.ok) return [];
  const { body } = applyOverrides(derived.body, recipe.overrides ?? []);
  const have = new Set(design.joints.map((j) => jointKey(j)));
  const instances = new Set(
    [...design.instances.connectors, ...design.instances.segments, ...design.instances.components, ...design.instances.pcbas].map((i) => i.id),
  );
  return body.joints
    .filter((j) => !have.has(jointKey(j)) && instances.has(j.a.instance) && instances.has(j.b.instance))
    .map((j) => ({ joint: j, why: `the recipe (${recipe.source.device} → ${recipe.destination.device}) derives ${jointKey(j)}` }));
}
