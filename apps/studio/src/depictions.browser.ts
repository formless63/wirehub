/**
 * The depiction tree, loaded the way a browser can load it.
 *
 * `@wirehub/catalog` reads `packages/catalog/depictions/` with `node:fs`,
 * which is why the studio aliases those bindings to a throwing shim. Vite can
 * read that same committed tree at build time, though: `import.meta.glob`
 * turns each `meta.json` into a module and each `.svg` into its own source
 * text, and the renderer gets a `DepictionSource` that never touches a
 * filesystem.
 *
 * This is a *loader*, not a second copy of the data: the globs point at the
 * catalog's own directory, so there is nothing here to keep in sync.
 *
 * **Lazy, per definition**. The tree is ~8 MB of SVG
 * and manifests; bundled eagerly it made the main chunk 12 MB. Each file is
 * now its own chunk, fetched the first time a definition is asked for.
 * `renderSchematic` and the canvas's layout are synchronous, so they cannot
 * await a file — instead the source is a snapshot: asking it for a definition
 * it does not hold yet answers `undefined` (the abstract block, the same
 * fallback as a board with no artwork) and starts the fetch; when the files
 * land, a new snapshot replaces it and subscribers re-render. The cable
 * workspace loads a design's definitions *before* mounting the editor
 * (`load`), so its first auto-layout already sees the real board sizes.
 */

import { parseDepictionMeta, type DepictionMeta } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import type { DepictionArtwork, DepictionSource } from '@wirehub/editor-react';

/** File extension → media type, for the raster tier's data URIs. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** The raw modules a glob hands back, keyed by path. */
export interface DepictionModules {
  /** `…/depictions/<defId>/meta.json` → the parsed manifest JSON */
  meta: Record<string, unknown>;
  /** `…/depictions/<defId>/<file>.svg` → the file's source text */
  vector: Record<string, string>;
  /** `…/depictions/<defId>/<file>.png` → a `data:` URI (Vite's `?inline`) */
  raster?: Record<string, string>;
}

/** `…/depictions/PCA-00114-rev2/board-top.svg` → `PCA-00114-rev2`. */
function defIdOf(path: string): string | undefined {
  const parts = path.split('/');
  return parts[parts.length - 2];
}

