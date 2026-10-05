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

import type { Outcome } from './persistence.ts';

export type ModelSourceKind = 'kicad-board' | 'resin-print' | 'vendor' | 'uploaded' | 'kicad-library';

export const MODEL_SOURCE_LABEL: Record<ModelSourceKind, string> = {
  'kicad-board': 'KiCad board',
  'resin-print': 'Resin print',
  vendor: 'Vendor model',
  uploaded: 'Uploaded',
  'kicad-library': 'KiCad library',
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
  upload(kind: string, id: string, file: { name: string; bytes: ArrayBuffer }, sourceKind: ModelSourceKind): Promise<Outcome<{ link: ModelLinkView; stats?: ModelUploadStats }>>;
  detach(kind: string, id: string): Promise<Outcome<null>>;
  /** the model's bytes and type — from the host's asset API, nowhere else */
  fetchModel(asset: string): Promise<Outcome<{ bytes: ArrayBuffer; mime: string }>>;
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
export type ViewPreset = 'iso' | 'top' | 'front' | 'side';

export const VIEW_DIRECTIONS: Record<ViewPreset, readonly [number, number, number]> = {
  iso: [1, 0.8, 1.2],
  top: [0, 1, 0.0001],
  front: [0, 0, 1],
  side: [1, 0, 0],
};
