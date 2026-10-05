/**
 * The artwork half of the workbench API — upload a depiction, anchor its pins.
 *
 * Same shape as `api.ts`: `handleDepictionRequest` is a pure function of
 * `(request, deps)`, the filesystem sits behind a `DepictionStore`, and the
 * only code below that knows about a socket is the small middleware at the
 * bottom. It is a *separate* module rather than more routes in `api.ts` for one
 * reason: these endpoints carry **bytes**. An upload is a multipart body and a
 * GET of an asset answers `image/png`, neither of which the JSON transport in
 * `plugin.ts` can express without becoming a different thing.
 *
 * The rules this file is responsible for (specs/depictions.md):
 *
 * 1. **The normalisation is the importer's, not ours.** Every upload goes
 *    through `prepareDepictionImport` — the exact function `import-depiction`
 *    runs — so a file dropped on the GUI and the same file passed to the CLI
 *    produce byte-identical artwork and the same `meta.json` merge. A format
 *    the ladder refuses is refused here with the ladder's own words.
 * 2. **Mirrored views are derived, never authored.** `solder-side` and
 *    `board-bottom` declare `mirrorOf` and get their anchors by reflection.
 *    An anchor write naming a mirrored frame is refused: a human mirroring a
 *    pinout by eye is the classic wiring error, and the tool owns that flip.
 * 3. **Anchors are validated before they are written.** The candidate manifest
 *    runs through `parseDepictionMeta` + `validateDepiction` against the live
 *    definition library; an anchor naming something that is not a terminal of
 *    the definition comes back as the validator's own issue list, and nothing
 *    touches disk.
 * 4. **An id is a slug, never a path**, and a stored asset is always named
 *    after its view — the request never chooses a file name at all.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { installedPackSources, livePacksDir, loadDb, loadDesigns } from '@wirehub/catalog';
import {
  ANCHOR_SIDES,
  DEPICTION_VIEWS,
  SOURCE_KINDS,
  anchorsFor,
  definitionTerminalIds,
  definitionTerminals,
  expectedTerminals,
  depictionsRoot,
  isDepictionView,
  parseDepictionMeta,
  parseEntryGuides,
  prepareDepictionImport,
  validateDepiction,
  type AnchorPad,
  type AnchorSide,
  type DepictionView,
  type ImportVoice,
  type MirrorAxis,
  type SourceKind,
} from '@wirehub/catalog/src/depictions/index.ts';
import {
  designInstances,
  errors,
  findComponent,
  findConnector,
  findPcba,
  type CableDesign,
  type Db,
  type Issue,
} from '@wirehub/model';
import { writeFileAtomic } from './atomic-write.ts';
import { boardArtFiles, relinkWithArt } from './models/board-art.ts';
import { fileModelLinkStore, type ModelLinkStore } from './models/links.ts';

/* ------------------------------------------------------------------ *
 * Transport-shaped, transport-free
 * ------------------------------------------------------------------ */

export interface DepictionApiRequest {
  method: string;
  /** the path as requested, `/api` prefix included */
  path: string;
  /** `content-type`, verbatim — it carries the multipart boundary */
  contentType?: string;
  /** the body as bytes; JSON bodies are parsed from these */
  raw?: Uint8Array;
}

export type DepictionApiResponse =
  | { status: number; body: unknown }
  | { status: number; bytes: Uint8Array; contentType: string };

export interface DepictionDeps {
  store: DepictionStore;
  /** the definition library anchors are checked against, re-read per request */
  loadDb: () => Awaitable<Db>;
  /**
   * The catalog's designs, re-read per request: the detail says which
   * terminals cables actually solder to. Absent = the
   * detail carries no `usedBy`, and the Artwork tab counts every terminal.
   */
  loadDesigns?: () => Awaitable<CableDesign[]>;
  /**
   * Run a write in one unit of work (B7): artwork, manifest and board map
   * are staged and commit as one change set. Absent: writes go straight to
   * the store (the Vite dev server, tests).
   */
  transact?: (run: (deps: DepictionDeps) => Promise<DepictionApiResponse>) => Promise<DepictionApiResponse>;
  /**
   * The Library's model links. When a board's art is written, its
   * `pcbas/<id>` link is re-keyed so the model cache rebuilds with the new
   * art (cs-h8p). In a unit of work the staged store is passed here.
   */
  modelLinks?: ModelLinkStore;
}

/**
 * Terminal → the designs that solder to it on an instance of `defId`.
 * An alias a joint names is counted under its
 * terminal's id, since that is the id the Artwork checklist lists.
 */
