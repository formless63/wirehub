/** Shared record-cover resolution. Physical geometry/anchors never read the cover choice. */
export interface RepresentationIdentity {
  record: string;
  revision?: string;
  build?: string;
}

export interface RepresentationCandidate {
  view: string;
  label: string;
  identity: RepresentationIdentity;
  /** Source lineage, independent of the renderer's output hash when native sources are pinned. */
  lineage: string;
  asset?: string;
  sourceKind: string;
  fidelity: string;
  limitations: string[];
  src: string;
  sources: { role: string; path: string; sha256: string }[];
  frame?: { width: number; height: number; mmPerUnit: number; origin: 'top-left'; yAxis: 'down' };
  mirrorOf?: string;
  mirrorAxis?: 'x' | 'y';
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
}

export function resolveCover(view: RepresentationView): {
  selected?: RepresentationCandidate;
  state: 'automatic' | 'chosen' | 'stale' | 'unavailable';
} {
  const available = view.candidates.filter((c) => c.asset !== undefined
    && c.identity.record === view.identity.record
    && c.identity.revision === view.identity.revision && c.identity.build === view.identity.build);
  const preferred = view.choice === null ? undefined : view.candidates.find((c) => c.view === view.choice?.view);
  const selected = preferred !== undefined && preferred.lineage === view.choice?.lineage
    ? available.find((c) => c === preferred) : undefined;
  if (selected !== undefined) return { selected, state: 'chosen' };
  const fallback = available[0];
  return {
    ...(fallback === undefined ? {} : { selected: fallback }),
    state: view.choice === null ? (fallback === undefined ? 'unavailable' : 'automatic')
      : preferred === undefined || preferred.asset === undefined ? 'unavailable' : 'stale',
  };
}
