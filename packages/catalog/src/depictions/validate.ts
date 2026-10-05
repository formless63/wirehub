/**
 * Depiction validation.
 *
 * Same contract as `core`'s validators: **nothing here throws on bad data**.
 * A malformed `meta.json`, a missing SVG, an anchor naming a pin the
 * definition does not have — every one of them comes back as a typed `Issue`,
 * so a broken depiction degrades the renderer to the abstract block instead of
 * taking the build down.
 *
 * Two layers:
 *
 *  1. `parseDepictionMeta` — structural. Turns unknown JSON into a
 *     `DepictionMeta`, or into issues. Never trusts a field.
 *  2. `validateDepiction` — referential. Files exist, view kinds are known,
 *     `mirrorOf` and `anchorFrame` name real views, and every anchor id is a
 *     real pin/pad/terminal of the definition it claims (when the catalog
 *     knows that definition at all).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  findComponent,
  findConnector,
  findPcba,
  findWire,
  pcbaTerminalIds,
  type Db,
  type Issue,
} from '@wirehub/model';

import {
  ANCHOR_SIDES,
  ASSET_KINDS,
  BOARD_PART_KINDS,
  BOARD_PART_STATES,
  DEPICTION_VIEWS,
  MIRROR_AXES,
  PART_PACKAGE_FAMILIES,
  SOURCE_KINDS,
  isDepictionView,
  type AnchorPad,
  type AnchorSide,
  type AssetKind,
  type BoardComponents,
  type BoardPart,
  type BoardPartKind,
  type BoardPartState,
  type DepictionAsset,
  type DepictionMeta,
  type DepictionSourceFile,
  type DepictionView,
  type EntryGuide,
  type MirrorAxis,
  type PartPackage,
  type PartPackageFamily,
  type PartPad,
  type PinAnchor,
  type SourceKind,
  type BoardColor,
} from './model.ts';

function issue(
  code: string,
  message: string,
  where: string,
  severity: 'error' | 'warning' = 'error',
): Issue {
  return { code, severity, message, where };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseColor(value: unknown, where: string, issues: Issue[]): BoardColor | undefined {
  if (value === undefined) return undefined;
  const bad = (detail: string): undefined => {
    issues.push(issue('depiction-bad-field', `color ${detail}`, where));
    return undefined;
  };
  if (!isRecord(value)) return bad('must be an object');
  const { mask, maskHex, silk, silkHex, copperFinish, copperHex, inferred, src } = value;
  if (!nonEmptyString(mask)) return bad('mask must be a non-empty string');
  if (!nonEmptyString(maskHex)) return bad('maskHex must be a non-empty string');
  if (!nonEmptyString(silk)) return bad('silk must be a non-empty string');
  if (!nonEmptyString(silkHex)) return bad('silkHex must be a non-empty string');
  if (!nonEmptyString(src)) return bad('has no src citation');
  if (copperFinish !== undefined && !nonEmptyString(copperFinish)) return bad('copperFinish must be a non-empty string');
  if (copperHex !== undefined && !nonEmptyString(copperHex)) return bad('copperHex must be a non-empty string');
  if (inferred !== undefined && typeof inferred !== 'boolean') return bad('inferred must be a boolean');
  return {
    mask,
    maskHex,
    silk,
    silkHex,
    ...(copperFinish === undefined ? {} : { copperFinish }),
    ...(copperHex === undefined ? {} : { copperHex }),
    ...(inferred === undefined ? {} : { inferred }),
    src,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/* ------------------------------------------------------------------ *
 * Structural parse
 * ------------------------------------------------------------------ */

export interface ParsedDepiction {
  /** Present only when the record is structurally sound enough to use. */
  meta?: DepictionMeta;
  issues: Issue[];
}