export function usedTerminals(
  designs: readonly CableDesign[],
  defId: string,
  terminals: readonly { id: string; aliases?: readonly string[] }[] = [],
): Record<string, string[]> {
  const canonical = new Map<string, string>();
  for (const t of terminals) for (const name of [t.id, ...(t.aliases ?? [])]) canonical.set(name, t.id);
  const out: Record<string, string[]> = {};
  for (const design of designs) {
    const ids = new Set(designInstances(design).filter((i) => i.def === defId).map((i) => i.id));
    if (ids.size === 0) continue;
    for (const joint of design.joints) {
      for (const end of [joint.a, joint.b]) {
        if (!ids.has(end.instance)) continue;
        const id = canonical.get(end.terminal) ?? end.terminal;
        const list = (out[id] ??= []);
        if (!list.includes(design.id)) list.push(design.id);
      }
    }
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

function fail(
  status: number,
  error: string,
  hint?: string,
  extra?: { issues?: Issue[]; guidance?: string[] },
): DepictionApiResponse {
  return {
    status,
    body: {
      error,
      ...(hint === undefined ? {} : { hint }),
      ...(extra?.issues === undefined ? {} : { issues: extra.issues }),
      ...(extra?.guidance === undefined ? {} : { guidance: extra.guidance }),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */

const ID_RULE =
  'Ids are lowercase words joined by hyphens, like `PCA-00001-rev2` — no spaces, capitals, dots or slashes.';

/**
 * The id rule, matching the design store's. A definition id becomes a
 * *directory* name here, so this is the lock on the door: `..`, `/`, `\`, a
 * leading dot and a percent-escape that decodes to any of them all fail it.
 */
export function isDepictionDefId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

/**
 * The one place a definition id becomes a directory path, and the one place an
 * asset file name is joined to it. Throws rather than returning something a
 * caller might use anyway.
 */
export function depictionPaths(
  defId: string,
  root: string,
): { dir: string; meta: string; asset: (file: string) => string } {
  if (!isDepictionDefId(defId)) throw new Error(`'${defId}' is not a usable definition id`);
  const dir = join(root, defId);
  return {
    dir,
    meta: join(dir, 'meta.json'),
    asset: (file: string): string => {
      // a stored asset is always `<view><ext>`, composed here — but a manifest
      // read off disk may say anything, and this is what stops it
      if (file === '' || file.includes('/') || file.includes('\\') || file.includes('..')) {
        throw new Error(`'${file}' is not a usable asset file name`);
      }
      return join(dir, file);
    },
  };
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

/**
 * The persistence the handlers are written against — the same split `api.ts`
 * uses, and for the same reason: the router never imports `node:fs`, so the
 * whole surface is testable against a `Map`.
 */
export interface DepictionStore {
  /** definition ids that have a depiction directory, sorted */
  listDefIds(): Awaitable<string[]>;
  /** the raw `meta.json` record, or `undefined` when there is none */
  readMeta(defId: string): Awaitable<Record<string, unknown> | undefined>;
  /** writes `meta.json` as 2-space JSON with a trailing newline */
  writeMeta(defId: string, meta: Record<string, unknown>): Awaitable<void>;
  readAsset(defId: string, file: string): Awaitable<Uint8Array | undefined>;
  writeAsset(defId: string, file: string, content: string | Uint8Array): Awaitable<void>;
  /** removes a file (`meta.json` too); absent is fine. Optional: a store that cannot remove leaves a disabled pack's files. */
  removeAsset?(defId: string, file: string): Awaitable<void>;
  /**
   * The directory `validateDepiction` should check asset files in, or
   * `undefined` when the store has no directory to offer (an in-memory one).
   */
  dirFor(defId: string): string | undefined;
  /**
   * The reviewed `data/kicad-maps/<defId>.json` a gerber board is generated
   * from — the hand-authored input its entry guides live in.
   * Optional: a store without maps cannot save guides.
   */
  readBoardMap?(defId: string): Awaitable<Record<string, unknown> | undefined>;
  writeBoardMap?(defId: string, map: Record<string, unknown>): Awaitable<void>;
}

/** The canonical on-disk form of a manifest: 2-space JSON, trailing newline. */
export function formatMetaJson(meta: Record<string, unknown>): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/** The roots of the installed packs' layers (`<packs>/<id>/`), the catalog's own first: where a pack's depictions and board maps are. */
function packLayerRoots(): string[] {
  const packs = livePacksDir();
  return packs === undefined ? [] : installedPackSources(packs).flatMap((source) => (source.root === undefined ? [] : [source.root]));
}

/**
 * The depictions of the catalog (`root`, default the live one) **with the installed packs' under them**: reads see the
 * catalog's own definition first, then the packs' (a pack's face, its manifest, its reviewed board map), as the database
 * backend's snapshot does; writes go to the catalog's own directory only. An explicit `root` (a test's) is read alone.
 */
export function fileDepictionStore(rootArg?: string): DepictionStore {
  const root = rootArg ?? depictionsRoot();
  const layers = (): string[] => (rootArg === undefined ? packLayerRoots() : []);
  // the reviewed kicad-maps sit beside the depictions, in the catalog's data
  const maps = join(root, '..', 'data', 'kicad-maps');
  /** a pack's own copy of `<root-relative>`, the first layer that has it */
  const inPacks = (relative: string): string | undefined => layers().map((dir) => join(dir, relative)).find((path) => existsSync(path));
  const mapPath = (defId: string): string => {
    if (!isDepictionDefId(defId)) throw new Error(`'${defId}' is not a usable definition id`);
    return join(maps, `${defId}.json`);
  };
  return {
    readBoardMap(defId): Record<string, unknown> | undefined {
      mapPath(defId);
      const path = existsSync(mapPath(defId)) ? mapPath(defId) : inPacks(`kicad-maps/${defId}.json`);
      if (path === undefined) return undefined;
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    },

    writeBoardMap(defId, map): void {
      writeFileAtomic(mapPath(defId), formatMetaJson(map), 'utf8');
    },

    listDefIds(): string[] {
      const ids = new Set<string>();
      for (const dir of [root, ...layers().map((layer) => join(layer, 'depictions'))]) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && isDepictionDefId(entry.name) && existsSync(join(dir, entry.name, 'meta.json'))) ids.add(entry.name);
        }
      }
      return [...ids].sort();
    },

    readMeta(defId): Record<string, unknown> | undefined {
      const own = depictionPaths(defId, root).meta;
      const path = existsSync(own) ? own : inPacks(`depictions/${defId}/meta.json`);
      if (path === undefined) return undefined;
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      } catch {
        // an unparseable manifest is reported by the handler as "no manifest
        // the studio can read", never as an exception out of the store
        return undefined;
      }
    },

    writeMeta(defId, meta): void {
      const paths = depictionPaths(defId, root);
      mkdirSync(paths.dir, { recursive: true });
      writeFileAtomic(paths.meta, formatMetaJson(meta), 'utf8');
    },

    readAsset(defId, file): Uint8Array | undefined {
      let path: string;
      try {
        path = depictionPaths(defId, root).asset(file);
      } catch {
        return undefined;
      }
      if (existsSync(path)) return new Uint8Array(readFileSync(path));
      const packed = inPacks(`depictions/${defId}/${file}`);
      return packed === undefined ? undefined : new Uint8Array(readFileSync(packed));
    },

    writeAsset(defId, file, content): void {
      const paths = depictionPaths(defId, root);
      mkdirSync(paths.dir, { recursive: true });
      writeFileAtomic(
        paths.asset(file),
        typeof content === 'string' ? content : Buffer.from(content),
      );
    },

    removeAsset(defId, file): void {
      const paths = depictionPaths(defId, root);
      rmSync(file === 'meta.json' ? paths.meta : paths.asset(file), { force: true });
      // an emptied directory goes too: a definition id with no files is no depiction
      if (existsSync(paths.dir) && readdirSync(paths.dir).length === 0) rmSync(paths.dir, { recursive: true, force: true });
    },

    dirFor(defId): string | undefined {
      return depictionPaths(defId, root).dir;
    },
  };
}

export function defaultDepictionDeps(): DepictionDeps {
  return { store: fileDepictionStore(), loadDb, loadDesigns, modelLinks: fileModelLinkStore() };
}

/** Art changed for `defId`: re-key its `pcbas/<id>` model link (a no-op without a link built from sources, or when the art is the same). */
async function rekeyModelLink(deps: DepictionDeps, defId: string): Promise<void> {
  const links = deps.modelLinks;
  if (links === undefined) return;
  const link = await links.get(`pcbas/${defId}`);
  if (link === undefined) return;
  const next = relinkWithArt(link, await boardArtFiles(deps.store, defId));
  if (next !== undefined) await links.put(next);
}

/* ------------------------------------------------------------------ *
 * Bodies
 * ------------------------------------------------------------------ */

const CRLF = [0x0d, 0x0a];

function indexOfBytes(haystack: Uint8Array, needle: readonly number[], from: number): number {
  outer: for (let at = from; at + needle.length <= haystack.length; at += 1) {
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[at + i] !== needle[i]) continue outer;
    }
    return at;
  }
  return -1;
}

