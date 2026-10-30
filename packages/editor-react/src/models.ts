/**
 * 3D models of Library parts — the adapter a host
 * hands the Library, and the small pure helpers the model panel uses. No
 * three.js here: the viewer (`panels/ModelViewer3d.tsx`, `model-scene.ts`)
 * is a separate, lazily loaded chunk, so a Library page without a model
 * never downloads it.
 *
 * The Library shows a render of a part's 3D model right on its screen, so the
 * part can be checked at a glance.
 */

import type { ParametricSpec } from '@wirehub/model';

import type { Outcome } from './persistence.ts';

export type ModelSourceKind = 'kicad-board' | 'resin-print' | 'vendor' | 'uploaded' | 'kicad-library' | 'parametric' | 'generated';

export const MODEL_SOURCE_LABEL: Record<ModelSourceKind, string> = {
  'kicad-board': 'KiCad board',
  'resin-print': 'Resin print',
  vendor: 'Vendor model',
  uploaded: 'Uploaded',
  'kicad-library': 'KiCad library',
  parametric: 'Parametric',
  generated: 'Generated',
};

/** One record's model, as the host stores the link. */
export interface ModelLinkView {
  /** `<kind>/<id>` */
  record: string;
  /** the stored model's asset id (sha256) */
  asset: string;
  sourceKind: ModelSourceKind;
  src: string;
  revision?: string;
  triangles?: number;
  /** `false`: an imported model whose bytes are not built on this studio yet */
  built?: boolean;
  /** a model drawn from its dimensions, with no stored bytes (`parametric-model.ts`) */
  parametric?: ParametricSpec;
  /** not built here: the source files this hub cannot read, and what to do about it */
  missing?: string[];
  missingHint?: string;
  /** not built here: the record's own native model (a board's `board.glb`), shown meanwhile */
  fallback?: StoredModel;
  /** `board-file`: the model keeps its board file's coordinates (an attached native `board.glb`), not centred on its outline */
  frame?: 'board-file';
}

/** A stored model anyone can attach ("pick an already imported model"). */
export interface StoredModel {
  id: string;
  mime: string;
  originalName: string;
  src: string;
  bytes: number;
}

export interface ModelUploadStats {
  triangles: number;
  sourceTriangles: number;
  simplified: boolean;
  ms?: number;
}

/**
 * How a host keeps models. Every write quotes the version the panel loaded
 * (the adapter remembers it, like the definition adapter's ETags) and rides
 * the record's edit lock.
 */
export interface ModelsAdapter {
  /** the record's link, or `null` when it has none */
  get(kind: string, id: string): Promise<Outcome<ModelLinkView | null>>;
  /** every link and every stored model */
  list(): Promise<Outcome<{ links: ModelLinkView[]; models: StoredModel[] }>>;
  attach(kind: string, id: string, asset: string): Promise<Outcome<ModelLinkView>>;
  upload(kind: string, id: string, file: { name: string; bytes: ArrayBuffer }, sourceKind: ModelSourceKind, sourceCitation?: string): Promise<Outcome<{ link: ModelLinkView; stats?: ModelUploadStats }>>;
  detach(kind: string, id: string): Promise<Outcome<null>>;
  /** the model's bytes and type — from the host's asset API, nowhere else */
  fetchModel(asset: string): Promise<Outcome<{ bytes: ArrayBuffer; mime: string }>>;
  /** models the record's own native outputs made (a board's `board.glb`), offered first in "pick a model"; absent: none */
  outputs?(kind: string, id: string): Promise<Outcome<StoredModel[]>>;
  /** attach one of `outputs` (by its id) as the record's model */
  attachOutput?(kind: string, id: string, output: string): Promise<Outcome<ModelLinkView>>;
  /** the record's own native model's bytes (`ModelLinkView.fallback`), for a view while its link is not built */
  fetchNative?(kind: string, id: string): Promise<Outcome<{ bytes: ArrayBuffer; mime: string }>>;
  /** ask the host to build the models that are not built yet (the model-cache job) */
  build?(): Promise<Outcome<null>>;
}

/** The model file types the upload takes for a record kind: a board also takes its KiCad board file. */
export function modelAccept(kind: string): string {
  return kind === 'pcbas' ? `${MODEL_ACCEPT},.kicad_pcb` : MODEL_ACCEPT;
}

export function isModelFileNameFor(kind: string, name: string): boolean {
  return isModelFileName(name) || (kind === 'pcbas' && /\.kicad_pcb$/i.test(name));
}

/** The model file types the viewer and the upload take. */
export const MODEL_ACCEPT = '.stl,.step,.stp,.glb';

export function isModelFileName(name: string): boolean {
  return /\.(stl|step|stp|glb)$/i.test(name);
}

/** `true` for a GLB, by its `glTF` magic. */
export function looksLikeGlb(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  return new DataView(bytes).getUint32(0, true) === 0x46546c67;
}

/** Library kinds whose records can carry a model. */
export const MODEL_KINDS = new Set(['connectors', 'components', 'wires', 'pcbas', 'mechanicals', 'bodies']);

/** The camera presets: where the eye sits, relative to the model's centre. */
export type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'side';

export const VIEW_DIRECTIONS: Record<ViewPreset, readonly [number, number, number]> = {
  iso: [1, 0.8, 1.2],
  top: [0, 1, 0.0001],
  bottom: [0, -1, 0.0001],
  front: [0, 0, 1],
  side: [1, 0, 0],
};

/** A saved presentation camera for a record's cover (never an engineering dimension). */
export interface ModelCoverCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

/** A static render of the 3D view, ready to store as the record's cover. */
export interface ModelCoverCapture {
  camera: ModelCoverCamera;
  image: Blob;
  width: number;
  height: number;
  /** the model link's asset the view was rendered from (absent: a view drawn from the record itself) */
  modelAsset?: string;
}

/**
 * The host's shared cover resolver, as the 3D view sees it: "Use this view as cover" stores the
 * camera plus a static render; galleries then show only that image (no live WebGL per card).
 */
export interface ModelCoverAdapter {
  /** Library kinds whose attached-model 3D view can become the cover */
  kinds: ReadonlySet<string>;
  /** whether a wire stock's own construction 3D view can become its cover */
  stockViews?: boolean;
  /** this record's saved cover camera, and whether its stored image is out of date */
  saved(kind: string, id: string): Promise<{ camera: ModelCoverCamera; stale: boolean; chosen: boolean } | undefined>;
  save(kind: string, id: string, capture: ModelCoverCapture): Promise<Outcome<null>>;
}
