/** Shared record-cover resolution. Physical geometry/anchors never read the cover choice. */
export interface RepresentationIdentity {
  record: string;
  revision?: string;
  build?: string;
}

/** The record kinds the one cover resolver serves: boards, wire stock, cable designs and shells. */
export const COVER_KINDS = ['pcbas', 'wires', 'designs', 'mechanicals'] as const;
export type CoverKind = (typeof COVER_KINDS)[number];
export const isCoverKind = (value: unknown): value is CoverKind => typeof value === 'string' && (COVER_KINDS as readonly string[]).includes(value);

/**
 * Client-rendered captures and the renderer version that made them. Bumping a version marks
 * older captures stale (same lineage: re-rendering keeps the explicit choice).
 */
export const COVER_CAPTURE_RENDERERS = { camera: 'three-model-viewer/1', 'saved-view': 'dom-capture/1' } as const;
export type CoverCaptureView = keyof typeof COVER_CAPTURE_RENDERERS;
export const isCoverCaptureView = (value: unknown): value is CoverCaptureView => value === 'camera' || value === 'saved-view';
/** Which capture each kind can take: a saved 3D camera on records with a model, a saved editor view on designs. */
export const CAPTURE_VIEWS_OF: Readonly<Record<CoverKind, readonly CoverCaptureView[]>> = { pcbas: ['camera'], wires: ['camera'], designs: ['saved-view'], mechanicals: ['camera'] };

/** A saved 3D camera. Presentation only: never an engineering dimension. */
export interface CoverCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

export interface RepresentationCandidate {
  view: string;
  label: string;
  identity: RepresentationIdentity;
  /** Source lineage, independent of the renderer's output hash when native sources are pinned. */
  lineage: string;
  /** Content/cache identity of the current image; absent when there is no current image. */
  asset?: string;
  /** Where the static image is served; absent means `/api/blobs/<asset>`. */
  href?: string;
  sourceKind: string;
  fidelity: string;
  limitations: string[];
  src: string;
  sources: { role: string; path: string; sha256: string }[];
  frame?: { width: number; height: number; mmPerUnit: number; origin: 'top-left'; yAxis: 'down' };
  mirrorOf?: string;
  mirrorAxis?: 'x' | 'y';
  /** Set when a stored image no longer matches its source or renderer; the candidate then has no `asset`. */
  stale?: string;
  /** A client capture's saved camera (3D) — reapplied by the viewer to refresh the same lineage. */
  camera?: CoverCamera;
}

export interface CoverChoice {
  view: string;
  lineage: string;
}

export interface RepresentationView {
  identity: RepresentationIdentity;
  candidates: RepresentationCandidate[];
  /** null means automatic. An unavailable choice is retained until explicitly changed. */
  choice: CoverChoice | null;
  /** The current source a new capture must have been made from (model asset, design version). */
  captureSources?: Partial<Record<CoverCaptureView, string>>;
}

export type CoverState = 'automatic' | 'chosen' | 'stale' | 'unavailable';

export const coverHref = (candidate: RepresentationCandidate): string | undefined =>
  candidate.asset === undefined ? undefined : candidate.href ?? `/api/blobs/${candidate.asset}`;

export function resolveCover(view: RepresentationView): {
  selected?: RepresentationCandidate;
  state: CoverState;
} {
  const available = view.candidates.filter((c) => c.asset !== undefined
    && c.identity.record === view.identity.record
    && c.identity.revision === view.identity.revision && c.identity.build === view.identity.build);
  const preferred = view.choice === null ? undefined : view.candidates.find((c) => c.view === view.choice?.view);
  const selected = preferred !== undefined && preferred.lineage === view.choice?.lineage
    ? available.find((c) => c === preferred) : undefined;
  if (selected !== undefined) return { selected, state: 'chosen' };
  // Automatic never picks a capture by itself: those are explicit choices.
  const fallback = available.find((c) => c.sourceKind !== 'capture');
  const changed = preferred !== undefined && (preferred.stale !== undefined
    || (preferred.asset !== undefined && preferred.lineage !== view.choice?.lineage));
  return {
    ...(fallback === undefined ? {} : { selected: fallback }),
    state: view.choice === null ? (fallback === undefined ? 'unavailable' : 'automatic')
      : changed ? 'stale' : 'unavailable',
  };
}