export interface UploadPart {
  /** the form field name */
  name: string;
  /** the client's own file name, when the part was a file */
  fileName?: string;
  bytes: Uint8Array;
}

/**
 * `multipart/form-data`, parsed over bytes.
 *
 * Written by hand because the studio's dev server carries no body parser and
 * this package tree adds dependencies grudgingly. It is deliberately strict:
 * anything it cannot make sense of comes back `undefined` and the caller says
 * so, rather than half-reading an upload.
 */
export function parseMultipart(
  raw: Uint8Array,
  boundary: string,
): UploadPart[] | undefined {
  if (boundary === '') return undefined;
  const marker = [...`--${boundary}`].map((c) => c.charCodeAt(0));
  const parts: UploadPart[] = [];
  let at = indexOfBytes(raw, marker, 0);
  if (at === -1) return undefined;
  at += marker.length;

  while (at < raw.length) {
    // `--` right after the boundary is the terminator
    if (raw[at] === 0x2d && raw[at + 1] === 0x2d) break;
    // skip the CRLF that follows the boundary line
    if (raw[at] === 0x0d && raw[at + 1] === 0x0a) at += 2;
    else if (raw[at] === 0x0a) at += 1;

    const headerEnd = indexOfBytes(raw, [0x0d, 0x0a, 0x0d, 0x0a], at);
    if (headerEnd === -1) return undefined;
    const headerText = new TextDecoder().decode(raw.subarray(at, headerEnd));
    const bodyStart = headerEnd + 4;

    const next = indexOfBytes(raw, marker, bodyStart);
    if (next === -1) return undefined;
    // the boundary is preceded by its own CRLF, which is framing, not content
    let bodyEnd = next;
    if (raw[bodyEnd - 2] === CRLF[0] && raw[bodyEnd - 1] === CRLF[1]) bodyEnd -= 2;

    const disposition = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    const fileName = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    if (name !== undefined) {
      parts.push({
        name,
        ...(fileName === undefined || fileName === '' ? {} : { fileName }),
        bytes: raw.subarray(bodyStart, bodyEnd),
      });
    }
    at = next + marker.length;
  }
  return parts;
}

/** Base64 → bytes, without assuming a browser or a Buffer at the call site. */
function fromBase64(value: string): Uint8Array | undefined {
  const cleaned = value.includes(',') && value.startsWith('data:')
    ? value.slice(value.indexOf(',') + 1)
    : value;
  try {
    return new Uint8Array(Buffer.from(cleaned, 'base64'));
  } catch {
    return undefined;
  }
}

/** What an upload request says, however it was encoded. */
export interface UploadInput {
  fileName: string;
  bytes: Uint8Array;
  fields: Record<string, string>;
}

/**
 * Read an upload out of either encoding: a browser `FormData` (multipart) or a
 * plain JSON body carrying base64 (`{ fileName, data }`), which is what a
 * script or a `curl` round-trip reaches for.
 */
export function readUploadBody(
  contentType: string | undefined,
  raw: Uint8Array | undefined,
): { ok: true; input: UploadInput } | { ok: false; response: DepictionApiResponse } {
  const no = (error: string, hint: string): { ok: false; response: DepictionApiResponse } => ({
    ok: false,
    response: fail(400, error, hint),
  });
  if (raw === undefined || raw.length === 0) {
    return no('That upload arrived with no file in it.', 'Choose a file and try again.');
  }

  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('multipart/form-data')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType ?? '')?.[1] ?? '';
    const parts = parseMultipart(raw, boundary);
    if (parts === undefined) {
      return no(
        'The studio could not read that upload.',
        'Nothing was written. Try the file picker instead of dragging, or reload the page and retry.',
      );
    }
    const file = parts.find((part) => part.fileName !== undefined);
    if (file === undefined) {
      return no(
        'That upload carried form fields but no file.',
        'Choose an SVG, PNG or JPEG and try again.',
      );
    }
    const fields: Record<string, string> = {};
    for (const part of parts) {
      if (part.fileName === undefined) fields[part.name] = new TextDecoder().decode(part.bytes);
    }
    return { ok: true, input: { fileName: file.fileName ?? 'upload', bytes: file.bytes, fields } };
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return no(
      'The studio could not read what was sent with that upload.',
      'Send the file as a form upload, or as JSON with { "fileName": …, "data": "<base64>" }.',
    );
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return no(
      'That upload is not a file.',
      'Send JSON with { "fileName": …, "data": "<base64>" }, or use the studio\'s upload box.',
    );
  }
  const record = body as Record<string, unknown>;
  const fileName = record['fileName'];
  const data = record['data'];
  if (typeof fileName !== 'string' || fileName === '') {
    return no(
      'That upload does not say what the file is called.',
      'The file name carries the format — send { "fileName": "board.svg", "data": "<base64>" }.',
    );
  }
  if (typeof data !== 'string' || data === '') {
    return no('That upload has no file contents.', 'Send the bytes as base64 in "data".');
  }
  const bytes = fromBase64(data);
  if (bytes === undefined || bytes.length === 0) {
    return no('That upload\'s contents are not readable base64.', 'Re-encode the file and retry.');
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'fileName' || key === 'data') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = String(value);
    }
  }
  return { ok: true, input: { fileName, bytes, fields } };
}

