/**
 * KiCad's standard 3D model library as a model source (the Library shows these
 * models alongside the shop's own).
 *
 * The library is gitlab.com/kicad/libraries/kicad-packages3D, CC-BY-SA 4.0
 * with an exception for use in designs (see /NOTICE). Only the files a link
 * needs are fetched, by the import tooling (`scripts/kicad-fetch.ts`), from
 * one pinned tag, over https, into a gitignored cache under the repo; the
 * studio itself never touches the network. This module is pure: which tag,
 * how a board's `${KICAD9_3DMODEL_DIR}/…` path names a library file, where
 * that file lives upstream, and what the committed mapping table says.
 *
 *   packages/catalog/data/kicad-models.json   record → library (or embedded) model
 */

import type { Vec3 } from './kicad-pcb.ts';

/** The pinned library release. Bump both together and re-run `import-models`. */
export const KICAD_LIBRARY = {
  name: 'kicad-packages3D',
  project: 'https://gitlab.com/kicad/libraries/kicad-packages3D',
  tag: '9.0.9.1',
  commit: '2a697f255a3654e5175e2e9b5d2abdb4ca874015',
  licence: 'CC-BY-SA-4.0 with the KiCad libraries exception (use in a design, and in files made from one, is unrestricted)',
} as const;

/** The first segment of every library `SourceFile.path` (like `boards/…`). */
export const KICAD_ROOT = KICAD_LIBRARY.name;

const LIB_DIR = /^[A-Za-z0-9_.+-]+\.3dshapes$/;
const LIB_FILE = /^[A-Za-z0-9_.,+()-]+\.(step|stp|wrl)$/i;

/** `Resistor_SMD.3dshapes/R_0805_2012Metric.step` — `undefined` for anything that is not one library file. */
export function libraryModelPath(path: string): string | undefined {
  const parts = path.split('/');
  if (parts.length !== 2) return undefined;
  const [dir, file] = parts as [string, string];
  if (!LIB_DIR.test(dir) || !LIB_FILE.test(file) || file.startsWith('.')) return undefined;
  // KiCad itself loads the .step when a footprint names the .wrl
  return `${dir}/${file.replace(/\.wrl$/i, '.step')}`;
}

/**
 * A footprint's model path → the library file it names, for every spelling
 * KiCad has used for the library root (`${KICAD9_3DMODEL_DIR}`,
 * `${KICAD10_3DMODEL_DIR}`, `${KISYS3DMOD}`, …). `undefined` for an embedded
 * model (`kicad-embed://…`), a network or absolute path, or a custom library.
 */
export function kicadLibraryRef(path: string): string | undefined {
  const m = /^\$\{(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}\/(.+)$/.exec(path.trim());
  return m === null ? undefined : libraryModelPath(m[2]!);
}

/** Where the pinned file lives upstream (GitLab's raw endpoint, by commit). */
export function kicadModelUrl(libraryPath: string, commit: string = KICAD_LIBRARY.commit): string {
  const path = libraryModelPath(libraryPath);
  if (path === undefined) throw new Error(`not a KiCad library model path: ${libraryPath}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit id: ${commit}`);
  return `${KICAD_LIBRARY.project}/-/raw/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** `kicad-packages3D/Resistor_SMD.3dshapes/R_0805_2012Metric.step` — the link's `files[].path`. */
export function kicadSourcePath(libraryPath: string): string {
  const path = libraryModelPath(libraryPath);
  if (path === undefined) throw new Error(`not a KiCad library model path: ${libraryPath}`);
  return `${KICAD_ROOT}/${path}`;
}

/** The citation every library-sourced link carries. */
export function kicadCitation(libraryPath: string): string {
  return `KiCad 3D library ${KICAD_LIBRARY.name} ${KICAD_LIBRARY.tag} (commit ${KICAD_LIBRARY.commit.slice(0, 12)}), ${libraryPath} — ${KICAD_LIBRARY.licence}; attribution in /NOTICE`;
}

/* ------------------------------------------------------------------ *
 * The mapping table
 * ------------------------------------------------------------------ */

/** One record's model: a library file, or a model embedded in a board file. */
export interface KicadModelMapping {
  /** `connectors/trs-3-5mm-female` */
  record: string;
  /** a library file, `Connector_Audio.3dshapes/Jack_….step` */
  model?: string;
  /** or a model KiCad embedded in a board file */
  embedded?: { board: string; name: string };
  /** placed like a footprint model (mm / degrees), when the file's own origin is not the right one */
  offset?: [number, number, number];
  rotate?: [number, number, number];
  /** why this model, and how exact it is (a stand-in says so) */
  src: string;
}

export interface KicadModelGap {
  record: string;
  reason: string;
}

export interface KicadModelTable {
  src: string;
  library: { name: string; tag: string; commit: string; licence: string };
  links: KicadModelMapping[];
  gaps: KicadModelGap[];
}

const RECORD = /^(connectors|components|bodies|mechanicals|pcbas|wires)\/[a-z0-9][a-z0-9.-]*$/;

/** Checks the committed table; throws a sentence on the first problem. */
export function validateKicadModelTable(table: KicadModelTable, knownRecords?: ReadonlySet<string>): KicadModelTable {
  if (table.library?.tag !== KICAD_LIBRARY.tag || table.library?.commit !== KICAD_LIBRARY.commit) {
    throw new Error(`kicad-models.json pins ${table.library?.tag}@${table.library?.commit}, the code pins ${KICAD_LIBRARY.tag}@${KICAD_LIBRARY.commit}`);
  }
  const seen = new Set<string>();
  for (const link of table.links) {
    if (!RECORD.test(link.record)) throw new Error(`kicad-models.json: '${link.record}' is not a <kind>/<id> record`);
    if (seen.has(link.record)) throw new Error(`kicad-models.json: ${link.record} is mapped twice`);
    seen.add(link.record);
    if (knownRecords !== undefined && !knownRecords.has(link.record)) throw new Error(`kicad-models.json: there is no Library record ${link.record}`);
    if ((link.model === undefined) === (link.embedded === undefined)) throw new Error(`kicad-models.json: ${link.record} needs exactly one of model / embedded`);
    if (link.model !== undefined && libraryModelPath(link.model) !== link.model) throw new Error(`kicad-models.json: ${link.record}: '${link.model}' is not a library .step path`);
    if (link.embedded !== undefined && (!link.embedded.board.startsWith('boards/') || !link.embedded.board.endsWith('.kicad_pcb') || link.embedded.board.includes('..'))) {
      throw new Error(`kicad-models.json: ${link.record}: an embedded model must come from a boards/ .kicad_pcb`);
    }
    for (const v of [link.offset, link.rotate]) {
      if (v !== undefined && (v.length !== 3 || v.some((n) => !Number.isFinite(n)))) throw new Error(`kicad-models.json: ${link.record}: offset/rotate are [x, y, z]`);
    }
    if (typeof link.src !== 'string' || link.src.trim() === '') throw new Error(`kicad-models.json: ${link.record} has no src`);
  }
  for (const gap of table.gaps) {
    if (seen.has(gap.record)) throw new Error(`kicad-models.json: ${gap.record} is both mapped and a gap`);
  }
  return table;
}

export function vec3(v: readonly [number, number, number] | undefined, fallback: Vec3): Vec3 {
  return v === undefined ? fallback : { x: v[0], y: v[1], z: v[2] };
}