function parseAsset(
  value: unknown,
  where: string,
  issues: Issue[],
): DepictionAsset | undefined {
  if (!isRecord(value)) {
    issues.push(issue('depiction-bad-field', `view is not an object`, where));
    return undefined;
  }
  let ok = true;
  const require = (field: string, test: boolean, detail: string): void => {
    if (test) return;
    issues.push(issue('depiction-bad-field', `${field} ${detail}`, where));
    ok = false;
  };

  require('file', nonEmptyString(value['file']), 'must be a non-empty string');
  require(
    'kind',
    typeof value['kind'] === 'string' &&
      (ASSET_KINDS as readonly string[]).includes(value['kind']),
    `must be one of ${ASSET_KINDS.join(' | ')}`,
  );
  require(
    'mmPerUnit',
    isFiniteNumber(value['mmPerUnit']) && (value['mmPerUnit'] as number) > 0,
    'must be a finite number greater than 0',
  );
  require(
    'sourceKind',
    typeof value['sourceKind'] === 'string' &&
      (SOURCE_KINDS as readonly string[]).includes(value['sourceKind']),
    `must be one of ${SOURCE_KINDS.join(' | ')}`,
  );
  require('src', nonEmptyString(value['src']), 'must be a non-empty citation string');

  for (const field of ['widthUnits', 'heightUnits'] as const) {
    if (value[field] === undefined) continue;
    require(field, isFiniteNumber(value[field]) && (value[field] as number) > 0, 'must be a finite number greater than 0');
  }
  if (value['mirrorOf'] !== undefined) {
    require(
      'mirrorOf',
      typeof value['mirrorOf'] === 'string' && isDepictionView(value['mirrorOf']),
      `must name a view kind (${DEPICTION_VIEWS.join(' | ')})`,
    );
  }
  if (value['mirrorAxis'] !== undefined) {
    require(
      'mirrorAxis',
      typeof value['mirrorAxis'] === 'string' &&
        (MIRROR_AXES as readonly string[]).includes(value['mirrorAxis']),
      `must be one of ${MIRROR_AXES.join(' | ')}`,
    );
  }
  if (!ok) return undefined;

  return {
    file: value['file'] as string,
    kind: value['kind'] as AssetKind,
    mmPerUnit: value['mmPerUnit'] as number,
    sourceKind: value['sourceKind'] as SourceKind,
    ...(value['widthUnits'] === undefined ? {} : { widthUnits: value['widthUnits'] as number }),
    ...(value['heightUnits'] === undefined ? {} : { heightUnits: value['heightUnits'] as number }),
    ...(value['mirrorOf'] === undefined ? {} : { mirrorOf: value['mirrorOf'] as DepictionView }),
    ...(value['mirrorAxis'] === undefined ? {} : { mirrorAxis: value['mirrorAxis'] as MirrorAxis }),
    src: value['src'] as string,
  };
}