/* ------------------------------------------------------------------ *
 * The definition side
 * ------------------------------------------------------------------ */

/** One anchorable thing on a definition, as the checklist shows it. */
export interface TerminalSummary {
  id: string;
  label?: string;
  /** other ids the same physical pin answers to; anchoring one is enough */
  aliases?: string[];
}

export interface DefinitionSummary {
  kind: 'connector' | 'component' | 'pcba';
  id: string;
  label: string;
  terminals: TerminalSummary[];
}

/**
 * The definition a depiction claims, as the anchoring checklist needs it:
 * every terminal in declaration order, with its human label, and aliases kept
 * *beside* the primary id rather than listed as separate to-dos — a SCART pin
 * with three names is one solder point, not three.
 */
export function describeDefinition(db: Db, defId: string): DefinitionSummary | undefined {
  const connector = findConnector(db, defId);
  if (connector !== undefined) {
    return {
      kind: 'connector',
      id: connector.id,
      label: connector.label,
      terminals: connector.pins.map((pin) => ({
        id: pin.id,
        label: pin.label,
        ...(pin.aliases === undefined || pin.aliases.length === 0 ? {} : { aliases: pin.aliases }),
      })),
    };
  }
  const component = findComponent(db, defId);
  if (component !== undefined) {
    return {
      kind: 'component',
      id: component.id,
      label: component.label,
      terminals: component.terminals.map((terminal) => ({
        id: terminal.id,
        ...(terminal.label === undefined ? {} : { label: terminal.label }),
      })),
    };
  }
  const pcba = findPcba(db, defId);
  if (pcba !== undefined) {
    const terminals: TerminalSummary[] = pcba.terminals.map((terminal) => ({
      id: terminal.id,
      ...(terminal.label === undefined ? {} : { label: terminal.label }),
    }));
    for (const integrated of pcba.integratedConnectors ?? []) {
      const connectorDef = findConnector(db, integrated.connectorDefId);
      if (connectorDef === undefined) continue;
      for (const pin of connectorDef.pins) {
        terminals.push({
          id: `${integrated.terminalPrefix}.${pin.id}`,
          label: `${connectorDef.label} · ${pin.label}`,
        });
      }
    }
    return { kind: 'pcba', id: pcba.id, label: pcba.label, terminals };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** Views the GUI offers an upload box for; the mirrored ones are derived. */
export const UPLOADABLE_VIEWS: readonly DepictionView[] = [
  'schematic-symbol',
  'mating-face',
  'board-top',
  'illustration',
];

/** File extension → media type, for serving an asset back. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function mediaTypeOf(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? undefined : MEDIA_TYPES[file.slice(dot).toLowerCase()];
}

/**
 * Everything one Artwork screen needs, in one answer: the manifest, what each
 * view is (and whether it is derived), the definition's terminal checklist,
 * which of them are anchored, and the validator's current findings.
 */
async function readDepictionDetail(deps: DepictionDeps, defId: string): Promise<DepictionApiResponse> {
  const raw = await deps.store.readMeta(defId);
  const db = await deps.loadDb();
  const definition = describeDefinition(db, defId);

  if (raw === undefined) {
    return {
      status: 200,
      body: {
        defId,
        exists: false,
        views: [],
        pinAnchors: {},
        issues: [],
        uploadableViews: UPLOADABLE_VIEWS,
        ...(definition === undefined ? {} : { definition }),
      },
    };
  }

  const parsed = parseDepictionMeta(raw, `depictions/${defId}`);
  if (parsed.meta === undefined) {
    return {
      status: 200,
      body: {
        defId,
        exists: true,
        views: [],
        pinAnchors: {},
        issues: parsed.issues,
        uploadableViews: UPLOADABLE_VIEWS,
        ...(definition === undefined ? {} : { definition }),
      },
    };
  }

  const meta = parsed.meta;
  const dir = deps.store.dirFor(defId);
  const issues = [
    ...parsed.issues,
    ...validateDepiction(meta, { ...(dir === undefined ? {} : { dir }), db }),
  ];

  const views = Object.keys(meta.views)
    .sort()
    .map((view) => {
      const asset = meta.views[view];
      if (asset === undefined) return undefined;
      return {
        view,
        ...asset,
        derived: asset.mirrorOf !== undefined,
        /** the anchor set as it lands in this view — reflected for a mirror */
        anchors: anchorsFor(meta, view) ?? {},
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const anchored = new Set(Object.keys(meta.pinAnchors));
  const todo =
    definition === undefined
      ? []
      : definition.terminals
          .filter(
            (terminal) =>
              !anchored.has(terminal.id) &&
              !(terminal.aliases ?? []).some((alias) => anchored.has(alias)),
          )
          .map((terminal) => terminal.id);

  const usedBy = deps.loadDesigns === undefined ? undefined : usedTerminals(await deps.loadDesigns(), defId, definition?.terminals);
  return {
    status: 200,
    body: {
      defId,
      exists: true,
      meta,
      views,
      anchorFrame: meta.anchorFrame,
      pinAnchors: meta.pinAnchors,
      unanchored: todo,
      ...(usedBy === undefined ? {} : { usedBy }),
      issues,
      uploadableViews: UPLOADABLE_VIEWS,
      ...(definition === undefined ? {} : { definition }),
    },
  };
}

async function readAsset(deps: DepictionDeps, defId: string, view: string): Promise<DepictionApiResponse> {
  const raw = await deps.store.readMeta(defId);
  const parsed = raw === undefined ? undefined : parseDepictionMeta(raw, `depictions/${defId}`);
  const asset = parsed?.meta?.views[view];
  if (asset === undefined) {
    return fail(
      404,
      `'${defId}' has no ${view} artwork.`,
      'Upload a file for this view first, or pick a view the definition already has.',
    );
  }
  const bytes = await deps.store.readAsset(defId, asset.file);
  const media = mediaTypeOf(asset.file);
  if (bytes === undefined || media === undefined) {
    return fail(
      404,
      `The ${view} artwork for '${defId}' is listed in its manifest but the file is not there.`,
      'Upload the file again — the manifest and the directory have drifted apart.',
    );
  }
  return { status: 200, bytes, contentType: media };
}

/* ------------------------------------------------------------------ *
 * Uploading
 * ------------------------------------------------------------------ */

/**
 * How the citations an upload writes name their origin. The CLI's voice tells
 * a reader to "pass --src next time"; a file dropped on a web page never saw a
 * command line, and provenance that lies is worse than provenance that is thin.
 */
const STUDIO_VOICE: ImportVoice = {
  importer: "the studio's Artwork tab",
  widthOption: 'the "real width in millimetres" field',
  srcOption: 'the "where does this come from?" field',
  scaleGuidance: [
    '  Real width (mm)      the real width of the part in the picture (easiest)',
    '  Millimetres/pixel    if you would rather state the scale directly',
  ],
};

function numberField(fields: Record<string, string>, name: string): number | undefined | 'bad' {
  const raw = fields[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 'bad';
}

async function uploadDepiction(
  deps: DepictionDeps,
  defId: string,
  view: DepictionView,
  request: DepictionApiRequest,
): Promise<DepictionApiResponse> {
  const read = readUploadBody(request.contentType, request.raw);
  if (!read.ok) return read.response;
  const { fileName, bytes, fields } = read.input;

  const widthMm = numberField(fields, 'widthMm');
  const mmPerUnit = numberField(fields, 'mmPerUnit');
  if (widthMm === 'bad' || mmPerUnit === 'bad') {
    return fail(
      400,
      'The scale has to be a positive number.',
      'Nothing was written. Enter the real width of the part in millimetres, or the millimetres per pixel.',
    );
  }

  const sourceKind = fields['sourceKind'];
  if (sourceKind !== undefined && sourceKind !== '' && !(SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    return fail(
      400,
      `'${sourceKind}' is not a kind of source this studio knows.`,
      `Nothing was written. Pick one of: ${SOURCE_KINDS.join(', ')}.`,
    );
  }
  const mirrorOf = fields['mirrorOf'];
  if (mirrorOf !== undefined && mirrorOf !== '' && !isDepictionView(mirrorOf)) {
    return fail(
      400,
      `'${mirrorOf}' is not one of this tool's view kinds.`,
      `Nothing was written. Pick one of: ${DEPICTION_VIEWS.join(', ')}.`,
    );
  }
  const mirrorAxis = fields['mirrorAxis'];
  if (mirrorAxis !== undefined && mirrorAxis !== '' && mirrorAxis !== 'x' && mirrorAxis !== 'y') {
    return fail(
      400,
      `'${mirrorAxis}' is not a reflection axis.`,
      'Nothing was written. The axis is x (left↔right, what flipping a board over does) or y.',
    );
  }

  const db = await deps.loadDb();
  const expected = expectedTerminals(db, defId);

  const plan = prepareDepictionImport({
    fileName,
    bytes,
    defId,
    view,
    voice: STUDIO_VOICE,
    ...(widthMm === undefined ? {} : { widthMm }),
    ...(mmPerUnit === undefined ? {} : { mmPerUnit }),
    ...(sourceKind === undefined || sourceKind === ''
      ? {}
      : { sourceKind: sourceKind as SourceKind }),
    ...(fields['src'] === undefined || fields['src'].trim() === ''
      ? {}
      : { src: fields['src'] }),
    ...(mirrorOf === undefined || mirrorOf === '' ? {} : { mirrorOf }),
    ...(mirrorAxis === undefined || mirrorAxis === ''
      ? {}
      : { mirrorAxis: mirrorAxis as MirrorAxis }),
    ...(fields['keepStrokes'] === 'true' ? { keepStrokeWidths: true } : {}),
    ...(expected === undefined ? {} : expected),
    ...(await deps.store.readMeta(defId) === undefined
      ? {}
      : { existingMeta: await deps.store.readMeta(defId) as Record<string, unknown> }),
  });

  if (!plan.ok) {
    // the ladder's guidance is the product of a refusal, not a detail of it:
    // 415 with the words the CLI would have printed, unedited
    return fail(
      plan.reason === 'unsupported-format' ? 415 : 422,
      plan.message,
      'Nothing was written. This is deliberate — a half-working import that quietly drops geometry is worse than none.',
      { guidance: plan.guidance },
    );
  }

  await deps.store.writeAsset(defId, plan.fileName, plan.content);
  await deps.store.writeMeta(defId, plan.meta);
  await rekeyModelLink(deps, defId);

  const parsed = parseDepictionMeta(plan.meta, `depictions/${defId}`);
  const dir = deps.store.dirFor(defId);
  const issues = [
    ...parsed.issues,
    ...(parsed.meta === undefined
      ? []
      : validateDepiction(parsed.meta, { ...(dir === undefined ? {} : { dir }), db })),
  ];

  return {
    status: 201,
    body: {
      defId,
      view,
      file: plan.fileName,
      format: plan.format,
      kind: plan.asset.kind,
      frame: {
        widthUnits: plan.asset.widthUnits,
        heightUnits: plan.asset.heightUnits,
        mmPerUnit: plan.asset.mmPerUnit,
      },
      warnings: plan.warnings,
      unanchored: (plan.meta['pinAnchorsTodo'] as string[] | undefined) ?? [],
      anchored: Object.keys((plan.meta['pinAnchors'] as Record<string, unknown>) ?? {}).length,
      meta: plan.meta,
      issues,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Anchoring
 * ------------------------------------------------------------------ */

/**
 * One anchor as the PUT body carries it. `side`/`pads` are the gerber-tier
 * fields (`specs/depictions.md`) — round-tripped here exactly as the
 * client sent them so a save of an untouched side-aware anchor keeps them,
 * rather than silently dropping to plain `{x, y}`. Full validation
 * still happens once, downstream, in `parseDepictionMeta` + `validateDepiction`
 * — this function only has to not throw them away first.
 */
interface AnchorBodyIn {
  x: number;
  y: number;
  note?: string;
  side?: AnchorSide;
  pads?: AnchorPad[];
}

interface AnchorBody {
  anchorFrame: string;
  pinAnchors: Record<string, AnchorBodyIn>;
  src?: string;
}

function readAnchorBody(
  raw: Uint8Array | undefined,
): { ok: true; body: AnchorBody } | { ok: false; response: DepictionApiResponse } {
  const no = (error: string, hint: string): { ok: false; response: DepictionApiResponse } => ({
    ok: false,
    response: fail(400, error, hint),
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()));
  } catch {
    return no(
      'The studio could not read that anchor list.',
      'Nothing was written. Reload the Artwork tab and place the anchors again.',
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return no('That is not an anchor list.', 'Nothing was written.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['anchorFrame'] !== 'string' || record['anchorFrame'] === '') {
    return no(
      'The anchor list does not say which picture the positions are measured on.',
      'Nothing was written. Every anchor set belongs to exactly one view — its anchor frame.',
    );
  }
  const anchors = record['pinAnchors'];
  if (typeof anchors !== 'object' || anchors === null || Array.isArray(anchors)) {
    return no(
      'The anchor list is missing its positions.',
      'Nothing was written. Send pinAnchors as { "pin-id": { "x": …, "y": … } }.',
    );
  }
  // a null prototype, so an id of `__proto__` or `constructor` becomes a real
  // own key and is refused by the validator as the unknown terminal it is,
  // rather than silently vanishing into an object literal's prototype setter
  const out = Object.create(null) as Record<string, AnchorBodyIn>;
  for (const id of Object.keys(anchors as Record<string, unknown>).sort()) {
    const anchor = (anchors as Record<string, unknown>)[id];
    if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) {
      return no(
        `The anchor for '${id}' is not a position.`,
        'Nothing was written. Each anchor is { "x": …, "y": … } in the anchor frame\'s units.',
      );
    }
    const { x, y, note, side, pads } = anchor as {
      x?: unknown;
      y?: unknown;
      note?: unknown;
      side?: unknown;
      pads?: unknown;
    };
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      return no(
        `The anchor for '${id}' has no usable position.`,
        'Nothing was written. x and y must both be numbers, in the anchor frame\'s own units.',
      );
    }
    if (note !== undefined && typeof note !== 'string') {
      return no(`The note on '${id}' is not text.`, 'Nothing was written.');
    }
    // `side`/`pads` (the gerber-tier fields) are round-tripped as-is — not
    // deeply validated here. `parseDepictionMeta`/`validateDepiction` (called
    // on the candidate below) is the one place that shape is checked, and
    // doing it twice would only let the two checks drift apart.
    if (
      side !== undefined &&
      !(typeof side === 'string' && (ANCHOR_SIDES as readonly string[]).includes(side))
    ) {
      return no(
        `The anchor for '${id}' names a side this tool does not know.`,
        `Nothing was written. side must be one of: ${ANCHOR_SIDES.join(', ')}.`,
      );
    }
    if (pads !== undefined && !Array.isArray(pads)) {
      return no(`The pads on '${id}' are not a list.`, 'Nothing was written.');
    }
    out[id] = {
      x,
      y,
      ...(note === undefined ? {} : { note: note as string }),
      ...(side === undefined ? {} : { side: side as AnchorSide }),
      ...(pads === undefined ? {} : { pads: pads as AnchorPad[] }),
    };
  }
  return {
    ok: true,
    body: {
      anchorFrame: record['anchorFrame'],
      pinAnchors: out,
      ...(typeof record['src'] === 'string' && record['src'].trim() !== ''
        ? { src: record['src'] }
        : {}),
    },
  };
}

/**
 * Rule 2 and rule 3 of this file, in one handler.
 *
 * The mirror refusal is the interesting one and it is deliberately *not* a
 * validator issue: `validateDepiction` reports a mirrored `anchorFrame` after
 * the fact, but the API refuses the write outright, because the user who aimed
 * at the solder side needs to be told the flip is already being done for them
 * — not handed an error about a file they never meant to change.
 */
async function saveAnchors(
  deps: DepictionDeps,
  defId: string,
  request: DepictionApiRequest,
): Promise<DepictionApiResponse> {
  const existing = await deps.store.readMeta(defId);
  if (existing === undefined) {
    return fail(
      404,
      `'${defId}' has no artwork yet, so there is nothing to anchor onto.`,
      'Upload a picture of the part first — anchors are positions on a picture.',
    );
  }
  const read = readAnchorBody(request.raw);
  if (!read.ok) return read.response;
  const { anchorFrame, pinAnchors } = read.body;

  const parsedExisting = parseDepictionMeta(existing, `depictions/${defId}`);
  if (parsedExisting.meta === undefined) {
    return fail(
      409,
      `The manifest for '${defId}' cannot be read, so anchors cannot be merged into it.`,
      'Nothing was written. Re-upload the artwork to rebuild the manifest.',
      { issues: parsedExisting.issues },
    );
  }

  const frameAsset = parsedExisting.meta.views[anchorFrame];
  if (frameAsset === undefined) {
    return fail(
      400,
      `'${defId}' has no ${anchorFrame} artwork to place anchors on.`,
      `Nothing was written. It has: ${Object.keys(parsedExisting.meta.views).sort().join(', ') || 'no views at all'}.`,
    );
  }
  if (frameAsset.mirrorOf !== undefined) {
    return fail(
      409,
      `The ${anchorFrame} view is generated by flipping ${frameAsset.mirrorOf} over — it is not anchored by hand.`,
      `Nothing was written. Place the anchors on ${frameAsset.mirrorOf} and the ${anchorFrame} positions are worked out for you. Mirroring a pinout by eye is the classic wiring error, so this tool does that flip itself and will not accept it from a person.`,
    );
  }

  const db = await deps.loadDb();
  const expectedIds = definitionTerminalIds(db, defId);

  /*
   * Rule 3, checked here as well as in the validator.
   *
   * `validateDepiction` is the authority on what is a terminal, but it sees
   * the manifest *after* `parseDepictionMeta` has rebuilt it — and a rebuild
   * that copies keys onto a plain object drops the handful of names JavaScript
   * treats as special (`__proto__` first among them). An id that vanishes
   * before the check is an id that never gets refused, so the same question is
   * asked of the request's own keys, in the validator's own words.
   */
  if (expectedIds !== undefined) {
    const known = new Set(expectedIds);
    const strays = Object.keys(pinAnchors).filter((id) => !known.has(id));
    if (strays.length > 0) {
      return fail(
        422,
        strays.length === 1
          ? 'One anchor cannot be saved as it stands.'
          : `${strays.length} anchors cannot be saved as they stand.`,
        'Nothing was written — the stored anchors are untouched. Fix the problems listed below and save again.',
        {
          issues: strays.map((id) => ({
            code: 'unknown-pin-anchor',
            severity: 'error' as const,
            message: `anchor '${id}' is not a pin, pad or terminal of definition '${defId}'`,
            where: `depictions/${defId}`,
          })),
        },
      );
    }
  }

  // one to-do per solder point: a pin anchored under any of its names is done
  const todo = (definitionTerminals(db, defId) ?? [])
    .filter((t) => [t.id, ...t.aliases].every((name) => pinAnchors[name] === undefined))
    .map((t) => t.id)
    .sort();

  const views: Record<string, unknown> = {};
  for (const name of Object.keys(parsedExisting.meta.views).sort()) {
    views[name] = parsedExisting.meta.views[name];
  }
  const candidate: Record<string, unknown> = {
    defId,
    views,
    pinAnchors,
    ...(todo.length === 0 ? {} : { pinAnchorsTodo: todo }),
    anchorFrame,
    src:
      read.body.src ??
      (typeof existing['src'] === 'string' && existing['src'] !== ''
        ? existing['src']
        : `Depiction manifest for ${defId}; anchors placed on the ${anchorFrame} artwork in the studio's Artwork tab.`),
  };

  const parsed = parseDepictionMeta(candidate, `depictions/${defId}`);
  const dir = deps.store.dirFor(defId);
  const issues = [
    ...parsed.issues,
    ...(parsed.meta === undefined
      ? []
      : validateDepiction(parsed.meta, { ...(dir === undefined ? {} : { dir }), db })),
  ];
  const blocking = errors(issues);
  if (blocking.length > 0) {
    return fail(
      422,
      blocking.length === 1
        ? `One anchor cannot be saved as it stands.`
        : `${blocking.length} anchors cannot be saved as they stand.`,
      'Nothing was written — the stored anchors are untouched. Fix the problems listed below and save again.',
      { issues },
    );
  }

  await deps.store.writeMeta(defId, candidate);
  return await readDepictionDetail(deps, defId);
}

/* ------------------------------------------------------------------ *
 * Entry guides
 * ------------------------------------------------------------------ */

/** `record` with `key` set to `value` just before `before` (or last); `undefined` removes it. */
function withKeyBefore(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
  before: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(record)) {
    if (name === key) continue;
    if (name === before && value !== undefined) out[key] = value;
    out[name] = entry;
  }
  if (value !== undefined && !(key in out)) out[key] = value;
  return out;
}

/**
 * A gerber board's angled-row entry guides, written where they survive
 * regeneration — the reviewed kicad-map `import-gerbers` reads — and into the
 * manifest copy the studio draws from, so the canvas uses them at once.
 */
async function saveEntryGuides(
  deps: DepictionDeps,
  defId: string,
  request: DepictionApiRequest,
): Promise<DepictionApiResponse> {
  const existing = await deps.store.readMeta(defId);
  const map = await deps.store.readBoardMap?.(defId);
  if (existing === undefined || map === undefined || deps.store.writeBoardMap === undefined) {
    return fail(
      404,
      `'${defId}' is not a board generated from a reviewed kicad-map, so it has no entry guides to set.`,
      'Nothing was written.',
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(request.raw ?? new Uint8Array()));
  } catch {
    return fail(400, 'The studio could not read those guides.', 'Nothing was written.');
  }
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['entryGuides'] : undefined;
  const issues: Issue[] = [];
  const guides = parseEntryGuides(raw ?? [], `depictions/${defId}`, issues);
  const parsedMeta = parseDepictionMeta(existing, `depictions/${defId}`).meta;
  if (guides !== undefined && parsedMeta !== undefined) {
    for (const guide of guides) {
      for (const ref of guide.pads) {
        const known = Object.values(parsedMeta.pinAnchors).some((anchor) =>
          (anchor.pads ?? []).some((pad) => pad.ref === ref && (pad.side === guide.side || pad.side === 'both')),
        );
        if (!known) {
          issues.push({
            code: 'entry-guide-unknown-pad',
            severity: 'error',
            message: `entry guide (${guide.side}) names pad ${ref}, which is not a ${guide.side} pad of this board`,
            where: `depictions/${defId}`,
          });
        }
      }
    }
  }
  if (guides === undefined || errors(issues).length > 0) {
    return fail(422, 'Those guides cannot be saved as they stand.', 'Nothing was written.', { issues });
  }
  // who set it, when: a guide that moved (or is new) is stamped by the save
  const before = parsedMeta?.entryGuides ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const stamped = guides.map((guide) => {
    const same = before.some(
      (old) =>
        old.side === guide.side &&
        JSON.stringify([old.pads, old.from, old.to]) === JSON.stringify([guide.pads, guide.from, guide.to]),
    );
    return same ? guide : { ...guide, src: `Set by hand in the studio's Library guide editor on ${today}.` };
  });
  const value = stamped.length === 0 ? undefined : stamped;
  await deps.store.writeBoardMap(defId, withKeyBefore(map, 'entryGuides', value, 'src'));
  await deps.store.writeMeta(defId, withKeyBefore(existing, 'entryGuides', value, 'src'));
  return await readDepictionDetail(deps, defId);
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

export const DEPICTION_ROUTES = [
  'GET    /api/depictions',
  'GET    /api/depictions/:defId',
  'GET    /api/depictions/:defId/:view      (the artwork bytes)',
  'POST   /api/depictions/:defId/:view      (upload artwork for that view)',
  'PUT    /api/depictions/:defId/anchors',
  'PUT    /api/depictions/:defId/entry-guides',
] as const;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function methodNotAllowed(method: string, allowed: string[]): DepictionApiResponse {
  return fail(
    405,
    `${method} is not something this address accepts.`,
    `It answers ${allowed.join(' and ')}.`,
  );
}

/** `true` when this path belongs to this module rather than to `api.ts`. */
export function isDepictionPath(path: string): boolean {
  const head = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  return head === '/api/depictions' || head.startsWith('/api/depictions/');
}

/**
 * The artwork API surface. Query strings are ignored — no endpoint takes one.
 */
export async function handleDepictionRequest(request: DepictionApiRequest, deps: DepictionDeps): Promise<DepictionApiResponse> {
  // a write runs in a unit of work when the host gave one (the change set;
  // B7), else straight against the store — one writer at a time either way
  if (!isWriteMethod(request.method)) return routeDepictionRequest(request, deps);
  const transact = deps.transact;
  return withWriteLock(() => (transact !== undefined ? transact((staged) => routeDepictionRequest(request, staged)) : routeDepictionRequest(request, deps)));
}

async function routeDepictionRequest(
  request: DepictionApiRequest,
  deps: DepictionDeps,
): Promise<DepictionApiResponse> {
  const method = request.method.toUpperCase();
  const path = request.path.split('?')[0] ?? '';
  const parts = path.split('/').filter((part) => part !== '').map(decodeSegment);
  const [, head, defId, action, ...rest] = parts;
  if (parts[0] !== 'api' || head !== 'depictions') {
    return fail(404, `${path} is not part of the workbench API.`, `Try one of: ${DEPICTION_ROUTES.join('; ')}.`);
  }

  if (defId === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    return { status: 200, body: { depictions: await deps.store.listDefIds() } };
  }

  // rule 4: the id is checked before anything can turn it into a path
  if (!isDepictionDefId(defId)) {
    return fail(400, `${JSON.stringify(String(defId))} cannot be used as a definition id.`, ID_RULE);
  }

  if (action === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    return await readDepictionDetail(deps, defId);
  }
  if (rest.length > 0) {
    return fail(404, `${path} is not part of the workbench API.`, `Try one of: ${DEPICTION_ROUTES.join('; ')}.`);
  }

  if (action === 'entry-guides') {
    if (method !== 'PUT') return methodNotAllowed(method, ['PUT']);
    return await saveEntryGuides(deps, defId, request);
  }

  if (action === 'anchors') {
    if (method !== 'PUT') return methodNotAllowed(method, ['PUT']);
    return await saveAnchors(deps, defId, request);
  }

  if (!isDepictionView(action)) {
    return fail(
      404,
      `'${action}' is not one of this tool's view kinds.`,
      `Views are: ${DEPICTION_VIEWS.join(', ')}.`,
    );
  }
  if (method === 'GET') return await readAsset(deps, defId, action);
  if (method === 'POST') return await uploadDepiction(deps, defId, action, request);
  return methodNotAllowed(method, ['GET', 'POST']);
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ *
 *
 * `plugin.ts` says it is the only file in the API that touches a socket, and
 * for the JSON surface it still is. Artwork needs its own few lines because a
 * request here may carry arbitrary bytes and a response may *be* an image, and
 * neither survives the JSON pipe. Everything above this comment is transport
 * free and tested that way; everything below is the adapter.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { MAX_UPLOAD_BYTES, contentTypeRefusal, crossSiteRefusal, isWriteMethod } from './request-guard.ts';
import { withWriteLock } from './storage/write-lock.ts';
import type { Awaitable } from './storage/change-set.ts';

function readBytes(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error('that file is larger than the workbench will accept (24 MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/**
 * The artwork endpoints as a Connect middleware. Registered ahead of the JSON
 * one in `plugin.ts`; anything that is not `/api/depictions…` falls straight
 * through to it.
 */
export function depictionMiddleware(
  deps: DepictionDeps = defaultDepictionDeps(),
  /**
   * Run writes in the host's unit of work (`transactingDepictionDeps`): given the
   * deps and whether the request is `?dryRun=1`, answer the deps to handle it with.
   */
  wrap?: (deps: DepictionDeps, dryRun: boolean) => DepictionDeps,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    const path = req.url ?? '';
    if (!isDepictionPath(path)) {
      next();
      return;
    }
    void (async (): Promise<void> => {
      const sendJson = (status: number, body: unknown): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(`${JSON.stringify(body, null, 2)}\n`);
      };
      const first = (name: string): string | undefined => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const crossSite = crossSiteRefusal({
        method: req.method ?? 'GET',
        origin: first('origin'),
        secFetchSite: first('sec-fetch-site'),
        host: first('x-forwarded-host') ?? first('host'),
      });
      if (crossSite !== undefined) {
        sendJson(crossSite.status, crossSite.body);
        return;
      }
      let raw: Uint8Array;
      try {
        raw = await readBytes(req);
        const typeRefusal = raw.length === 0 ? undefined : contentTypeRefusal(req.method ?? 'GET', first('content-type'), true);
        if (typeRefusal !== undefined) {
          sendJson(typeRefusal.status, typeRefusal.body);
          return;
        }
      } catch (error) {
        sendJson(413, {
          error: 'The studio could not read that upload.',
          hint: `Nothing was changed. (${(error as Error).message})`,
        });
        return;
      }
      try {
        const response = await handleDepictionRequest(
          {
            method: req.method ?? 'GET',
            path,
            ...(req.headers['content-type'] === undefined
              ? {}
              : { contentType: req.headers['content-type'] }),
            ...(raw.length === 0 ? {} : { raw }),
          },
          wrap === undefined ? deps : wrap(deps, new URL(path, 'http://localhost').searchParams.get('dryRun') === '1'),
        );
        if ('bytes' in response) {
          res.statusCode = response.status;
          res.setHeader('content-type', response.contentType);
          // the workbench rewrites these files; a cached answer shows stale art
          res.setHeader('cache-control', 'no-store');
          res.end(Buffer.from(response.bytes));
          return;
        }
        sendJson(response.status, response.body);
      } catch (error) {
        sendJson(500, {
          error: 'The workbench hit an unexpected problem and stopped before changing anything.',
          hint: `Check the terminal running the studio for details. (${(error as Error).message})`,
        });
      }
    })();
  };
}
