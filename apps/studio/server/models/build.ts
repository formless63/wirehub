/**
 * Rebuild an imported model from its sources — what the `model-cache` job
 * does for every live key (`specs/postgres-backend.md` §5.5; task C6).
 *
 * An imported link (`links.ts`) is only provenance: the source files with
 * the sha256 each had (`files`), how they make a model (`build`), and the
 * cache key that follows from both (`asset` = `sourceKey(files, budget,
 * build)`). Any studio that can read those files — a model-sources folder
 * mounted read-only (`WIREHUB_MODEL_SOURCES`), and the catalog's own
 * depiction art — builds the same key, through the same memory-capped
 * conversion a person's upload goes through (`convert.ts`), one at a time.
 *
 * A source that is missing or whose bytes no longer match their sha256 is a
 * refusal with a sentence, never a model built from the wrong file. A link
 * whose key was made by another converter version cannot be rebuilt under
 * that key here: it is reported as stale (the importer re-keys it).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { boardAssemblyPlan, boardLibraryRefs, modelMatrix, type AssemblyPlan } from './assembly.ts';
import type { BoardArt } from './board-texture.ts';
import { isArtFile, sha256Hex, sourceKey, type ModelBuild, type SourceFile } from './cache.ts';
import { convertAssembly, convertModel, convertModelFiles, ModelRefusal, type ConvertedModel } from './convert.ts';
import { MAX_MODEL_TRIANGLES } from './finish.ts';
import { embeddedFile, parseKicadPcb } from './kicad-pcb.ts';
import { KICAD_ROOT } from './kicad-library.ts';
import type { ModelLink } from './links.ts';

/** The triangle budgets an importer keys models with, most likely first. */
export const KNOWN_BUDGETS: readonly number[] = [MAX_MODEL_TRIANGLES, 150_000, 100_000, 80_000, 50_000, 30_000];

/** The budget `link.asset` was keyed with at this converter version, or undefined (stale or unknown). */
export function budgetOf(link: Pick<ModelLink, 'asset' | 'files' | 'build'>, budgets: readonly number[] = KNOWN_BUDGETS): number | undefined {
  if (link.files === undefined) return undefined;
  return budgets.find((n) => sourceKey(link.files!, n, link.build) === link.asset);
}