function parseAnchor(
  value: unknown,
  where: string,
  issues: Issue[],
): PinAnchor | undefined {
  if (!isRecord(value)) {
    issues.push(issue('depiction-bad-field', 'anchor is not an object', where));
    return undefined;
  }
  if (!isFiniteNumber(value['x']) || !isFiniteNumber(value['y'])) {
    issues.push(issue('depiction-bad-field', 'anchor x/y must be finite numbers', where));
    return undefined;
  }
  if (value['note'] !== undefined && typeof value['note'] !== 'string') {
    issues.push(issue('depiction-bad-field', 'anchor note must be a string', where));
    return undefined;
  }
  if (value['side'] !== undefined && !isAnchorSide(value['side'])) {
    issues.push(
      issue('depiction-bad-field', `anchor side must be one of ${ANCHOR_SIDES.join(' | ')}`, where),
    );
    return undefined;
  }
  if (value['approach'] !== undefined && !isFiniteNumber(value['approach'])) {
    issues.push(issue('depiction-bad-field', 'anchor approach must be a finite number', where));
    return undefined;
  }
  if (value['size'] !== undefined && !isSizePair(value['size'])) {
    issues.push(issue('depiction-bad-field', 'anchor size must be a [along, across] pair of finite numbers', where));
    return undefined;
  }
  let pads: AnchorPad[] | undefined;
  if (value['pads'] !== undefined) {
    const raw = value['pads'];
    if (!Array.isArray(raw) || raw.length === 0) {
      issues.push(issue('depiction-bad-field', 'anchor pads must be a non-empty array', where));
      return undefined;
    }
    pads = [];
    for (const [i, pad] of raw.entries()) {
      if (
        !isRecord(pad) ||
        !nonEmptyString(pad['ref']) ||
        typeof pad['pad'] !== 'string' ||
        !isFiniteNumber(pad['x']) ||
        !isFiniteNumber(pad['y']) ||
        !isAnchorSide(pad['side']) ||
        (pad['approach'] !== undefined && !isFiniteNumber(pad['approach'])) ||
        (pad['size'] !== undefined && !isSizePair(pad['size']))
      ) {
        issues.push(
          issue(
            'depiction-bad-field',
            `anchor pads[${i}] must be { ref, pad, x, y, side: ${ANCHOR_SIDES.join(' | ')}, approach?: number, size?: [number, number] }`,
            where,
          ),
        );
        return undefined;
      }
      pads.push({
        ref: pad['ref'] as string,
        pad: pad['pad'] as string,
        x: pad['x'] as number,
        y: pad['y'] as number,
        side: pad['side'] as AnchorSide,
        ...(pad['approach'] === undefined ? {} : { approach: pad['approach'] as number }),
        ...(pad['size'] === undefined ? {} : { size: pad['size'] as [number, number] }),
      });
    }
    const primary = pads[0];
    const approachMatches = primary?.approach === (value['approach'] as number | undefined);
    const primarySize = primary?.size;
    const declaredSize = value['size'] as [number, number] | undefined;
    const sizeMatches =
      primarySize === undefined
        ? declaredSize === undefined
        : declaredSize !== undefined && primarySize[0] === declaredSize[0] && primarySize[1] === declaredSize[1];
    if (
      primary !== undefined &&
      (primary.x !== value['x'] ||
        primary.y !== value['y'] ||
        primary.side !== value['side'] ||
        !approachMatches ||
        !sizeMatches)
    ) {
      issues.push(
        issue(
          'anchor-primary-mismatch',
          'anchor x/y/side/approach/size must repeat its primary pad (pads[0])',
          where,
        ),
      );
      return undefined;
    }
  }
  return {
    x: value['x'] as number,
    y: value['y'] as number,
    ...(value['note'] === undefined ? {} : { note: value['note'] as string }),
    ...(value['side'] === undefined ? {} : { side: value['side'] as AnchorSide }),
    ...(value['approach'] === undefined ? {} : { approach: value['approach'] as number }),
    ...(value['size'] === undefined ? {} : { size: value['size'] as [number, number] }),
    ...(pads === undefined ? {} : { pads }),
  };
}

function isAnchorSide(value: unknown): value is AnchorSide {
  return typeof value === 'string' && (ANCHOR_SIDES as readonly string[]).includes(value);
}

/** `[along, across]` — a pad's `size`: two finite numbers. */
function isSizePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function parseSources(
  value: unknown,
  where: string,
  issues: Issue[],
): DepictionSourceFile[] | undefined {
  if (value === undefined) return undefined;
  const bad = (): undefined => {
    issues.push(
      issue('depiction-bad-field', 'sources must be an array of { role, path, sha256 }', where),
    );
    return undefined;
  };
  if (!Array.isArray(value)) return bad();
  const out: DepictionSourceFile[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry['role']) ||
      !nonEmptyString(entry['path']) ||
      typeof entry['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry['sha256'])
    ) {
      return bad();
    }
    out.push({
      role: entry['role'] as string,
      path: entry['path'] as string,
      sha256: entry['sha256'] as string,
    });
  }
  return out;
}

function isPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

function parsePartPackage(value: unknown): PartPackage | undefined | false {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const { family, pins, pitch } = value;
  if (
    typeof family !== 'string' ||
    !(PART_PACKAGE_FAMILIES as readonly string[]).includes(family) ||
    (pins !== undefined && !isFiniteNumber(pins)) ||
    (pitch !== undefined && !isFiniteNumber(pitch))
  ) {
    return false;
  }
  return {
    family: family as PartPackageFamily,
    ...(pins === undefined ? {} : { pins }),
    ...(pitch === undefined ? {} : { pitch }),
  };
}

function parseBoardPart(value: unknown): BoardPart | undefined {
  if (!isRecord(value)) return undefined;
  const {
    ref,
    kind,
    side,
    state,
    value: partValue,
    label,
    x,
    y,
    rotation,
    outline,
    pin1,
    package: pkgRaw,
    pads: padsRaw,
  } = value;
  const pkg = parsePartPackage(pkgRaw);
  const pads = parsePartPads(padsRaw);
  if (
    !nonEmptyString(ref) ||
    typeof kind !== 'string' ||
    !(BOARD_PART_KINDS as readonly string[]).includes(kind) ||
    (side !== 'top' && side !== 'bottom') ||
    typeof state !== 'string' ||
    !(BOARD_PART_STATES as readonly string[]).includes(state) ||
    (partValue !== undefined && typeof partValue !== 'string') ||
    (label !== undefined && typeof label !== 'string') ||
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(rotation) ||
    !Array.isArray(outline) ||
    outline.length < 3 ||
    !outline.every(isPoint) ||
    (pin1 !== undefined && !isPoint(pin1)) ||
    pkg === false ||
    pads === false
  ) {
    return undefined;
  }
  return {
    ref,
    kind: kind as BoardPartKind,
    side,
    state: state as BoardPartState,
    ...(partValue === undefined ? {} : { value: partValue }),
    ...(label === undefined ? {} : { label }),
    x,
    y,
    rotation,
    outline: (outline as [number, number][]).map(([px, py]) => [px, py]),
    ...(pin1 === undefined ? {} : { pin1: [pin1[0], pin1[1]] as [number, number] }),
    ...(pkg === undefined ? {} : { package: pkg }),
    ...(pads === undefined ? {} : { pads }),
  };
}

function parsePartPads(value: unknown): PartPad[] | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return false;
  const out: PartPad[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['pad'] !== 'string' || !isFiniteNumber(entry['x']) || !isFiniteNumber(entry['y'])) return false;
    out.push({ pad: entry['pad'], x: entry['x'], y: entry['y'] });
  }
  return out;
}

function parseComponents(value: unknown, where: string, issues: Issue[]): BoardComponents | undefined {
  if (value === undefined) return undefined;
  const bad = (detail: string): undefined => {
    issues.push(issue('depiction-bad-field', `components ${detail}`, where));
    return undefined;
  };
  if (!isRecord(value)) return bad('must be an object');
  const { build, basis, parts, src } = value;
  if (!nonEmptyString(build)) return bad('build must be a non-empty string');
  if (basis !== 'placement-file' && basis !== 'as-designed') return bad('basis must be placement-file or as-designed');
  if (!nonEmptyString(src)) return bad('has no src citation');
  if (!Array.isArray(parts)) return bad('parts must be an array');
  const out: BoardPart[] = [];
  for (const [i, raw] of parts.entries()) {
    const part = parseBoardPart(raw);
    if (part === undefined) return bad(`parts[${i}] is not a { ref, kind, side, state, x, y, rotation, outline } part`);
    out.push(part);
  }
  return { build, basis, parts: out, src };
}

/**
 * `entryGuides` — shared with the kicad-map loader, so
 * the reviewed input and the manifest copy are held to one shape.
 */