function fileNameOf(path: string): string | undefined {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/**
 * Assemble a `DepictionSource` from globbed modules.
 *
 * Pure and glob-agnostic so it can be tested without a bundler. It follows the
 * catalog loader's manners exactly: **nothing throws**. A manifest that will
 * not parse simply never enters the index, an asset file that is missing or
 * whose manifest names a path (rather than a plain file name) comes back
 * `undefined`, and in both cases the layout pass records its own diagnostic and
 * draws the abstract block — the same fallback the command-line renderer takes.
 */
export function assembleDepictionSource(modules: DepictionModules): DepictionSource {
  const index: Record<string, DepictionMeta> = {};
  for (const [path, raw] of Object.entries(modules.meta)) {
    const defId = defIdOf(path);
    if (defId === undefined) continue;
    const parsed = parseDepictionMeta(raw, `depictions/${defId}`);
    // the manifest's own defId is the one that counts, as it does on disk;
    // a directory/defId mismatch is the catalog's build to fail, not ours
    if (parsed.meta !== undefined && parsed.meta.defId === defId) index[defId] = parsed.meta;
  }

  /** `<defId>/<file>` → bytes, in whichever form the renderer wants them. */
  const files = new Map<string, DepictionArtwork>();
  const collect = (
    source: Record<string, string> | undefined,
    make: (value: string, file: string) => DepictionArtwork | undefined,
  ): void => {
    for (const [path, value] of Object.entries(source ?? {})) {
      const defId = defIdOf(path);
      const file = fileNameOf(path);
      if (defId === undefined || file === undefined) continue;
      const artwork = make(value, file);
      if (artwork !== undefined) files.set(`${defId}/${file}`, artwork);
    }
  };

  collect(modules.vector, (source) => ({ kind: 'vector', source }));
  collect(modules.raster, (value, file) => {
    const dot = file.lastIndexOf('.');
    if (dot === -1 || MEDIA_TYPES[file.slice(dot).toLowerCase()] === undefined) return undefined;
    // `?inline` yields a data URI; anything else would be a URL out of the
    // bundle, which the schematic's "no external references" rule forbids
    return value.startsWith('data:') ? { kind: 'raster', dataUri: value } : undefined;
  });

  return {
    meta: (defId) => index[defId],
    artwork: (defId, view) => {
      const asset = index[defId]?.views[view];
      if (asset === undefined) return undefined;
      // a manifest may only name a plain file inside its own directory
      if (asset.file.includes('/') || asset.file.includes('\\') || asset.file.includes('..')) {
        return undefined;
      }
      const artwork = files.get(`${defId}/${asset.file}`);
      // the manifest's declared kind decides how the renderer embeds it, so a
      // file whose bytes arrived in the other form is not usable art
      return artwork?.kind === asset.kind ? artwork : undefined;
    },
  };
}

/** Globbed modules, not yet loaded: path → a loader for that file's module. */
export interface LazyDepictionModules {
  meta: Record<string, () => Promise<unknown>>;
  vector: Record<string, () => Promise<string>>;
  raster?: Record<string, () => Promise<string>>;
}

export interface LazyDepictions {
  /** the current snapshot; a new identity each time definitions land */
  current(): DepictionSource;
  /** called after definitions land (batched); returns the unsubscribe */
  subscribe(listener: () => void): () => void;
  /** fetch these definitions' manifests and artwork; ids with no depiction are ignored */
  load(defIds: Iterable<string>): Promise<void>;
  /** every definition the tree has a depiction for, loaded or not */
  known(): string[];
}

/**
 * A `DepictionSource` over lazily loaded modules. Pure apart from the loaders
 * it is handed, so it is tested with plain promises — no bundler.
 */
export function lazyDepictions(modules: LazyDepictionModules): LazyDepictions {
  /** defId → every path of that definition, by kind */
  const byDef = new Map<string, { meta?: string; vector: string[]; raster: string[] }>();
  const entry = (path: string) => {
    const defId = defIdOf(path);
    if (defId === undefined) return undefined;
    let found = byDef.get(defId);
    if (found === undefined) byDef.set(defId, (found = { vector: [], raster: [] }));
    return found;
  };
  for (const path of Object.keys(modules.meta)) {
    const e = entry(path);
    if (e !== undefined) e.meta = path;
  }
  for (const path of Object.keys(modules.vector)) entry(path)?.vector.push(path);
  for (const path of Object.keys(modules.raster ?? {})) entry(path)?.raster.push(path);

  const loaded: Required<DepictionModules> = { meta: {}, vector: {}, raster: {} };
  const inFlight = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let snapshot: DepictionSource;
  let notifyQueued = false;

  const request = (defId: string): void => {
    if (!inFlight.has(defId) && byDef.get(defId)?.meta !== undefined) void loadOne(defId);
  };
  const rebuild = (): void => {
    const inner = assembleDepictionSource(loaded);
    snapshot = {
      meta: (defId) => {
        const meta = inner.meta(defId);
        if (meta === undefined) request(defId);
        return meta;
      },
      artwork: (defId, view) => {
        const art = inner.artwork(defId, view);
        if (art === undefined) request(defId);
        return art;
      },
    };
  };
  rebuild();

  const landed = (): void => {
    rebuild();
    if (notifyQueued) return;
    notifyQueued = true;
    // a design's boards land together; one re-render for the lot
    queueMicrotask(() => {
      notifyQueued = false;
      for (const listener of [...listeners]) listener();
    });
  };

  const loadOne = (defId: string): Promise<void> => {
    const known = inFlight.get(defId);
    if (known !== undefined) return known;
    const paths = byDef.get(defId);
    if (paths?.meta === undefined) return Promise.resolve();
    const metaPath = paths.meta;
    const task = (async () => {
      try {
        const [meta, vector, raster] = await Promise.all([
          modules.meta[metaPath]!(),
          Promise.all(paths.vector.map(async (p) => [p, await modules.vector[p]!()] as const)),
          Promise.all(paths.raster.map(async (p) => [p, await modules.raster![p]!()] as const)),
        ]);
        for (const [p, text] of vector) loaded.vector[p] = text;
        for (const [p, uri] of raster) loaded.raster[p] = uri;
        loaded.meta[metaPath] = meta;
        landed();
      } catch {
        // a chunk that would not load (offline, a stale bundle after a
        // redeploy): the block stays abstract, and the next ask tries again
        inFlight.delete(defId);
      }
    })();
    inFlight.set(defId, task);
    return task;
  };

  return {
    current: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load: async (defIds) => {
      await Promise.all([...new Set(defIds)].map(loadOne));
    },
    known: () => [...byDef.entries()].filter(([, e]) => e.meta !== undefined).map(([id]) => id),
  };
}

/** Every definition a design's instances name — what `load` should fetch before the editor lays it out. */
export function depictionDefsOf(design: CableDesign): string[] {
  const { connectors, segments, components, pcbas, mechanical } = design.instances;
  return [...pcbas, ...connectors, ...components, ...segments, ...(mechanical ?? [])].map((instance) => instance.def);
}

// non-eager: every file is its own chunk, fetched on first use
const META = import.meta.glob('../../../packages/catalog/depictions/*/meta.json', {
  import: 'default',
}) as Record<string, () => Promise<unknown>>;

const VECTOR = import.meta.glob('../../../packages/catalog/depictions/*/*.svg', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

// none committed today; the tier exists so a photographed or rendered board
// works the day one lands, without this file changing
const RASTER = import.meta.glob('../../../packages/catalog/depictions/*/*.{png,jpg,jpeg,webp}', {
  query: '?inline',
  import: 'default',
}) as Record<string, () => Promise<string>>;

let cached: LazyDepictions | undefined;

/**
 * The catalog's depiction tree, lazily loaded — one per page, so every view
 * shares what has already been fetched.
 */
export function browserDepictions(): LazyDepictions {
  cached ??= lazyDepictions({ meta: META, vector: VECTOR, raster: RASTER });
  return cached;
}

/**
 * A saved revision's own artwork: versions copy their
 * parts' depiction files when saved, so an old revision draws exactly what
 * it was released with. `covered` are the definitions whose artwork the
 * revision fixes — they draw only from `own` (a part that had no artwork then
 * stays an abstract block); anything else (a part added while the revision is
 * unlocked, or every part of a v1 file that kept only hashes) draws from `live`.
 */
export function versionDepictionSource(own: DepictionModules, covered: ReadonlySet<string>, live: DepictionSource): DepictionSource {
  const inner = assembleDepictionSource(own);
  return {
    meta: (defId) => (covered.has(defId) ? inner.meta(defId) : live.meta(defId)),
    artwork: (defId, view) => (covered.has(defId) ? inner.artwork(defId, view) : live.artwork(defId, view)),
  };
}