/** Reads a source file's bytes by its link path; undefined when this studio cannot. */
export type SourceReader = (path: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

/** A folder of model sources (`housings/…`, `boards/…`, `kicad-packages3D/…`), read-only. */
export function folderSources(dir: string): SourceReader {
  const root = resolve(dir);
  return (path) => {
    if (path.split('/').some((s) => s === '..' || s === '')) return undefined;
    const full = resolve(join(root, path));
    if (!full.startsWith(root + sep) || !existsSync(full)) return undefined;
    return new Uint8Array(readFileSync(full));
  };
}

/** Try each reader in turn. */
export function chainSources(...readers: (SourceReader | undefined)[]): SourceReader {
  return async (path) => {
    for (const read of readers) {
      if (read === undefined) continue;
      const bytes = await read(path);
      if (bytes !== undefined) return bytes;
    }
    return undefined;
  };
}

export interface BuildOutcome {
  key: string;
  glb: Uint8Array;
  converted: ConvertedModel;
  inputs: { kind: 'source'; ref: string; sha256: string }[];
}

export type Converter = {
  model: typeof convertModel;
  files: typeof convertModelFiles;
  assembly: typeof convertAssembly;
};

const REAL: Converter = { model: convertModel, files: convertModelFiles, assembly: convertAssembly };

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Build the GLB `link.asset` names. Throws `ModelRefusal` (with a sentence)
 * when a source is missing or changed, when the key is stale, or when the
 * conversion refuses.
 */
export async function buildLinkedModel(
  link: ModelLink,
  read: SourceReader,
  convert: Converter = REAL,
  /** where a board's KiCad library models come from at a commit (`library-source.ts`); default `read` */
  library?: (commit: string) => SourceReader,
): Promise<BuildOutcome> {
  const files = link.files;
  if (files === undefined) throw new ModelRefusal(`${link.record}'s model is an upload, not built from sources.`, 'Uploads are stored as they were converted.');
  const budget = budgetOf(link);
  if (budget === undefined) {
    throw new ModelRefusal(`${link.record}'s model key was made by another converter version or budget.`, 'Run the importer that made it again: it re-keys the link for this studio.');
  }
  const bytes = new Map<string, Uint8Array>();
  for (const file of files) {
    const got = await read(file.path);
    if (got === undefined) throw new ModelRefusal(`${file.path} is not readable here.`, 'Mount the model sources (WIREHUB_MODEL_SOURCES) on this studio.');
    if (sha256Hex(got) !== file.sha256) throw new ModelRefusal(`${file.path} has changed since the model was imported.`, 'Run the importer again: the link names the old file.');
    bytes.set(file.path, got);
  }
  const art = boardArt(files, bytes);
  const geometry = files.filter((f) => !isArtFile(f.path));
  const name = link.name ?? baseName(geometry[0]?.path ?? link.record);
  const options = { maxTriangles: budget, ...(art === undefined ? {} : { boardArt: art }) };
  // a board whose library models are fetched at a pinned commit: read the ones it names
  const fetched: { kind: 'source'; ref: string; sha256: string }[] = [];
  if (link.build?.kind === 'assembly' && link.build.library !== undefined) {
    const pcb = geometry.find((f) => isBoardFile(f.path));
    if (pcb !== undefined) {
      const reader = library?.(link.build.library) ?? read;
      for (const ref of boardLibraryRefs(parseKicadPcb(new TextDecoder().decode(bytes.get(pcb.path))))) {
        const path = `${KICAD_ROOT}/${ref}`;
        const got = await reader(path);
        if (got === undefined) continue;
        bytes.set(path, got);
        fetched.push({ kind: 'source', ref: `${path}@${link.build.library}`, sha256: sha256Hex(got) });
      }
    }
  }
  const libraryFiles: SourceFile[] = [...bytes.keys()].filter((p) => p.startsWith(`${KICAD_ROOT}/`) && !geometry.some((f) => f.path === p)).map((p) => ({ path: p, sha256: '' }));
  const converted = await convertWith(convert, link.build, [...geometry, ...libraryFiles], bytes, name, options);
  return {
    key: link.asset,
    glb: converted.glb,
    converted,
    inputs: [...files.map((f) => ({ kind: 'source' as const, ref: f.path, sha256: f.sha256 })), ...fetched],
  };
}

/** A board file among a link's sources: a `.kicad_pcb`, or one uploaded as a catalog document (`….kicad_pcb.txt`). */
export function isBoardFile(path: string): boolean {
  return path.endsWith('.kicad_pcb') || path.endsWith('.kicad_pcb.txt');
}

function boardArt(files: readonly SourceFile[], bytes: ReadonlyMap<string, Uint8Array>): BoardArt | undefined {
  const text = (suffix: string): string | undefined => {
    const file = files.find((f) => isArtFile(f.path) && f.path.endsWith(suffix));
    return file === undefined ? undefined : new TextDecoder().decode(bytes.get(file.path));
  };
  const top = text('board-top.svg');
  const bottom = text('board-bottom.svg');
  return top !== undefined && bottom !== undefined ? { top, bottom } : undefined;
}

async function convertWith(
  convert: Converter,
  build: ModelBuild | undefined,
  geometry: readonly SourceFile[],
  bytes: ReadonlyMap<string, Uint8Array>,
  name: string,
  options: { maxTriangles: number; boardArt?: BoardArt },
): Promise<ConvertedModel> {
  const of = (f: SourceFile): Uint8Array => bytes.get(f.path)!;
  if (build === undefined) {
    if (geometry.length === 0) throw new ModelRefusal(`${name} has no model file among its sources.`, 'Run the importer again.');
    if (geometry.length === 1) return convert.model(of(geometry[0]!), baseName(geometry[0]!.path), options);
    return convert.files(
      geometry.map((f) => ({ bytes: of(f), name: baseName(f.path) })),
      { maxTriangles: options.maxTriangles },
    );
  }
  const library = geometry.filter((f) => f.path.startsWith(`${KICAD_ROOT}/`));
  if (build.kind === 'placed') {
    const file = library[0] ?? geometry[0];
    if (file === undefined) throw new ModelRefusal(`${name} has no library file to place.`, 'Run the importer again.');
    const plan: AssemblyPlan = {
      models: [{ name: baseName(file.path), bytes: of(file) }],
      instances: [{ model: 0, matrix: modelMatrix({ offset: vec(build.offset), rotate: vec(build.rotate), scale: { x: 1, y: 1, z: 1 } }) }],
    };
    return convert.assembly(plan, name, options);
  }
  const pcb = geometry.find((f) => isBoardFile(f.path));
  if (pcb === undefined) throw new ModelRefusal(`${name} is built from a KiCad board, but no .kicad_pcb is among its sources.`, 'Run the importer again.');
  const board = parseKicadPcb(new TextDecoder().decode(of(pcb)));
  if (build.kind === 'embedded') {
    const file = embeddedFile(board, build.name);
    if (file === undefined) throw new ModelRefusal(`${baseName(pcb.path)} embeds no model called ${build.name}.`, 'Run the importer again.');
    return convert.model(file.bytes, build.name, options);
  }
  const byRef = new Map(library.map((f) => [f.path.slice(KICAD_ROOT.length + 1), of(f)] as const));
  const { plan } = boardAssemblyPlan(board, (ref) => byRef.get(ref));
  return convert.assembly(plan, name, options);
}

function vec(v: readonly [number, number, number]): { x: number; y: number; z: number } {
  return { x: v[0], y: v[1], z: v[2] };
}