export function parseEntryGuides(value: unknown, where: string, issues: Issue[]): EntryGuide[] | undefined {
  if (value === undefined) return undefined;
  const bad = (detail: string): undefined => {
    issues.push(issue('depiction-bad-field', `entryGuides ${detail}`, where));
    return undefined;
  };
  if (!Array.isArray(value)) return bad('must be an array');
  const out: EntryGuide[] = [];
  for (const [i, raw] of value.entries()) {
    if (!isRecord(raw)) return bad(`[${i}] must be an object`);
    const { side, pads, from, to, src } = raw;
    if (side !== 'top' && side !== 'bottom') return bad(`[${i}].side must be top or bottom`);
    if (!Array.isArray(pads) || pads.length === 0 || !pads.every(nonEmptyString)) {
      return bad(`[${i}].pads must be a non-empty list of footprint refs`);
    }
    if (!isPoint(from) || !isPoint(to)) return bad(`[${i}].from/to must be [x, y] points`);
    if (from[0] === to[0] && from[1] === to[1]) return bad(`[${i}] has zero length`);
    if (!nonEmptyString(src)) return bad(`[${i}] has no src (who set it, when)`);
    out.push({ side, pads: [...(pads as string[])], from: [from[0], from[1]], to: [to[0], to[1]], src });
  }
  return out;
}

/** Turn unknown JSON into a `DepictionMeta`, reporting every shape problem. */
export function parseDepictionMeta(value: unknown, where: string): ParsedDepiction {
  const issues: Issue[] = [];
  if (!isRecord(value)) {
    issues.push(issue('depiction-not-an-object', 'meta.json is not a JSON object', where));
    return { issues };
  }

  let ok = true;
  if (!nonEmptyString(value['defId'])) {
    issues.push(issue('depiction-missing-field', 'defId must be a non-empty string', where));
    ok = false;
  }
  if (!nonEmptyString(value['src'])) {
    issues.push(issue('missing-src', 'depiction has no src citation', where));
    ok = false;
  }
  if (!isRecord(value['views']) || Object.keys(value['views']).length === 0) {
    issues.push(issue('depiction-missing-field', 'views must be a non-empty object', where));
    ok = false;
  }
  if (!isRecord(value['pinAnchors'])) {
    issues.push(issue('depiction-missing-field', 'pinAnchors must be an object', where));
    ok = false;
  }
  if (!nonEmptyString(value['anchorFrame'])) {
    issues.push(issue('depiction-missing-field', 'anchorFrame must name a view', where));
    ok = false;
  }
  if (!ok) return { issues };

  const views: Record<string, DepictionAsset> = {};
  for (const name of Object.keys(value['views'] as Record<string, unknown>).sort()) {
    const asset = parseAsset(
      (value['views'] as Record<string, unknown>)[name],
      `${where} views/${name}`,
      issues,
    );
    if (asset !== undefined) views[name] = asset;
  }

  const pinAnchors: Record<string, PinAnchor> = {};
  for (const id of Object.keys(value['pinAnchors'] as Record<string, unknown>).sort()) {
    const anchor = parseAnchor(
      (value['pinAnchors'] as Record<string, unknown>)[id],
      `${where} pinAnchors/${id}`,
      issues,
    );
    if (anchor !== undefined) pinAnchors[id] = anchor;
  }

  const sources = parseSources(value['sources'], where, issues);
  const components = parseComponents(value['components'], where, issues);
  const color = parseColor(value['color'], where, issues);
  const entryGuides = parseEntryGuides(value['entryGuides'], where, issues);

  const meta: DepictionMeta = {
    defId: value['defId'] as string,
    views,
    pinAnchors,
    anchorFrame: value['anchorFrame'] as DepictionView,
    ...(sources === undefined ? {} : { sources }),
    ...(components === undefined ? {} : { components }),
    ...(color === undefined ? {} : { color }),
    ...(entryGuides === undefined ? {} : { entryGuides }),
    src: value['src'] as string,
  };
  return { meta, issues };
}

