/** Evidence-based Library coverage. Source labels are declarations, never CAD verification. */
import type { ArtworkView } from './artwork.ts';
import { glbDocument } from './model-preview.ts';
import type { ModelLinkView } from './models.ts';

export interface AssetCoverage { model: string; explanation: string; materials: string; front: string; back: string }

export function assetCoverage(kind: string, link: ModelLinkView | null | undefined, views: readonly ArtworkView[], file?: { bytes: ArrayBuffer; mime: string }, builtIn2d = false, artworkInspected = false): AssetCoverage {
  const document = file === undefined ? undefined : glbDocument(file.bytes, file.mime);
  const asset = document?.asset as { extras?: { source?: unknown } } | undefined;
  const generated = link?.parametric !== undefined || link?.sourceKind === 'parametric' || asset?.extras?.source === 'parametric';
  const available = file !== undefined || link?.built !== false;
  const model = link === undefined ? '3D status loading' : link === null ? '3D missing' : generated ? 'Generated approximation' : available ? 'Source model' : '3D awaiting build';
  const explanation = link === null ? 'Attach a model to preview this part in 3D.' : generated ? 'Shape and finish are illustrative; check the dimensions before use.' : link === undefined ? 'Checking this part’s model link.' : 'Source and citation are supplied by the uploader or pack. Part match, dimensions and manufacturer accuracy have not been verified by WireHub.';
  const materials = file === undefined ? 'Materials not inspected' : file.mime === 'model/stl' || file.mime === 'model/x.stl' ? 'Geometry only; STL has no material data' : document === undefined ? 'Material data unknown' : Array.isArray(document.materials) && document.materials.length > 0 ? generated ? 'Illustrative materials' : 'Material data present; finish not verified' : 'No material data recorded';
  const frontName = kind === 'pcbas' ? 'Top' : 'Front';
  const backName = kind === 'pcbas' ? 'Bottom' : 'Back';
  const face = (names: string[], label: string, fallback = false): string => {
    if (!artworkInspected) return fallback ? `${label}: generated pin diagram` : `${label}: artwork not inspected`;
    const view = views.find((v) => names.includes(v.view));
    return view === undefined ? fallback ? `${label}: generated pin diagram` : `${label}: artwork missing` : `${label}: artwork available${view.derived ? ' · reflected anchors' : ''}`;
  };
  return { model, explanation, materials, front: face(kind === 'pcbas' ? ['board-top'] : ['mating-face'], frontName, builtIn2d), back: face(kind === 'pcbas' ? ['board-bottom'] : ['solder-side'], backName) };
}

/** Source assets use textual source revisions, not the hub's numbered definition snapshots. */
export function sourceRevisionModels(links: readonly ModelLinkView[], id: string, partNumber?: string): { revision: string; link: ModelLinkView }[] {
  const wanted = new Set([id, partNumber].filter((s): s is string => s !== undefined && s !== '').map((s) => s.toLowerCase()));
  const found = new Map<string, { revision: string; link: ModelLinkView }>();
  for (const link of links) {
    const [kind, part, revision, extra] = link.record.split('/');
    if (kind !== 'revisions' || part === undefined || revision === undefined || revision === '' || extra !== undefined || !wanted.has(part.toLowerCase())) continue;
    // Prefer the precise record id over its possibly shared part number.
    if (!found.has(revision) || part === id) found.set(revision, { revision, link });
  }
  return [...found.values()].sort((a, b) => a.revision.localeCompare(b.revision, undefined, { numeric: true }));
}