/* ------------------------------------------------------------------ *
 * Referential validation
 * ------------------------------------------------------------------ */

export interface DepictionValidationOptions {
  /**
   * Directory holding this depiction's files. When given, every view's `file`
   * is checked to exist on disk.
   */
  dir?: string;
  /**
   * Definition bundle. When given, anchor ids are checked against the
   * definition `defId` names — a PCBA's pads and integrated-connector pins, a
   * connector's pins, a component's terminals.
   */
  db?: Db;
}

const VECTOR_EXTENSIONS = ['.svg'];
const RASTER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * Terminal ids the definition `defId` exposes, or `undefined` when the catalog
 * has no definition under that id (a depiction may legitimately land before
 * its definition does).
 */
export function definitionTerminalIds(db: Db, defId: string): string[] | undefined {
  return definitionTerminals(db, defId)?.flatMap((t) => [t.id, ...t.aliases]);
}

/**
 * The definition's terminals as solder points: one entry per pin, pad or
 * terminal, with the other names it answers to. A connector pin with aliases
 * is **one** point — anchoring it under any of its
 * names anchors it. `undefined` as for `definitionTerminalIds`.
 */
export function definitionTerminals(db: Db, defId: string): { id: string; aliases: string[] }[] | undefined {
  const pcba = findPcba(db, defId);
  if (pcba !== undefined) return pcbaTerminalIds(pcba, db).map((id) => ({ id, aliases: [] }));
  const connector = findConnector(db, defId);
  if (connector !== undefined) return connector.pins.map((pin) => ({ id: pin.id, aliases: [...(pin.aliases ?? [])] }));
  const component = findComponent(db, defId);
  if (component !== undefined) return component.terminals.map((t) => ({ id: t.id, aliases: [] }));
  // a body: the art of a physical part, anchored on its positions (one face serves every pinout on it)
  const body = (db.bodies ?? []).find((item) => item.id === defId);
  if (body !== undefined) return body.positions.map((p) => ({ id: p.id, aliases: [] }));
  // a wire stock's illustration (a cutaway) anchors nothing
  if (findWire(db, defId) !== undefined) return [];
  return undefined;
}

/**
 * `definitionTerminals` in the shape the importers take: the solder points'
 * own ids, and the other names each answers to (only the ones that have any).
 */
export function expectedTerminals(db: Db, defId: string): { expectedIds: string[]; expectedAliases: Record<string, string[]> } | undefined {
  const terminals = definitionTerminals(db, defId);
  if (terminals === undefined) return undefined;
  return {
    expectedIds: terminals.map((t) => t.id),
    expectedAliases: Object.fromEntries(terminals.filter((t) => t.aliases.length > 0).map((t) => [t.id, t.aliases])),
  };
}

/** Referential checks over one already-parsed depiction. */
export function validateDepiction(
  meta: DepictionMeta,
  options: DepictionValidationOptions = {},
): Issue[] {
  const issues: Issue[] = [];
  const where = `depictions/${meta.defId}`;

  /* --- views ------------------------------------------------------- */
  for (const name of Object.keys(meta.views)) {
    const asset = meta.views[name];
    if (asset === undefined) continue;
    const viewWhere = `${where}/${name}`;

    if (!isDepictionView(name)) {
      issues.push(
        issue(
          'unknown-view-kind',
          `view '${name}' is not one of ${DEPICTION_VIEWS.join(' | ')}`,
          viewWhere,
        ),
      );
    }

    if (asset.file.includes('/') || asset.file.includes('\\') || asset.file.includes('..')) {
      issues.push(
        issue(
          'unsafe-asset-path',
          `view '${name}' file '${asset.file}' must be a plain file name inside the depiction directory`,
          viewWhere,
        ),
      );
    } else if (options.dir !== undefined && !existsSync(join(options.dir, asset.file))) {
      issues.push(
        issue('missing-asset-file', `view '${name}' file '${asset.file}' does not exist`, viewWhere),
      );
    }

    const lower = asset.file.toLowerCase();
    const expected: AssetKind | undefined = VECTOR_EXTENSIONS.some((e) => lower.endsWith(e))
      ? 'vector'
      : RASTER_EXTENSIONS.some((e) => lower.endsWith(e))
        ? 'raster'
        : undefined;
    if (expected !== undefined && expected !== asset.kind) {
      issues.push(
        issue(
          'asset-kind-mismatch',
          `view '${name}' is declared '${asset.kind}' but '${asset.file}' looks like ${expected} art`,
          viewWhere,
          'warning',
        ),
      );
    }

    if (asset.mirrorOf === undefined) continue;
    if (asset.mirrorOf === name) {
      issues.push(issue('self-mirror', `view '${name}' mirrors itself`, viewWhere));
      continue;
    }
    const source = meta.views[asset.mirrorOf];
    if (source === undefined) {
      issues.push(
        issue(
          'unknown-mirror-view',
          `view '${name}' mirrors '${asset.mirrorOf}', which this depiction does not have`,
          viewWhere,
        ),
      );
      continue;
    }
    if (source.mirrorOf !== undefined) {
      issues.push(
        issue(
          'mirror-chain',
          `view '${name}' mirrors '${asset.mirrorOf}', which is itself a mirror — anchors must reflect from a real frame`,
          viewWhere,
        ),
      );
    }
    if (
      (asset.widthUnits ?? source.widthUnits) === undefined ||
      (asset.heightUnits ?? source.heightUnits) === undefined
    ) {
      issues.push(
        issue(
          'missing-mirror-frame',
          `view '${name}' mirrors '${asset.mirrorOf}' but neither declares widthUnits/heightUnits, so anchors cannot be reflected`,
          viewWhere,
        ),
      );
    }
  }

  /* --- anchor frame ------------------------------------------------ */
  const frame = meta.views[meta.anchorFrame];
  if (frame === undefined) {
    issues.push(
      issue(
        'unknown-anchor-frame',
        `anchorFrame '${meta.anchorFrame}' is not one of this depiction's views`,
        where,
      ),
    );
  } else if (frame.mirrorOf !== undefined) {
    issues.push(
      issue(
        'mirrored-anchor-frame',
        `anchorFrame '${meta.anchorFrame}' is a mirrored view — anchors must be authored in a real frame and reflected outward`,
        where,
      ),
    );
  }

  /* --- anchors vs the definition ----------------------------------- */
  if (options.db !== undefined) {
    const terminals = definitionTerminals(options.db, meta.defId);
    const known = terminals?.flatMap((t) => [t.id, ...t.aliases]);
    if (terminals === undefined || known === undefined) {
      issues.push(
        issue(
          'unknown-depiction-def',
          `no connector, component or PCBA definition '${meta.defId}' in the catalog — anchor ids cannot be checked`,
          where,
          'warning',
        ),
      );
    } else {
      const set = new Set(known);
      for (const id of Object.keys(meta.pinAnchors)) {
        if (set.has(id)) continue;
        issues.push(
          issue(
            'unknown-pin-anchor',
            `anchor '${id}' is not a pin, pad or terminal of definition '${meta.defId}'`,
            where,
          ),
        );
      }
      // one to-do per solder point: an aliased pin anchored under any name is done
      const missing = terminals
        .filter((t) => [t.id, ...t.aliases].every((name) => meta.pinAnchors[name] === undefined))
        .map((t) => t.id);
      if (missing.length > 0) {
        issues.push(
          issue(
            'unanchored-pin',
            `definition '${meta.defId}' has ${missing.length} terminal(s) with no anchor (${missing
              .slice(0, 8)
              .join(', ')}${missing.length > 8 ? ', …' : ''}) — the renderer falls back to the abstract block for instances that use them`,
            where,
            'warning',
          ),
        );
      }
    }
  }

  return issues;
}
